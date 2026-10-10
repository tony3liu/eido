// Adapted for Eido from @automatalabs/pi-acp 0.9.4 (Apache-2.0). See ../LICENSE.
import { existsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { DefaultResourceLoader, SettingsManager, createBashToolDefinition, getAgentDir, } from "@earendil-works/pi-coding-agent";
import { AUTH_METHODS, authenticateMethod } from "./auth.js";
import { adapterError, isChildCleanupError, isRequestError, unexpectedError } from "./errors.js";
import { bridgeMcpServers, } from "./mcp-bridge.js";
import { createCodemodeExtension, createToolSearchExtension } from "@earendil-works/pi-coding-agent";
import { shutdownPiSession } from "./pi-shutdown.js";
import { PiSession } from "./session.js";
import { ChildProcessRegistrySlot, createTrackedBashOperations } from "./child-process-registry.js";
import { SYSTEM_PROMPT_ADVERTISEMENT, SYSTEM_PROMPT_META_KEY, readSystemPromptMeta, systemPromptLoaderOverrides, } from "./system-prompt.js";
import { PKG_VERSION } from "./version.js";
export { PKG_VERSION } from "./version.js";
/** Retry owner for the narrow interval after Pi exists but before PiSession is
 * publishable.  It gives failed-open rollback the same abort/tree barrier and
 * hidden-record ownership as a fully constructed session. */
class FailedOpenCleanup {
    pi;
    bridge;
    children;
    lifecycle;
    deps;
    resourceDispose;
    constructor(pi, bridge, children, lifecycle, deps) {
        this.pi = pi;
        this.bridge = bridge;
        this.children = children;
        this.lifecycle = lifecycle;
        this.deps = deps;
    }
    get remainingChildren() { return this.children.remainingChildren; }
    startResources(bridgeClose) {
        this.resourceDispose ??= (async () => {
            await this.bridge.drainRefreshes().catch((error) => {
                console.error("pi-acp failed-open refresh drain error:", error);
            });
            const results = await Promise.allSettled([
                shutdownPiSession(this.pi),
                bridgeClose,
            ]);
            for (const result of results) {
                if (result.status === "rejected")
                    console.error("pi-acp failed-open resource disposal error:", result.reason);
            }
        })();
        return this.resourceDispose;
    }
    async dispose() {
        const deadline = new AbortController();
        const timer = new AbortController();
        const expiry = this.deps.sleep(this.deps.graceMs, timer.signal).then(() => {
            const failure = adapterError("child_cleanup_error", {
                details: { remainingChildren: this.children.remainingChildren },
            });
            deadline.abort(failure);
            throw failure;
        });
        expiry.catch(() => undefined);
        // Failed-open cleanup has the same synchronous prefix as a published
        // session: close spawn admission first, logically close every MCP client
        // before aborting the binding lifetime, then start Pi abort before its
        // one-shot resource disposal can run.
        const captured = this.children.closeEpoch(deadline.signal);
        this.bridge.startDisposal();
        if (!this.lifecycle.signal.aborted)
            this.lifecycle.abort(new Error("failed open disposed"));
        this.bridge.abortRefreshes();
        const bridgeClose = this.bridge.close();
        bridgeClose.catch(() => undefined);
        let abort;
        try {
            abort = this.pi.abort();
        }
        catch (error) {
            abort = Promise.reject(error);
        }
        abort.catch(() => undefined);
        const settled = Promise.allSettled([abort, captured.drain]);
        let cleanupError;
        await Promise.race([settled, expiry]).then((results) => {
            if (!Array.isArray(results))
                return;
            const failure = results.find((result) => result.status === "rejected");
            if (failure) {
                cleanupError = adapterError("child_cleanup_error", {
                    details: { remainingChildren: this.children.remainingChildren },
                });
            }
        }, (error) => { cleanupError = error; });
        timer.abort();
        // Pi disposal is defense in depth only after the abort/tree barrier has
        // committed success or failure. MCP physical close was already started
        // by the synchronous disposal prefix above.
        const resources = this.startResources(bridgeClose);
        await resources;
        if (cleanupError)
            throw cleanupError;
    }
}
function validateCwd(cwd) {
    if (!isAbsolute(cwd))
        throw adapterError("invalid_cwd");
    try {
        if (!statSync(cwd).isDirectory())
            throw adapterError("invalid_cwd");
    }
    catch (error) {
        if (isRequestError(error))
            throw error;
        throw adapterError("invalid_cwd");
    }
}
function openSignal(requestSignal) {
    const controller = new AbortController();
    const abort = () => controller.abort(requestSignal.reason);
    if (requestSignal.aborted)
        abort();
    else
        requestSignal.addEventListener("abort", abort, { once: true });
    return controller;
}
export class PiAcpAgent {
    deps;
    live = new Map();
    opening = new Map();
    openingControllers = new Set();
    openingTasks = new Set();
    tombstones = new Set();
    deleting = new Set();
    cleanupRecords = new Map();
    mcpOwnerToken = {};
    disposed = false;
    disposePromise;
    disposeSucceeded = false;
    constructor(deps) {
        this.deps = deps;
    }
    initialize(_context) {
        return {
            protocolVersion: 1,
            agentInfo: {
                name: "eido-pi",
                title: "Eido pi (ACP adapter 0.9.4)",
                version: "1.1.0",
            },
            agentCapabilities: {
                loadSession: true,
                promptCapabilities: { image: true },
                mcpCapabilities: { http: true, sse: true },
                sessionCapabilities: { resume: {}, fork: {}, list: {}, close: {}, delete: {} },
            },
            authMethods: AUTH_METHODS,
            _meta: {
                steering: { supported: true },
                loadedTurn: { supported: true },
                [SYSTEM_PROMPT_META_KEY]: { ...SYSTEM_PROMPT_ADVERTISEMENT },
            },
        };
    }
    authenticate(context) {
        return authenticateMethod(context.params.methodId);
    }
    ensureMayOpen(id) {
        if (this.deleting.has(id)) throw adapterError("session_busy");
        if (this.disposed)
            throw adapterError("internal_error");
        if (this.tombstones.has(id))
            throw adapterError("session_terminated");
        if (this.live.has(id) || this.opening.has(id))
            throw adapterError("session_already_open");
    }
    reserve(id, opening) {
        this.ensureMayOpen(id);
        this.opening.set(id, opening);
    }
    beginOpening(requestSignal) {
        if (this.disposed)
            throw adapterError("internal_error");
        const controller = openSignal(requestSignal);
        let settled = false;
        let resolveSettlement;
        const settlement = new Promise((resolve) => { resolveSettlement = resolve; });
        const opening = {
            controller,
            settlement,
            settle: () => {
                if (settled)
                    return;
                settled = true;
                resolveSettlement();
            },
        };
        this.openingControllers.add(controller);
        return opening;
    }
    track(task) {
        this.openingTasks.add(task);
        task.finally(() => this.openingTasks.delete(task)).catch(() => undefined);
        return task;
    }
    gate(opening) {
        opening.controller.signal.throwIfAborted();
        if (this.disposed || (opening.id !== undefined && this.tombstones.has(opening.id))) {
            throw opening.controller.signal.reason ?? adapterError("internal_error");
        }
    }
    async connectMcp(opening, sessionId, cwd, client, mcpServers) {
        const lifecycle = new AbortController();
        const state = { published: false };
        const binding = {
            sessionId,
            cwd,
            client,
            sessionSignal: lifecycle.signal,
            getPi: () => state.pi,
            getTurnSignal: () => state.wrapper?.activeTurnSignal(),
            isPublished: () => state.published,
            emitDiagnostic: (text) => {
                if (state.wrapper)
                    state.wrapper.emitMcpDiagnostic(text);
                else
                    console.error(text);
            },
            poison: () => state.wrapper?.poison(),
            ownerToken: this.mcpOwnerToken,
            modelRuntime: this.deps.modelRuntime,
        };
        try {
            const bridge = await bridgeMcpServers(mcpServers, opening.controller.signal, this.deps, binding);
            return { bridge, lifecycle, state };
        }
        catch (error) {
            lifecycle.abort(new Error("MCP opening failed"));
            throw error;
        }
    }
    async construct(opening, manager, cwd, client, mcpServers, replay, preconnected, systemPrompt) {
        const id = manager.getSessionId();
        if (opening.id === undefined) {
            this.reserve(id, opening);
            opening.id = id;
        }
        let prepared = preconnected;
        let bridge = prepared?.bridge;
        let pi;
        let wrapper;
        let lifecycle = prepared?.lifecycle;
        let bindingState = prepared?.state;
        const childRegistry = new ChildProcessRegistrySlot(this.deps);
        let releaseEidoOwner;
        try {
            releaseEidoOwner = await this.deps.eidoClaimSession?.(id);
            this.gate(opening);
            prepared ??= await this.connectMcp(opening, id, cwd, client, mcpServers);
            bridge = prepared.bridge;
            lifecycle = prepared.lifecycle;
            bindingState = prepared.state;
            this.gate(opening);
            const agentDir = this.deps.agentDir ?? getAgentDir();
            const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
            const instructionFactory = bridge.instructionsExtension;
            const controlExtension = {
                name: "agentprism-pi-acp-control",
                factory: async (api) => {
                    if (typeof instructionFactory === "function")
                        await instructionFactory(api);
                    else
                        await instructionFactory.factory(api);
                    api.registerTool(createBashToolDefinition(cwd, {
                        commandPrefix: settingsManager.getShellCommandPrefix(),
                        operations: createTrackedBashOperations(childRegistry, settingsManager.getShellPath(), this.deps, () => wrapper?.childCleanupFailure()),
                    }));
                },
            };
            const resourceLoader = new DefaultResourceLoader({
                cwd,
                agentDir,
                settingsManager,
                // The client's `_meta.systemPrompt` instructions: `replace` takes pi's custom-prompt
                // slot; `append` lands after the operator's configured append entries.
                ...systemPromptLoaderOverrides(systemPrompt),
                extensionFactories: [bridge.inlineExtension, controlExtension,
                    { name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
                    { name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true }],
                extensionsOverride: (base) => {
                    const matches = base.extensions.filter(({ path }) => path === "<inline:agentprism-pi-acp-mcp>");
                    const controls = base.extensions.filter(({ path }) => path === "<inline:agentprism-pi-acp-control>");
                    if (matches.length !== 1 || controls.length !== 1)
                        throw adapterError("extension_setup_error");
                    const reserved = matches[0];
                    const control = controls[0];
                    const configured = base.extensions.filter(({ path }) => !path.startsWith("<inline:"));
                    const configuredBash = configured.some(({ tools }) => tools.has("bash"));
                    if (configuredBash)
                        control.tools.delete("bash");
                    // Pi records conflict diagnostics before this override can impose
                    // the adapter's deliberate precedence. Remove only the conflicts
                    // that this transaction has actually resolved: the reserved MCP
                    // extension is moved first, and core bash is omitted when a
                    // configured extension already owns it. User/user conflicts and
                    // every loader/factory error remain fatal and retain their order.
                    const reservedNames = new Set(reserved.tools.keys());
                    for (let index = base.errors.length - 1; index >= 0; index -= 1) {
                        const issue = base.errors[index];
                        const resolvedReserved = issue.path === reserved.path
                            && [...reservedNames].some((name) => issue.error.startsWith(`Tool "${name}" conflicts with `));
                        const resolvedBash = configuredBash
                            && issue.path === control.path
                            && issue.error.startsWith('Tool "bash" conflicts with ');
                        if (resolvedReserved || resolvedBash)
                            base.errors.splice(index, 1);
                    }
                    const result = { ...base, extensions: [reserved, ...base.extensions.filter((item) => item !== reserved)] };
                    if (result.runtime !== base.runtime || result.errors !== base.errors)
                        throw adapterError("extension_setup_error");
                    return result;
                },
            });
            await resourceLoader.reload();
            if (resourceLoader.getExtensions().errors.length > 0)
                throw adapterError("extension_setup_error");
            await bridge.initializeRegistrations();
            const created = await this.deps.createAgentSession({
                cwd,
                sessionManager: manager,
                modelRuntime: this.deps.modelRuntime,
                resourceLoader,
                settingsManager,
            });
            pi = created.session;
            bindingState.pi = pi;
            wrapper = new PiSession({
                sessionId: id,
                cwd,
                session: pi,
                manager,
                client,
                deps: this.deps,
                mcpBridge: bridge,
                failedMcpResults: bridge.failedResults,
                availableModels: [],
                settingsManager,
                childRegistry,
                lifecycleController: lifecycle,
                onWedged: (sessionId, session, cleanupRetryRequired) => this.terminateWedged(sessionId, session, cleanupRetryRequired),
            });
            bindingState.wrapper = wrapper;
            pi[Symbol.for("eido.pi.host")]?.attach(wrapper);
            if (releaseEidoOwner) {
                const disposeOwnedSession = wrapper.dispose.bind(wrapper);
                wrapper.dispose = async () => { await disposeOwnedSession(); await releaseEidoOwner(); };
            }
            await pi.bindExtensions({});
            const availableModels = [...await this.deps.modelRuntime.getAvailable()];
            await wrapper.publishAvailableModels(availableModels);
            this.gate(opening);
            bridge.bindSession(pi);
            const toolInfos = pi.getAllTools();
            const names = new Set(toolInfos.map(({ name }) => name));
            const missingAlias = bridge.aliases.find((alias) => !names.has(alias));
            if (missingAlias) {
                throw adapterError("mcp_init_error", {
                    server: bridge.aliasServers.get(missingAlias) ?? "unknown",
                });
            }
            for (const alias of bridge.aliases) {
                const info = toolInfos.find(({ name }) => name === alias);
                if (info?.sourceInfo.path !== "<inline:agentprism-pi-acp-mcp>") {
                    throw adapterError("mcp_init_error", { server: bridge.aliasServers.get(alias) ?? "unknown" });
                }
            }
            const bash = toolInfos.find(({ name }) => name === "bash");
            if (!bash || bash.sourceInfo.path === "<builtin:bash>")
                throw adapterError("extension_setup_error");
            if (replay)
                await wrapper.replay(manager.getBranch());
            bridge.assertReady();
            this.gate(opening);
            const commands = pi[Symbol.for("eido.pi.commands")];
            if (commands) {
                wrapper.enqueue({ sessionUpdate: "available_commands_update", availableCommands: commands.commands });
                await wrapper.drain();
                this.gate(opening);
            }
            this.live.set(id, wrapper);
            bindingState.published = true;
            this.opening.delete(id);
            return wrapper;
        }
        catch (error) {
            let cleanupError;
            if (wrapper) {
                try {
                    await wrapper.dispose();
                }
                catch (candidate) {
                    if (isChildCleanupError(candidate)) {
                        this.cleanupRecords.set(id, wrapper);
                        cleanupError = candidate;
                    }
                }
            }
            else {
                if (pi) {
                    const rollback = new FailedOpenCleanup(pi, bridge, childRegistry, lifecycle, this.deps);
                    if (releaseEidoOwner) {
                        const disposeFailedSession = rollback.dispose.bind(rollback);
                        rollback.dispose = async () => { await disposeFailedSession(); await releaseEidoOwner(); };
                    }
                    try {
                        await rollback.dispose();
                    }
                    catch (candidate) {
                        if (isChildCleanupError(candidate)) {
                            this.cleanupRecords.set(id, rollback);
                            cleanupError = candidate;
                        }
                    }
                }
                else if (bridge) {
                    bridge.startDisposal();
                    if (lifecycle && !lifecycle.signal.aborted)
                        lifecycle.abort(new Error("failed open disposed"));
                    bridge.abortRefreshes();
                    await bridge.close();
                }
            }
            if (cleanupError) {
                opening.cleanupError = cleanupError;
                throw cleanupError;
            }
            await releaseEidoOwner?.();
            throw error;
        }
        finally {
            if (opening.id !== undefined && this.opening.get(opening.id) === opening) {
                this.opening.delete(opening.id);
            }
            this.openingControllers.delete(opening.controller);
            opening.settle();
        }
    }
    openingError(error) {
        if (isRequestError(error))
            throw error;
        throw unexpectedError(error);
    }
    newSession(context) {
        validateCwd(context.params.cwd);
        // Parsed before the journal is created so a malformed instruction leaves no session behind.
        const systemPrompt = readSystemPromptMeta(context.params._meta);
        let manager;
        try {
            manager = this.deps.sessions.create(context.params.cwd, this.deps.sessionDir);
        }
        catch (error) {
            return this.openingError(error);
        }
        const opening = this.beginOpening(context.signal);
        try {
            this.reserve(manager.getSessionId(), opening);
            opening.id = manager.getSessionId();
        }
        catch (error) {
            this.openingControllers.delete(opening.controller);
            opening.settle();
            throw error;
        }
        const task = this.construct(opening, manager, context.params.cwd, context.client, context.params.mcpServers, false, undefined, systemPrompt).then((session) => ({ sessionId: session.sessionId, configOptions: session.configOptions(), modes: null, _meta: {eidoCommands: session.pi[Symbol.for("eido.pi.commands")]?.commands ?? []} }))
            .catch((error) => this.openingError(error));
        return this.track(task);
    }
    reattach(context, replay) {
        validateCwd(context.params.cwd);
        const systemPrompt = readSystemPromptMeta(context.params._meta);
        const opening = this.beginOpening(context.signal);
        try {
            this.reserve(context.params.sessionId, opening);
            opening.id = context.params.sessionId;
        }
        catch (error) {
            this.openingControllers.delete(opening.controller);
            opening.settle();
            throw error;
        }
        const task = (async () => {
            try {
                this.gate(opening);
                const infos = await this.deps.sessions.list(context.params.cwd, this.deps.sessionDir);
                this.gate(opening);
                const info = infos.find(({ id }) => id === context.params.sessionId);
                if (!info)
                    throw adapterError("unknown_session");
                let manager;
                try {
                    manager = this.deps.sessions.open(info.path, this.deps.sessionDir);
                }
                catch {
                    throw adapterError("session_corrupt");
                }
                const session = await this.construct(opening, manager, context.params.cwd, context.client, context.params.mcpServers ?? [], replay, undefined, systemPrompt);
                return { configOptions: session.configOptions(), modes: null };
            }
            catch (error) {
                if (opening.id !== undefined && this.opening.get(opening.id) === opening) {
                    this.opening.delete(opening.id);
                }
                this.openingControllers.delete(opening.controller);
                opening.settle();
                return this.openingError(error);
            }
        })();
        return this.track(task);
    }
    loadSession(context) {
        return this.reattach(context, true);
    }
    resumeSession(context) {
        return this.reattach(context, false);
    }
    forkSession(context) {
        if (this.tombstones.has(context.params.sessionId))
            throw adapterError("session_terminated");
        const liveSource = this.live.get(context.params.sessionId);
        if (liveSource?.busy)
            throw adapterError("session_busy");
        validateCwd(context.params.cwd);
        const systemPrompt = readSystemPromptMeta(context.params._meta);
        const opening = this.beginOpening(context.signal);
        const task = (async () => {
            let prepared;
            let preparedTransferred = false;
            try {
                let sourcePath;
                if (liveSource) {
                    sourcePath = liveSource.manager.getSessionFile();
                    if (!sourcePath || !existsSync(sourcePath))
                        throw adapterError("session_not_forkable");
                }
                else {
                    const all = await this.deps.sessions.listAll(this.deps.sessionDir);
                    sourcePath = all.find(({ id }) => id === context.params.sessionId)?.path;
                    if (!sourcePath)
                        throw adapterError("unknown_session");
                }
                this.gate(opening);
                if (this.tombstones.has(context.params.sessionId))
                    throw adapterError("session_terminated");
                if (liveSource?.busy)
                    throw adapterError("session_busy");
                // Pin the target id before the irreversible journal write so the MCP
                // binding can be fully connected and owned first. SessionManager
                // validates and uses this exact id when forkFrom eventually writes.
                const targetId = randomUUID();
                this.reserve(targetId, opening);
                opening.id = targetId;
                prepared = await this.connectMcp(opening, targetId, context.params.cwd, context.client, context.params.mcpServers ?? []);
                this.gate(opening);
                let manager;
                try {
                    manager = this.deps.sessions.forkFrom(sourcePath, context.params.cwd, this.deps.sessionDir, { id: targetId });
                }
                catch {
                    throw adapterError("session_corrupt");
                }
                preparedTransferred = true;
                const session = await this.construct(opening, manager, context.params.cwd, context.client, context.params.mcpServers ?? [], false, prepared, systemPrompt);
                return { sessionId: session.sessionId, configOptions: session.configOptions(), modes: null };
            }
            catch (error) {
                if (prepared && !preparedTransferred) {
                    prepared.bridge.startDisposal();
                    prepared.lifecycle.abort(new Error("fork failed before construction"));
                    prepared.bridge.abortRefreshes();
                    await prepared.bridge.close().catch((closeError) => {
                        console.error("pi-acp fork MCP rollback error:", closeError);
                    });
                }
                if (opening.id !== undefined && this.opening.get(opening.id) === opening) {
                    this.opening.delete(opening.id);
                }
                this.openingControllers.delete(opening.controller);
                opening.settle();
                return this.openingError(error);
            }
        })();
        return this.track(task);
    }
    async listSessions(context) {
        if (context.params.cwd !== undefined && context.params.cwd !== null)
            validateCwd(context.params.cwd);
        let offset = 0;
        const cursor = context.params.cursor;
        if (cursor) {
            try {
                const decoded = Buffer.from(cursor, "base64url").toString("utf8");
                if (!/^(0|[1-9][0-9]*)$/.test(decoded))
                    throw new Error("noncanonical decimal");
                if (Buffer.from(decoded).toString("base64url") !== cursor)
                    throw new Error("noncanonical base64url");
                const value = BigInt(decoded);
                offset = value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
            }
            catch {
                throw adapterError("invalid_cursor");
            }
        }
        let infos;
        try {
            infos = context.params.cwd
                ? await this.deps.sessions.list(context.params.cwd, this.deps.sessionDir)
                : await this.deps.sessions.listAll(this.deps.sessionDir);
        }
        catch (error) {
            throw unexpectedError(error);
        }
        const page = infos.slice(offset, offset + 100);
        const nextOffset = offset + 100;
        return {
            sessions: page.map((info) => ({
                sessionId: info.id,
                cwd: info.cwd,
                title: info.name ?? info.firstMessage,
            })),
            ...(nextOffset < infos.length
                ? { nextCursor: Buffer.from(String(nextOffset)).toString("base64url") }
                : {}),
        };
    }
    async deleteSession(context) {
        const id = context.params.sessionId;
        if (this.deleting.has(id) || this.opening.has(id) || this.live.get(id)?.busy)
            throw adapterError("session_busy");
        this.deleting.add(id);
        let release;
        try {
            // Stop the owned runtime before touching its journal, and use the
            // same cross-process ownership guard as load/resume.
            await this.closeSession(context);
            if (this.cleanupRecords.has(id)) throw adapterError("child_cleanup_error");
            release = await this.deps.eidoClaimSession?.(id);
            const sessions = await this.deps.sessions.listAll(this.deps.sessionDir);
            const target = sessions.find(session => session.id === id);
            if (target) await rm(target.path);
            this.tombstones.add(id);
            return {};
        } finally {
            await release?.();
            this.deleting.delete(id);
        }
    }
    async closeSession(context) {
        const opening = this.opening.get(context.params.sessionId);
        if (opening) {
            opening.controller.abort(new Error("session closed while opening"));
            await opening.settlement;
            if (opening.cleanupError)
                throw opening.cleanupError;
            return {};
        }
        const session = this.live.get(context.params.sessionId) ?? this.cleanupRecords.get(context.params.sessionId);
        if (!session)
            return {};
        try {
            await session.dispose();
            this.cleanupRecords.delete(context.params.sessionId);
        }
        catch (error) {
            if (isChildCleanupError(error)) {
                this.tombstones.add(context.params.sessionId);
                this.cleanupRecords.set(context.params.sessionId, session);
                throw error;
            }
            console.error("pi-acp close error:", error);
        }
        finally {
            if (this.live.get(context.params.sessionId) === session)
                this.live.delete(context.params.sessionId);
        }
        return {};
    }
    requireLive(id) {
        if (this.deleting.has(id)) throw adapterError("session_busy");
        if (this.tombstones.has(id))
            throw adapterError("session_terminated");
        const session = this.live.get(id);
        if (!session)
            throw adapterError("unknown_session");
        return session;
    }
    setConfigOption(context) {
        const session = this.requireLive(context.params.sessionId);
        return session.setConfig(context.params.configId, context.params.value)
            .then((configOptions) => ({ configOptions }))
            .catch((error) => {
            if (isRequestError(error))
                throw error;
            throw unexpectedError(error);
        });
    }
    prompt(context) {
        return this.requireLive(context.params.sessionId).prompt(context.params, context.signal);
    }
    steer(context) {
        return this.requireLive(context.params.sessionId).steer(context.params)
            .catch((error) => {
            if (isRequestError(error))
                throw error;
            throw unexpectedError(error);
        });
    }
    /** `_session/loaded_turn/query` (see `src/loaded-turn.ts`): the loaded
     *  session's authoritative founding-turn terminal classification. */
    loadedTurnQuery(context) {
        return { status: this.requireLive(context.params.sessionId).loadedTurnStatus() };
    }
    cancel(context) {
        this.live.get(context.params.sessionId)?.cancel();
    }
    async terminateWedged(id, session, cleanupRetryRequired) {
        this.tombstones.add(id);
        if (this.live.get(id) === session)
            this.live.delete(id);
        if (cleanupRetryRequired)
            this.cleanupRecords.set(id, session);
        try {
            if (cleanupRetryRequired) {
                await session.disposeAfterCleanupFailure();
            }
            else {
                await session.dispose();
                this.cleanupRecords.delete(id);
            }
        }
        catch (error) {
            if (isChildCleanupError(error) || session.cleanupRetryRequired) {
                this.cleanupRecords.set(id, session);
            }
            else {
                console.error("pi-acp wedged-session resource disposal error:", error);
            }
        }
    }
    dispose() {
        if (this.disposePromise)
            return this.disposePromise;
        if (this.disposeSucceeded)
            return Promise.resolve();
        this.disposePromise = this.disposeGeneration()
            .then(() => { this.disposeSucceeded = true; })
            .finally(() => {
            if (!this.disposeSucceeded)
                this.disposePromise = undefined;
        });
        return this.disposePromise;
    }
    async disposeGeneration() {
        if (this.disposed && this.cleanupRecords.size === 0)
            return;
        if (!this.disposed) {
            this.disposed = true;
            for (const controller of this.openingControllers)
                controller.abort(new Error("agent disposed"));
            await Promise.allSettled([...this.openingTasks]);
        }
        const records = new Map(this.cleanupRecords);
        for (const [id, session] of this.live)
            records.set(id, session);
        this.live.clear();
        const entries = [...records.entries()];
        const results = await Promise.allSettled(entries.map(([, session]) => session.dispose()));
        this.cleanupRecords.clear();
        let sawChildFailure = false;
        for (let index = 0; index < results.length; index += 1) {
            const result = results[index];
            if (result.status === "rejected" && isChildCleanupError(result.reason)) {
                const [id, session] = entries[index];
                this.cleanupRecords.set(id, session);
                sawChildFailure = true;
            }
        }
        if (sawChildFailure) {
            const remainingChildren = [...this.cleanupRecords.values()]
                .reduce((sum, session) => sum + session.remainingChildren, 0);
            throw adapterError("child_cleanup_error", { details: { remainingChildren } });
        }
    }
}
