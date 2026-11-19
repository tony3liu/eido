// Adapted for Eido from @automatalabs/pi-acp 0.9.4 (Apache-2.0). See ../LICENSE.
import {randomUUID} from "node:crypto";
import {resolve} from "node:path";
import {homedir} from "node:os";
import {appendEidoEntry, persistSession} from "./session-persistence.js";
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
import { LOADED_TURN_ENDED_METHOD, } from "./loaded-turn.js";
const FINISH_TOOL_RESOURCES = Symbol.for("eido.pi.finish-tool-resources");

export function cleanupDeadline(deps, work, timeoutMs, onTimeout) {
    const timer = new AbortController();
    const expiry = deps.sleep(timeoutMs, timer.signal).then(() => { throw onTimeout(); });
    return Promise.race([work, expiry]).finally(() => timer.abort());
}
function turnCleanupError(phase, reason) {
    return adapterError("turn_cleanup_error", { details: { phase, reason } });
}
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
    cleanupGeneration;
    pendingChildDrain;
    resourceDisposePromise;
    bridgeClosePromise;
    piStop;
    toolCleanup = {};
    execution;
    disposePromise;
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
        if (turn.observingCleanup) return;
        turn.observingCleanup = true;
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
    waitForCleanup(work, phase) {
        return cleanupDeadline(this.deps, work.catch(() => {
            throw turnCleanupError(phase, "failed");
        }), this.deps.turnCleanupTimeoutMs ?? 15_000, () => turnCleanupError(phase, "timeout"));
    }
    captureChildDrain(signal) {
        const capture = () => {
            const { epoch, drain } = this.childRegistry.closeEpoch(signal);
            this.pendingChildDrain = drain;
            const clear = () => { if (this.pendingChildDrain === drain) this.pendingChildDrain = undefined; };
            drain.then(clear, clear);
            return drain.then(() => epoch);
        };
        // A deadline may reject before the registry observes its aborted
        // signal. Retry only after the previous drain has actually settled.
        return this.pendingChildDrain
            ? this.pendingChildDrain.catch(() => undefined).then(() => {
                signal.throwIfAborted();
                return capture();
            })
            : capture();
    }
    finishToolResources(mode) {
        const finish = this.pi[FINISH_TOOL_RESOURCES];
        if (!finish) return Promise.resolve();
        const state = this.toolCleanup;
        const request = (key, phase, after = Promise.resolve()) => {
            if (state[key]) return state[key];
            const operation = after.then(() => finish(phase));
            state[key] = operation;
            operation.catch(() => {
                if (state[key] === operation) state[key] = undefined;
            });
            return operation;
        };
        if (mode === "normal" || state.cancel) return state.cancel ?? request("normal", "normal");
        if (state.normal) {
            // Keep the ordinary close result, and only add the static preview
            // omitted by a successful normal cleanup. Retry failures on recovery.
            return request("cancel", "stop-static", state.normal);
        }
        return request("cancel", "cancel");
    }
    cleanupTurn(mode) {
        const current = this.cleanupGeneration;
        if (current?.status === "pending") {
            if (mode === "disposal") {
                current.mode = "disposal";
                this.closing = true;
            }
            return current.promise;
        }
        if (current?.status === "succeeded" && current.mode === "disposal") {
            return current.promise;
        }
        const generation = { mode, status: "pending" };
        this.cleanupGeneration = generation;
        const deadline = new AbortController();
        // Close the spawn epoch before asking pi to abort. Even a zero-sized
        // registry may still have a spawn lease to settle.
        const drain = this.captureChildDrain(deadline.signal);
        const childFailure = () => adapterError("child_cleanup_error", {
            details: { remainingChildren: this.childRegistry.remainingChildren },
        });
        const childDrain = cleanupDeadline(this.deps, drain.catch(() => {
            throw childFailure();
        }), this.deps.graceMs, () => {
            const error = childFailure();
            deadline.abort(error);
            return error;
        });
        if (mode === "disposal") this.closing = true;
        this.mcpBridge.abortRefreshes();
        const turn = this.activeTurn;
        if (turn && !turn.controller.signal.aborted) turn.controller.abort();

        // Share the actual stop, including one that settles after its deadline.
        // Retrying recovery may wait for it again but cannot run an overlapping abort.
        if (!this.piStop) {
            let queueError;
            try { this.pi.clearQueue(); }
            catch { queueError = turnCleanupError("queue", "failed"); }
            const stop = Promise.resolve().then(() => this.pi.abort()).then(async () => {
                await this.execution;
                await this.pi.waitForIdle?.();
            });
            this.piStop = stop.then(() => {
                if (queueError) throw queueError;
            }, () => { throw turnCleanupError("pi", "failed"); });
            const attempt = this.piStop;
            attempt.catch(() => { if (this.piStop === attempt) this.piStop = undefined; });
        }
        // On a child-drain failure retain this stop and never run tool cleanup
        // concurrently with admitted work, even if the caller retries later.
        const toolCleanup = cleanupDeadline(this.deps, this.piStop, this.deps.turnCleanupTimeoutMs ?? 15_000,
            () => turnCleanupError("pi", "timeout")).then(() =>
            this.waitForCleanup(this.finishToolResources("cancel"), "resources"));
        generation.promise = Promise.all([childDrain, toolCleanup])
            .then(([epoch]) => {
                generation.status = "succeeded";
                if (generation.mode === "cancel-only" && this.cleanupGeneration === generation) {
                    this.childRegistry.commitRotation(epoch);
                    if (!turn || turn.completed) {
                        this.cleanupGeneration = undefined;
                        this.mcpBridge.resumeRefreshes();
                    } else {
                        generation.resumeRefreshesOnSettlement = true;
                    }
                }
            }, (error) => {
                generation.status = "failed";
                this.closing = true;
                generation.mode = "disposal";
                throw error;
            });
        generation.promise.catch(() => undefined);
        return generation.promise;
    }
    async closeTurnResources(turn) {
        if (turn.cleanup) return turn.cleanup;
        try {
            await this.waitForCleanup(this.finishToolResources("normal"), "resources");
        } catch (error) {
            if (turn.cleanup) return turn.cleanup;
            this.closing = true;
            void this.cleanupWedged();
            throw error;
        }
        // A cancel may arrive while normal tool cleanup or notification
        // draining is in progress. Settlement still waits for its barrier.
        if (turn.cleanup) await turn.cleanup;
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
            await this.onWedged(this.sessionId, this);
        }
        catch (error) {
            console.error("pi-acp wedged-session cleanup error:", error);
        }
    }
    async handlePiResolved(turn) {
        if (turn.completed)
            return;
        try {
            if (this.childRegistry.childCleanupFailed) {
                turn.cleanup = this.cleanupTurn("disposal");
                this.abortTurn(turn);
            } else if (turn.piAborted) {
                this.abortTurn(turn);
            }
            const messages = agentMessages(this.pi).slice(turn.startMessageIndex);
            await this.closeTurnResources(turn);
            turn.diagnosticOpen = false;
            this.enqueue(usageUpdate(this.pi));
            await this.drain();
            if (turn.cleanup) await turn.cleanup;
            if (turn.completed)
                return;
            if (turn.commandError && !turn.controller.signal.aborted) throw adapterError("command_error");
            if (turn.imageTurn) {
                this.discardOrphanedSteering();
                this.finish(turn, {response:{stopReason:turn.controller.signal.aborted ? "cancelled" : "end_turn"}});
                return;
            }
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
        if (turn.completed) return;
        try {
            if (turn.piAborted) this.abortTurn(turn);
            await this.closeTurnResources(turn);
            turn.diagnosticOpen = false;
            if (turn.controller.signal.aborted)
                this.enqueue(usageUpdate(this.pi));
            await this.drain();
            if (turn.cleanup) await turn.cleanup;
            if (turn.controller.signal.aborted) {
                const messages = agentMessages(this.pi).slice(turn.startMessageIndex);
                this.finish(turn, { response: { stopReason: "cancelled", usage: promptUsage(messages) } });
            } else {
                this.discardOrphanedSteering();
                this.finish(turn, { error: turn.commandError ? adapterError("command_error") : isRequestError(error) ? error : classifyPreflight(error) });
            }
        } catch (settlementError) {
            if (this.pumpFailure !== undefined)
                this.notificationFailure();
            else
                this.turnError(turn, settlementError);
        }
    }
    async prompt(params, requestSignal) {
        if (this.busy)
            throw adapterError("session_busy");
        if (this.deps.eidoImages?.supports(this.pi.model)
            && (params._meta?.eidoHasAttachments || params.prompt.some(block => block.type !== "text")))
            throw adapterError("provider_error", {details:"Image generation accepts a text description only. Remove attachments before sending."});
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
            imageTurn: !text.trimStart().startsWith("/") && !!this.deps.eidoImages?.supports(this.pi.model),
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
        this.toolCleanup = {};
        this.piStop = undefined;
        this.execution = undefined;
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
            const release = await this.mcpBridge.acquireTurnBoundary();
            if (turn.completed) {
                release();
                return;
            }
            turn.releaseBoundary = release;
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
            const piPromise = Promise.resolve().then(async () => {
                turn.controller.signal.throwIfAborted();
                const commands = this.pi[Symbol.for("eido.pi.commands")];
                if (commands && await commands.run(text, converted.images, this)) { await this.pi[Symbol.for("eido.pi.ui.state")]?.flush(); return; }
                if (turn.imageTurn) {
                    appendEidoEntry(this.manager, "eido.image.input.v1", {text});
                    const image = await this.deps.eidoImages.runDirect(this.pi, {
                        text, images: converted.images, signal: turn.controller.signal, operationId: turn.eidoId,
                    });
                    if (!image) throw adapterError("invalid_model");
                    if (!turn.controller.signal.aborted) {
                        this.manager.appendCustomMessageEntry("eido.image.result.v1", image.content, true, {path:image.path});
                        persistSession(this.manager);
                        for (const content of image.content) this.enqueue({sessionUpdate:"agent_message_chunk",content});
                    }
                    return;
                }
                const result = await this.pi.prompt(text, { images: converted.images });
                await this.pi[Symbol.for("eido.pi.ui.state")]?.flush();
                return result;
            });
            // Track the actual host command/prompt, not its settlement handler,
            // which in turn needs to await cancellation cleanup.
            this.execution = piPromise.then(() => undefined, () => undefined);
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
        if (turn.imageTurn) throw adapterError("session_busy", {details:"Image generation is in progress. Wait or cancel before sending another message."});
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
    dispose() {
        if (this.disposePromise) return this.disposePromise;
        const operation = this.disposeGeneration();
        this.disposePromise = operation;
        operation.catch(() => {
            if (this.disposePromise === operation) this.disposePromise = undefined;
        });
        return operation;
    }
    async disposeGeneration() {
        const cleanup = this.cleanupTurn("disposal");
        const turn = this.activeTurn;
        if (turn) {
            this.abortTurn(turn);
            await turn.settlement;
        }
        await cleanup;
        await this.waitForCleanup(this.disposeResources(), "disposal");
    }
    get remainingChildren() { return this.childRegistry.remainingChildren; }
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
            await Promise.all([
                shutdownPiSession(this.pi),
                this.bridgeClosePromise ?? Promise.resolve(),
            ]);
        })();
        return this.resourceDisposePromise;
    }
    poison() {
        if (this.closing || this.disposed)
            return;
        this.closing = true;
        void this.onWedged(this.sessionId, this).catch((error) => {
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
