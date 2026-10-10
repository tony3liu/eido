// Adapted for Eido from @automatalabs/pi-acp 0.9.4 (Apache-2.0). See ../LICENSE.
import {randomUUID} from "node:crypto";
import {resolve} from "node:path";
import {homedir} from "node:os";
import {appendEidoEntry} from "./session-persistence.js";
import {TURN_RECORD, savedTurnState, terminalTurnStatus} from "./turn-state.js";
import { methods, } from "@agentclientprotocol/sdk";
import { adapterError, classifyPreflight, isRequestError, unexpectedError } from "./errors.js";
import { applyConfig, modelDiscoveryPreferences, modelOption, thinkingLevelOption, } from "./config.js";
import { shutdownPiSession } from "./pi-shutdown.js";
import { convertPromptContent } from "./prompt-content.js";
import { replayEntry } from "./replay.js";
import { stopReasonFor } from "./stop-reason.js";
import { translateEvent, toolDurationMeta } from "./translate.js";
import { agentMessages, promptUsage, terminalAssistant, usageUpdate, } from "./usage.js";
import { installPermissionWrapper } from "./permissions.js";
import { ChildCleanupFailure } from "./child-process-registry.js";
import { LOADED_TURN_ENDED_METHOD, } from "./loaded-turn.js";
export class PiSession {
    sessionId;
    pi;
    manager;
    client;
    deps;
    mcpBridge;
    failedMcpResults;
    availableModels;
    settingsManager;
    modelPreferences;
    childRegistry;
    lifecycleController;
    onWedged;
    pending = [];
    pump;
    pumpFailure;
    stopped = false;
    closing = false;
    disposed = false;
    unsubscribe;
    activeTurn;
    steerChain = Promise.resolve();
    configReserved = false;
    cleanupDirty = false;
    cleanupGeneration;
    resourceDisposePromise;
    bridgeClosePromise;
    /** The `_session/loaded_turn` extension's watch flag: set when a
     *  `loadedTurnStatus()` query answered `running` (a client is waiting
     *  for that turn's authoritative end), cleared — and the
     *  `_session/loaded_turn/ended` notification sent — when the turn
     *  finishes for any reason (response outcome with its stop reason, or
     *  a failure with its error). */
    loadedTurnReportedRunning = false;
    constructor(options) {
        this.sessionId = options.sessionId;
        this.cwd = options.cwd;
        this.pi = options.session;
        this.manager = options.manager;
        this.client = options.client;
        this.deps = options.deps;
        this.mcpBridge = options.mcpBridge;
        this.failedMcpResults = options.failedMcpResults;
        this.availableModels = options.availableModels;
        this.settingsManager = options.settingsManager;
        this.childRegistry = options.childRegistry;
        this.lifecycleController = options.lifecycleController;
        this.onWedged = options.onWedged;
        installPermissionWrapper(this.pi, {
            sessionId: this.sessionId,
            client: this.client,
            drain: () => this.drain(),
            turnSignal: () => this.activeTurn?.controller.signal,
        });
        const innerAfterToolCall = this.pi.agent.afterToolCall;
        this.pi.agent.afterToolCall = async (context, signal) => {
            const innerResult = innerAfterToolCall ? await innerAfterToolCall(context, signal) : undefined;
            const failedResult = this.failedMcpResults.get(context.toolCall.id);
            if (!failedResult)
                return innerResult;
            return {
                ...innerResult,
                content: failedResult.content,
                ...(failedResult.structuredContent === undefined ? {} : { structuredContent: failedResult.structuredContent }),
                ...(failedResult.details === undefined ? {} : { details: failedResult.details }),
                isError: true,
            };
        };
        this.unsubscribe = this.pi.subscribe((event) => {
            // Pi may abort from an extension without an ACP cancel request. Retain
            // evidence on this turn, but settle only after prompt and cleanup finish.
            if (event.type === "agent_settled" && event.aborted && this.activeTurn?.diagnosticOpen)
                this.activeTurn.piAborted = true;
            if (event.type === "tool_execution_end" && event.parentToolCallId && toolDurationMeta(event.durationMs))
                appendEidoEntry(this.manager, "eido.tool-duration.v1", {toolCallId:event.toolCallId,durationMs:event.durationMs});
            const failedResult = event.type === "tool_execution_end" && event.isError
                ? this.failedMcpResults.get(event.toolCallId)
                : undefined;
            if (event.type === "tool_execution_end")
                this.failedMcpResults.delete(event.toolCallId);
            for (const update of translateEvent(event, failedResult))
                this.enqueue(update);
        });
    }
    get busy() {
        return this.activeTurn !== undefined || this.configReserved || this.closing;
    }
    turnState() {
        const turn = this.activeTurn;
        return turn && !turn.completed ? {version: 1, id: turn.eidoId, status: "running"}
            : savedTurnState(this.manager.getBranch());
    }
    loadedTurnStatus() {
        const state = this.turnState();
        if (state.status === "running") this.loadedTurnReportedRunning = true;
        return state.status === "running" ? "running" : state.status === "completed" ? "completed" : "interrupted";
    }
    publishTurnState(state = this.turnState()) {
        this.enqueue({sessionUpdate: "session_info_update", _meta: {eidoTurn: state}});
    }
    configOptions() {
        return [thinkingLevelOption(this.pi), modelOption(this.pi, this.availableModels, this.modelPreferences)];
    }
    async publishAvailableModels(models) {
        const availableModels = [...models];
        const preferences = await modelDiscoveryPreferences(this.settingsManager.getEnabledModels(), availableModels);
        this.availableModels = availableModels;
        this.modelPreferences = preferences;
    }
    activeTurnSignal() { return this.activeTurn?.controller.signal; }
    reportCommandError(error) {
        if (this.activeTurn && !this.activeTurn.completed) this.activeTurn.commandError = error;
    }
    emitMcpDiagnostic(text) {
        if (this.disposed)
            return;
        if (this.activeTurn && !this.activeTurn.completed && this.activeTurn.diagnosticOpen) {
            this.enqueue({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
        }
        else {
            console.error(text);
        }
    }
    enqueue(update) {
        if (this.stopped)
            return;
        // ACP file locations are absolute. Pi tools also accept paths relative
        // to the session directory; normalize live and replayed notifications.
        if (Array.isArray(update.locations)) {
            update = {...update, locations: update.locations.map(location => ({
                ...location,
                path: resolve(this.cwd, location.path.startsWith("~/")
                    ? resolve(homedir(), location.path.slice(2)) : location.path),
            }))};
        }
        this.pending.push(update);
        if (!this.pump)
            this.startPump();
    }
    startPump() {
        this.pump = (async () => {
            while (!this.stopped && this.pending.length > 0) {
                const update = this.pending.shift();
                if (!update)
                    continue;
                await this.client.notify(methods.client.session.update, {
                    sessionId: this.sessionId,
                    update,
                });
            }
        })()
            .catch((error) => {
            this.pumpFailure = error;
            this.stopped = true;
            this.pending.length = 0;
            this.notificationFailure();
            throw error;
        })
            .finally(() => {
            this.pump = undefined;
        });
        this.pump.catch(() => undefined);
    }
    async drain() {
        if (this.pumpFailure !== undefined)
            throw this.pumpFailure;
        while (this.pump)
            await this.pump;
        if (this.pumpFailure !== undefined)
            throw this.pumpFailure;
    }
    historyUpdates(entries) {
        const snapshots = new Map(this.pi.sessionManager.getEntries()
            .filter(entry => entry.type === 'custom' && entry.customType === 'eido.prompt.v1'
                && typeof entry.data?.messageId === 'string' && Array.isArray(entry.data?.prompt))
            .map(entry => [entry.data.messageId, entry.data.prompt]));
        const durations = new Map(this.pi.sessionManager.getEntries()
            .filter(entry => entry.type === 'custom' && entry.customType === 'eido.tool-duration.v1'
                && typeof entry.data?.toolCallId === 'string' && toolDurationMeta(entry.data?.durationMs))
            .map(entry => [entry.data.toolCallId, entry.data.durationMs]));
        return entries.flatMap(entry => {
            const prompt = entry.type === 'message' && entry.message.role === 'user' ? snapshots.get(entry.id) : undefined;
            return prompt ? prompt.map(content => ({sessionUpdate:'user_message_chunk',messageId:entry.id,content:structuredClone(content)})) : replayEntry(entry).map(update => {
                if (update.sessionUpdate !== 'tool_call_update' || !durations.has(update.toolCallId)) return update;
                return {...update, _meta:{...update._meta,...toolDurationMeta(durations.get(update.toolCallId))}};
            });
        });
    }
    async replay(entries) {
        for (const update of this.historyUpdates(entries)) this.enqueue(update);
        this.publishTurnState();
        try {
            await this.drain();
        }
        catch {
            throw adapterError("notification_error");
        }
    }
    async setConfig(configId, value) {
        if (this.busy)
            throw adapterError("session_busy");
        // Reserve synchronously before the corrective catalog refresh.  Prompt,
        // config, fork, and refresh commit all share the same admission boundary.
        this.configReserved = true;
        let release;
        try {
            release = await this.mcpBridge.acquireTurnBoundary();
            if (this.closing)
                throw adapterError("session_busy");
            return await this.applyConfigAtBoundary(configId, value);
        }
        finally {
            release?.();
            this.configReserved = false;
        }
    }
    async applyConfigAtBoundary(configId, value) {
        const result = await applyConfig(this.pi, this.deps.modelRuntime, this.availableModels, configId, value, this.settingsManager.getEnabledModels());
        this.availableModels = result.availableModels;
        this.modelPreferences = result.preferences;
        return result.configOptions;
    }
    finish(turn, outcome) {
        if (turn.completed)
            return;
        const state = {version: 1, id: turn.eidoId, status: terminalTurnStatus(outcome)};
        try {
            appendEidoEntry(this.manager, TURN_RECORD, state);
        } catch (error) {
            // A result that cannot be retained is not a recoverable success.
            outcome = {error: unexpectedError(error)};
            state.status = "failed";
        }
        this.publishTurnState(state);
        turn.diagnosticOpen = false;
        turn.completed = true;
        turn.removeRequestAbort?.();
        turn.removeRequestAbort = undefined;
        if ("response" in outcome)
            turn.resolve(outcome.response);
        else
            turn.reject(outcome.error);
        turn.resolveSettlement();
        turn.releaseBoundary?.();
        turn.releaseBoundary = undefined;
        if (this.activeTurn === turn) {
            this.activeTurn = undefined;
            this.pi[Symbol.for("eido.pi.delivery")]?.turnEnded();
        }
        // The `_session/loaded_turn` extension's authoritative end push: a
        // client that was told this turn was `running` at query time gets the
        // ended notification now — with the turn's stop reason (response
        // outcome) or its error (failure), never both. Best-effort: a
        // failing notification must not break the turn's settlement. The
        // push is ORDERED behind the turn's final update pump (review round
        // 6): the last deltas were only enqueued (the pump delivers them
        // asynchronously), and the re-attach seam settles with the
        // accumulated text at the terminal marker — a marker delivered
        // before the final chunk would durably settle PARTIAL text.
        if (this.loadedTurnReportedRunning) {
            this.loadedTurnReportedRunning = false;
            const notification = "response" in outcome
                ? { sessionId: this.sessionId, stopReason: outcome.response.stopReason }
                : { sessionId: this.sessionId, error: normalizeTurnError(outcome.error) };
            void this.drain()
                .catch(() => undefined)
                .then(() => this.client.notify(LOADED_TURN_ENDED_METHOD, notification))
                .catch(() => undefined);
        }
        const generation = this.cleanupGeneration;
        if (generation?.resumeRefreshesOnSettlement && generation.mode === "cancel-only") {
            this.cleanupGeneration = undefined;
            this.mcpBridge.resumeRefreshes();
        }
    }
    notificationFailure() {
        const turn = this.activeTurn;
        if (!turn || turn.completed)
            return;
        turn.notificationFailed = true;
        this.abortTurn(turn);
        void turn.cleanup?.then(() => this.finish(turn, { error: adapterError("notification_error") }), (error) => this.finish(turn, { error }));
    }
    abortTurn(turn) {
        if (turn.completed)
            return;
        turn.cleanup ??= this.cleanupTurn("cancel-only");
        turn.cleanup.catch((error) => {
            if (!turn.completed)
                this.turnError(turn, error);
            void this.cleanupWedged();
        });
    }
    startDisposal() {
        this.closing = true;
        // The contract's disposal prefix is intentionally split: transport close
        // admission starts first, then incoming handlers observe session disposal,
        // and only then are refresh/turn signals aborted.
        this.mcpBridge.startDisposal();
        if (!this.lifecycleController.signal.aborted) {
            this.lifecycleController.abort(new Error("session disposed"));
        }
        this.mcpBridge.abortRefreshes();
        this.bridgeClosePromise ??= this.mcpBridge.close();
        this.bridgeClosePromise.catch(() => undefined);
    }
    cleanupTurn(mode) {
        const current = this.cleanupGeneration;
        if (current?.status === "pending") {
            if (mode === "disposal" && current.mode === "cancel-only") {
                current.mode = "disposal";
                this.startDisposal();
            }
            return current.promise;
        }
        if (current?.status === "succeeded" && current.mode === "disposal") {
            return current.promise;
        }
        const deadlineController = new AbortController();
        const timerController = new AbortController();
        const generation = {
            mode,
            status: "pending",
            promise: Promise.resolve(),
            deadlineController,
            timerController,
        };
        this.cleanupGeneration = generation;
        const expiry = this.deps.sleep(this.deps.graceMs, timerController.signal).then(() => {
            const failure = new ChildCleanupFailure(this.childRegistry.remainingChildren);
            deadlineController.abort(failure);
            throw failure;
        });
        expiry.catch(() => undefined);
        // Closing the captured epoch is the synchronous admission barrier.  It
        // must precede Pi abort, because abort can yield while a bash spawn is
        // between its filesystem check and lease acquisition.
        const captured = this.childRegistry.closeEpoch(deadlineController.signal);
        captured.drain.catch(() => undefined);
        if (mode === "disposal")
            this.startDisposal();
        else
            this.mcpBridge.abortRefreshes();
        const turn = this.activeTurn;
        if (turn && !turn.controller.signal.aborted)
            turn.controller.abort();
        let clearQueuePi = Promise.resolve();
        try {
            this.pi.clearQueue();
        }
        catch (error) {
            clearQueuePi = Promise.reject(error);
        }
        clearQueuePi.catch(() => undefined);
        let abortPi;
        try {
            abortPi = this.pi.abort();
        }
        catch (error) {
            abortPi = Promise.reject(error);
        }
        abortPi.catch(() => undefined);
        // Keep the established abort-before-child-drain failure precedence. Queue
        // clearing is invoked first, but its failure is considered only after both
        // pre-existing cleanup operations.
        const operations = Promise.allSettled([abortPi, captured.drain, clearQueuePi]);
        generation.promise = new Promise((resolve, reject) => {
            let claimed = false;
            const fail = (error) => {
                if (claimed)
                    return;
                claimed = true;
                generation.status = "failed";
                this.cleanupDirty = true;
                generation.mode = "disposal";
                this.startDisposal();
                const remaining = error instanceof ChildCleanupFailure
                    ? error.remainingChildren
                    : this.childRegistry.remainingChildren;
                generation.error = adapterError("child_cleanup_error", { details: { remainingChildren: remaining } });
                timerController.abort();
                reject(generation.error);
            };
            expiry.then(() => undefined, (error) => {
                if (timerController.signal.aborted && !deadlineController.signal.aborted)
                    return;
                fail(error);
            });
            operations.then((results) => {
                if (claimed)
                    return;
                const failure = results.find((result) => result.status === "rejected");
                if (failure) {
                    fail(failure.reason);
                    return;
                }
                claimed = true;
                generation.status = "succeeded";
                this.cleanupDirty = false;
                timerController.abort();
                if (generation.mode === "cancel-only" && this.cleanupGeneration === generation) {
                    this.childRegistry.commitRotation(captured.epoch);
                    if (turn?.completed) {
                        this.cleanupGeneration = undefined;
                        this.mcpBridge.resumeRefreshes();
                    }
                    else {
                        generation.resumeRefreshesOnSettlement = true;
                    }
                }
                resolve();
            });
        });
        generation.promise.catch(() => undefined);
        return generation.promise;
    }
    turnError(turn, error) {
        if (turn.completed || turn.errorSettlementStarted)
            return;
        turn.errorSettlementStarted = true;
        turn.diagnosticOpen = false;
        let terminal;
        try {
            terminal = terminalAssistant(agentMessages(this.pi).slice(turn.startMessageIndex));
        }
        catch {
            terminal = undefined;
        }
        const mapped = isRequestError(error) ? error : unexpectedError(error, terminal);
        void this.drain().then(() => this.finish(turn, { error: mapped }), () => this.notificationFailure());
    }
    runTurnTask(turn, task) {
        void task.catch((error) => {
            if (turn.completed)
                console.error("pi-acp detached turn error:", error);
            else
                this.turnError(turn, error);
        });
    }
    async cleanupWedged() {
        try {
            await this.onWedged(this.sessionId, this, true);
        }
        catch (error) {
            console.error("pi-acp wedged-session cleanup error:", error);
        }
    }
    async handlePiResolved(turn) {
        if (turn.completed)
            return;
        try {
            if (this.childRegistry.childCleanupFailed)
                turn.cleanup = this.cleanupTurn("disposal");
            else if (turn.piAborted)
                turn.cleanup ??= this.cleanupTurn("cancel-only");
            const messages = agentMessages(this.pi).slice(turn.startMessageIndex);
            if (turn.cleanup)
                await turn.cleanup;
            turn.diagnosticOpen = false;
            this.enqueue(usageUpdate(this.pi));
            await this.drain();
            if (turn.completed)
                return;
            if (turn.commandError) throw adapterError("command_error");
            const terminal = terminalAssistant(messages);
            const stopReason = stopReasonFor(terminal, turn.controller.signal.aborted || turn.piAborted);
            this.discardOrphanedSteering();
            this.finish(turn, { response: { stopReason, usage: promptUsage(messages) } });
        }
        catch (error) {
            if (this.pumpFailure !== undefined)
                this.notificationFailure();
            else
                this.turnError(turn, error);
        }
    }
    async handlePiRejected(turn, error) {
        if (turn.completed)
            return;
        if (!turn.controller.signal.aborted && !turn.piAborted) {
            turn.diagnosticOpen = false;
            try {
                await this.drain();
                this.discardOrphanedSteering();
                this.finish(turn, { error: turn.commandError ? adapterError("command_error") : classifyPreflight(error) });
            }
            catch {
                this.notificationFailure();
            }
            return;
        }
        try {
            if (turn.piAborted)
                turn.cleanup ??= this.cleanupTurn("cancel-only");
            if (turn.cleanup)
                await turn.cleanup;
            const messages = agentMessages(this.pi).slice(turn.startMessageIndex);
            turn.diagnosticOpen = false;
            this.enqueue(usageUpdate(this.pi));
            await this.drain();
            this.finish(turn, { response: { stopReason: "cancelled", usage: promptUsage(messages) } });
        }
        catch (settlementError) {
            if (this.pumpFailure !== undefined)
                this.notificationFailure();
            else
                this.turnError(turn, settlementError);
        }
    }
    async prompt(params, requestSignal) {
        if (this.busy)
            throw adapterError("session_busy");
        return this.startTurn(convertPromptContent(params.prompt), { requestSignal });
    }
    /** Open the session's single turn slot and run one pi prompt through the full turn
     *  machinery (turn boundary, cancellation, settlement, usage). Admission is the caller's
     *  job: prompt() rejects while busy. Steering never calls this method. */
    startTurn(converted, opts) {
        const text = converted.text;
        let startMessageIndex;
        try {
            startMessageIndex = agentMessages(this.pi).length;
        }
        catch (error) {
            throw unexpectedError(error);
        }
        let resolve;
        let reject;
        const result = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        let resolveSettlement;
        const settlement = new Promise((res) => {
            resolveSettlement = res;
        });
        const eidoId = randomUUID();
        appendEidoEntry(this.manager, TURN_RECORD, {version: 1, id: eidoId, status: "running"});
        const turn = {
            eidoId,
            controller: new AbortController(),
            settlement,
            resolveSettlement,
            completed: false,
            diagnosticOpen: true,
            errorSettlementStarted: false,
            notificationFailed: false,
            resolve,
            reject,
            startMessageIndex,
        };
        this.activeTurn = turn;
        this.publishTurnState();
        const requestSignal = opts.requestSignal;
        if (requestSignal) {
            const abortFromRequest = () => this.abortTurn(turn);
            if (requestSignal.aborted)
                abortFromRequest();
            else {
                requestSignal.addEventListener("abort", abortFromRequest, { once: true });
                turn.removeRequestAbort = () => requestSignal.removeEventListener("abort", abortFromRequest);
            }
        }
        this.runTurnTask(turn, (async () => {
            turn.releaseBoundary = await this.mcpBridge.acquireTurnBoundary();
            if (turn.controller.signal.aborted) {
                try {
                    if (turn.cleanup)
                        await turn.cleanup;
                    turn.diagnosticOpen = false;
                    this.enqueue(usageUpdate(this.pi));
                    await this.drain();
                    this.finish(turn, {
                        response: {
                            stopReason: "cancelled",
                            usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, totalTokens: 0 },
                        },
                    });
                }
                catch (error) {
                    this.turnError(turn, error);
                }
                return;
            }
            let piPromise;
            try {
                piPromise = (async () => {
                    const commands = this.pi[Symbol.for("eido.pi.commands")];
                    if (commands && await commands.run(text, converted.images, this)) { await this.pi[Symbol.for("eido.pi.ui.state")]?.flush(); return; }
                    const result = await this.pi.prompt(text, { images: converted.images });
                    await this.pi[Symbol.for("eido.pi.ui.state")]?.flush();
                    return result;
                })();
            }
            catch (error) {
                await this.handlePiRejected(turn, error);
                return;
            }
            await piPromise.then(() => this.handlePiResolved(turn), (error) => this.handlePiRejected(turn, error));
        })());
        return result;
    }
    /** `_session/steering`: inject only into the live turn. Requests are serialized per
     *  session so concurrent steering calls cannot cross a turn boundary. */
    async steer(params) {
        const run = this.steerChain.then(() => this.performSteer(params));
        this.steerChain = run.then(() => undefined, () => undefined);
        return run;
    }
    async performSteer(params) {
        if (this.closing || this.disposed)
            throw adapterError("session_terminated");
        const turn = this.activeTurn;
        if (!turn || turn.completed || turn.controller.signal.aborted) {
            return { outcome: "promptRequired", reason: "noRunningTurn" };
        }
        const converted = convertPromptContent(params.prompt);
        // A committed-but-not-yet-streaming turn is steerable too: pi's run loop polls the
        // steering queue before its first LLM call, so the message joins the imminent turn.
        try {
            await this.pi.steer(converted.text, converted.images);
        }
        catch (error) {
            if (this.activeTurn !== turn || turn.completed || turn.controller.signal.aborted) {
                this.discardOrphanedSteering();
            }
            throw error;
        }
        if (this.activeTurn === turn && !turn.completed && !turn.controller.signal.aborted) {
            return { outcome: "injected" };
        }
        // The run settled (or cancellation won) underneath the native enqueue. Pi only polls
        // this queue from an active run, so leaving any residue would prepend hidden input to a
        // later session/prompt. Remove it and require the caller to issue an explicit prompt.
        this.discardOrphanedSteering();
        return { outcome: "promptRequired", reason: "noRunningTurn" };
    }
    /** Remove native Pi queue residue at a turn boundary. Nothing left by steering may be
     *  consumed by a later public prompt. Unexpected cleanup failures stay exceptional. */
    discardOrphanedSteering() {
        if (this.pi.pendingMessageCount > 0)
            this.pi.clearQueue();
    }
    cancel() {
        if (this.activeTurn)
            this.abortTurn(this.activeTurn);
    }
    childCleanupFailure() {
        const turn = this.activeTurn;
        if (turn && !turn.completed) {
            this.abortTurn(turn);
            return;
        }
        void this.cleanupWedged();
    }
    async dispose() {
        if (this.disposed && !this.cleanupDirty && this.childRegistry.remainingChildren === 0 && !this.childRegistry.childCleanupFailed)
            return;
        const cleanup = this.cleanupTurn("disposal");
        const turn = this.activeTurn;
        let cleanupError;
        if (turn) {
            this.abortTurn(turn);
            await turn.settlement;
            try {
                await cleanup;
            }
            catch (error) {
                cleanupError = error;
            }
        }
        else {
            try {
                await cleanup;
            }
            catch (error) {
                cleanupError = error;
            }
        }
        await this.disposeResources();
        if (cleanupError)
            throw cleanupError;
    }
    async disposeAfterCleanupFailure() {
        this.startDisposal();
        await this.disposeResources();
    }
    get remainingChildren() { return this.childRegistry.remainingChildren; }
    get cleanupRetryRequired() {
        return this.cleanupDirty || this.childRegistry.remainingChildren > 0 || this.childRegistry.childCleanupFailed;
    }
    async disposeResources() {
        this.resourceDisposePromise ??= (async () => {
            if (this.disposed)
                return;
            this.closing = true;
            this.disposed = true;
            this.stopped = true;
            this.pending.length = 0;
            this.failedMcpResults.clear();
            try {
                this.unsubscribe?.();
            }
            catch (error) {
                console.error("pi-acp unsubscribe error:", error);
            }
            this.unsubscribe = undefined;
            this.startDisposal();
            await this.mcpBridge.drainRefreshes().catch((error) => {
                console.error("pi-acp MCP refresh drain error:", error);
            });
            const results = await Promise.allSettled([
                shutdownPiSession(this.pi),
                this.bridgeClosePromise ?? Promise.resolve(),
            ]);
            if (results[0]?.status === "rejected") {
                console.error("pi-acp session dispose error:", results[0].reason);
            }
            if (results[1]?.status === "rejected") {
                console.error("pi-acp MCP disposal error:", results[1].reason);
            }
        })();
        return this.resourceDisposePromise;
    }
    poison() {
        if (this.closing || this.disposed)
            return;
        this.closing = true;
        void this.onWedged(this.sessionId, this, false).catch((error) => {
            console.error("pi-acp poisoned-session cleanup error:", error);
        });
    }
}
/** Normalize a turn's failure into the loaded-turn ended notification's
 *  `{ name, message }` error shape (best-effort — the notification
 *  carries the turn's error verbatim-ish, never the whole stack). */
function normalizeTurnError(error) {
    if (error !== null && typeof error === "object") {
        const candidate = error;
        return {
            name: typeof candidate.name === "string" ? candidate.name : "Error",
            message: typeof candidate.message === "string"
                ? candidate.message
                : String(candidate.message ?? error),
        };
    }
    return { name: "Error", message: String(error) };
}
