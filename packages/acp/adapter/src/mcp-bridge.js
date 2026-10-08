// Adapted for Eido from @automatalabs/pi-acp 0.9.4 (Apache-2.0). See ../LICENSE.
// Eido MCP configuration v1
import { basename } from "node:path";
import { getMcpToolExposure } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/mcp-servers.js";
import { toToolExposure, createMcpResultSchema } from "../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/tools.js";
// Eido MCP exposure v1
function toolPolicy(state, name, synthetic = false) {
    const options = state.server[Symbol.for("eido.pi.mcp.options")];
    const config = options?.config;
    const exposure = config ? (synthetic ? config.exposure ?? "codemode" : getMcpToolExposure(config, name)) : "direct";
    return {
        exposure: toToolExposure(exposure),
        eidoMcpExposure: exposure,
        eidoMcpAutoEnableCodemode: options?.autoEnableCodemode !== false,
        namespace: { name: "mcp__" + state.token, description: config?.description, instructions: state.handle.getInstructions?.() },
    };
}
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CreateMessageRequestSchema, ElicitRequestSchema, ElicitationCompleteNotificationSchema, ErrorCode, ListRootsRequestSchema, LoggingMessageNotificationSchema, McpError, PromptListChangedNotificationSchema, ResourceListChangedNotificationSchema, ResourceUpdatedNotificationSchema, ToolListChangedNotificationSchema, } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { Type } from "typebox";
import { adapterError } from "./errors.js";
import { createMcpSamplingPayload } from "./mcp-sampling-payload.js";
import { PKG_VERSION } from "./version.js";
const NO_RECONNECT = {
    initialReconnectionDelay: 0,
    maxReconnectionDelay: 0,
    reconnectionDelayGrowFactor: 1,
    maxRetries: 0,
};
const NEVER_ABORTED = new AbortController().signal;
export class McpTimeoutError extends Error {
    constructor() {
        super("MCP operation timed out");
        this.name = "McpTimeoutError";
    }
}
export class McpOperationTerminalError extends Error {
    terminalCause;
    terminalReason;
    constructor(terminalCause, terminalReason) {
        super(`MCP operation terminated by ${terminalCause}`);
        this.terminalCause = terminalCause;
        this.terminalReason = terminalReason;
        this.name = "McpOperationTerminalError";
    }
}
export class McpIncomingTerminalError extends Error {
    terminalCause;
    terminalReason;
    constructor(terminalCause, terminalReason) {
        super(`Incoming MCP operation terminated by ${terminalCause}`);
        this.terminalCause = terminalCause;
        this.terminalReason = terminalReason;
        this.name = "McpIncomingTerminalError";
    }
}
function exactMcpError(code, message) {
    const error = new McpError(code, message);
    // McpError adds a local-display prefix, but Protocol serializes error.message verbatim.
    error.message = message;
    return error;
}
/**
 * One terminal arbiter for every MCP request.  Claims are committed in a
 * microtask so conditions that become observable at the same boundary are
 * resolved by the frozen precedence instead of Promise.race scheduling.
 */
export function settleMcpOperation(operation, lifecycleSignal, sessionSignal, peerSignal, timeoutMs, sleep, onCommit) {
    const requestSignal = anySignal([lifecycleSignal, sessionSignal, peerSignal]);
    return new Promise((resolve, reject) => {
        let timer = new AbortController();
        let settled = false;
        let commitQueued = false;
        let timedOut = false;
        let operationOutcome;
        const removers = [];
        const finish = (callback) => {
            if (settled)
                return;
            settled = true;
            timer.abort();
            for (const remove of removers)
                remove();
            callback();
        };
        const commit = () => {
            commitQueued = false;
            if (settled)
                return;
            if (lifecycleSignal?.aborted) {
                finish(() => {
                    onCommit?.({ status: "terminal", cause: "lifecycle", reason: lifecycleSignal.reason });
                    reject(new McpOperationTerminalError("lifecycle", lifecycleSignal.reason));
                });
            }
            else if (sessionSignal?.aborted) {
                finish(() => {
                    onCommit?.({ status: "terminal", cause: "session", reason: sessionSignal.reason });
                    reject(new McpOperationTerminalError("session", sessionSignal.reason));
                });
            }
            else if (peerSignal?.aborted) {
                finish(() => {
                    onCommit?.({ status: "terminal", cause: "peer", reason: peerSignal.reason });
                    reject(new McpOperationTerminalError("peer", peerSignal.reason));
                });
            }
            else if (timedOut) {
                finish(() => {
                    const reason = new McpTimeoutError();
                    onCommit?.({ status: "terminal", cause: "timeout", reason });
                    reject(new McpOperationTerminalError("timeout", reason));
                });
            }
            else {
                const outcome = operationOutcome;
                if (outcome?.status === "fulfilled") {
                    finish(() => {
                        onCommit?.(outcome);
                        resolve(outcome.value);
                    });
                }
                else if (outcome?.status === "rejected") {
                    finish(() => {
                        onCommit?.(outcome);
                        reject(outcome.reason);
                    });
                }
            }
        };
        const claim = () => {
            if (settled || commitQueued)
                return;
            commitQueued = true;
            queueMicrotask(commit);
        };
        const observe = (signal) => {
            if (!signal)
                return;
            if (signal.aborted)
                claim();
            else {
                signal.addEventListener("abort", claim, { once: true });
                removers.push(() => signal.removeEventListener("abort", claim));
            }
        };
        observe(lifecycleSignal);
        observe(sessionSignal);
        observe(peerSignal);
        const resetTimeout = () => {
            if (settled || timedOut) return;
            timer.abort();
            const current = timer = new AbortController();
            sleep(timeoutMs, current.signal).then(() => {
                if (timer === current && !settled) { timedOut = true; claim(); }
            }, () => undefined);
        };
        resetTimeout();
        const running = Promise.resolve().then(() => {
            if (settled)
                throw new Error("MCP operation was cancelled before admission");
            return operation(requestSignal, resetTimeout);
        });
        running.then((value) => { operationOutcome = { status: "fulfilled", value }; claim(); }, (reason) => { operationOutcome = { status: "rejected", reason }; claim(); });
    });
}
export async function bounded(operation, signal, timeoutMs, sleep) {
    try {
        return await settleMcpOperation(() => typeof operation === "function" ? operation() : operation, signal, undefined, undefined, timeoutMs, sleep);
    }
    catch (error) {
        if (error instanceof McpOperationTerminalError) {
            if (error.terminalCause === "timeout")
                throw new McpTimeoutError();
            throw error.terminalReason;
        }
        throw error;
    }
}
export async function settleIncomingMcpOperation(operation, peerSignal, sessionSignal, turnSignal, timeoutMs, sleep, onCommit) {
    try {
        // Positional mapping gives the incoming arbiter its distinct frozen order:
        // peer/transport > session disposal > active turn > timeout > completion.
        return await settleMcpOperation(operation, peerSignal, sessionSignal, turnSignal, timeoutMs, sleep, onCommit);
    }
    catch (error) {
        if (!(error instanceof McpOperationTerminalError))
            throw error;
        const cause = error.terminalCause === "lifecycle"
            ? "peer"
            : error.terminalCause === "peer"
                ? "turn"
                : error.terminalCause;
        throw new McpIncomingTerminalError(cause, error.terminalReason);
    }
}
function isMcpTimeout(error) {
    return error instanceof McpTimeoutError
        || (error instanceof McpOperationTerminalError && error.terminalCause === "timeout");
}
function anySignal(signals) {
    const present = signals.filter((signal) => signal !== undefined);
    return present.length === 0 ? NEVER_ABORTED : AbortSignal.any(present);
}
function headers(values) {
    const result = new Headers();
    for (const { name, value } of values)
        result.append(name, value);
    return result;
}
export class CloseSignallingTransport {
    raw;
    terminate;
    onRawError;
    onRawClose;
    timeoutMs;
    sleep;
    serverToken;
    onclose;
    onerror;
    onmessage;
    signalled = false;
    closePromise;
    constructor(raw, terminate, onRawError, onRawClose, timeoutMs, sleep, serverToken) {
        this.raw = raw;
        this.terminate = terminate;
        this.onRawError = onRawError;
        this.onRawClose = onRawClose;
        this.timeoutMs = timeoutMs;
        this.sleep = sleep;
        this.serverToken = serverToken;
        raw.onclose = () => {
            this.signalClose();
            this.onRawClose();
        };
        raw.onerror = (error) => {
            if (this.onRawError(error))
                this.onerror?.(error);
        };
        raw.onmessage = (message, extra) => this.onmessage?.(message, extra);
    }
    get sessionId() { return this.raw.sessionId; }
    setProtocolVersion(version) { this.raw.setProtocolVersion?.(version); }
    start() { return this.raw.start(); }
    send(message, options) {
        return this.raw.send(message, options);
    }
    signalClose() {
        if (this.signalled)
            return;
        this.signalled = true;
        this.onclose?.();
    }
    close() {
        this.closePromise ??= this.closeOwned();
        return this.closePromise;
    }
    async closeOwned() {
        this.signalClose();
        const timer = new AbortController();
        const expired = this.sleep(this.timeoutMs, timer.signal).then(() => {
            throw new McpTimeoutError();
        });
        expired.catch(() => undefined);
        if (this.terminate) {
            try {
                const terminating = this.terminate();
                terminating.catch(() => undefined);
                await Promise.race([terminating, expired]);
            }
            catch {
                console.error(`[mcp:${this.serverToken}] session termination failed`);
            }
        }
        let physical;
        try {
            physical = this.raw.close();
        }
        catch {
            console.error(`[mcp:${this.serverToken}] close failed`);
            timer.abort();
            return;
        }
        physical.catch(() => undefined);
        try {
            await Promise.race([physical, expired]);
        }
        catch {
            console.error(`[mcp:${this.serverToken}] close failed`);
        }
        finally {
            timer.abort();
        }
    }
}
function safeToken(value) {
    const sanitized = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/_+/g, "_");
    return sanitized || "_";
}
function createTransport(server, serverToken, sleep, fatal, timeoutMs) {
    const fetch = server[Symbol.for("eido.pi.mcp.fetch")] ?? globalThis.fetch;
    let raw;
    let terminate;
    if (!("type" in server)) {
        raw = new StdioClientTransport({
            command: server.command,
            cwd: server[Symbol.for("eido.pi.mcp.options")]?.cwd,
            args: server.args,
            env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
        });
    }
    else if (server.type === "http") {
        let open = true;
        const observedFetch = async (url, init) => {
            // Fatal disable closes the ordinary fetch lane before the owner invokes
            // close(). The retained raw transport must still be able to send its
            // one explicit session DELETE; permitting DELETE here cannot reconnect
            // either GET or POST traffic.
            if (!open && init?.method !== "DELETE")
                throw new Error("MCP transport closed");
            const response = await fetch(url, init);
            if (init?.method === "GET" && response.ok && response.headers.get("content-type")?.includes("text/event-stream") && !response.body) {
                throw new Error("MCP event stream has no body");
            }
            return response;
        };
        const http = new StreamableHTTPClientTransport(new URL(server.url), {
            requestInit: { headers: headers(server.headers) },
            fetch: observedFetch,
            reconnectionOptions: NO_RECONNECT,
        });
        raw = http;
        terminate = () => http.terminateSession();
        const wrapper = new CloseSignallingTransport(raw, terminate, (error) => {
            open = false;
            wrapper.signalClose();
            fatal(error);
            void wrapper.close();
            return false;
        }, () => fatal(), timeoutMs, sleep, serverToken);
        return wrapper;
    }
    else if (server.type === "sse") {
        let open = true;
        const guardedFetch = (url, init) => {
            if (!open)
                return Promise.reject(new Error("MCP transport closed"));
            return fetch(url, init);
        };
        raw = new SSEClientTransport(new URL(server.url), {
            requestInit: { headers: headers(server.headers) },
            eventSourceInit: { fetch: guardedFetch },
            fetch: guardedFetch,
        });
        const wrapper = new CloseSignallingTransport(raw, undefined, (error) => {
            open = false;
            wrapper.signalClose();
            fatal(error);
            void wrapper.close();
            return false;
        }, () => fatal(), timeoutMs, sleep, serverToken);
        return wrapper;
    }
    else {
        throw adapterError("unsupported_mcp_transport", { server: server.name });
    }
    const wrapper = new CloseSignallingTransport(raw, terminate, (error) => {
        // stdio parser/pipe errors are diagnostic-only; natural close is observed by onclose.
        void error;
        return true;
    }, () => {
        fatal();
        void wrapper.close();
    }, timeoutMs, sleep, serverToken);
    return wrapper;
}
let elicitationCounter = 0n;
let elicitationOwnerCounter = 0n;
const elicitationOwners = new WeakMap();
const urlElicitations = new Map();
const consumedElicitations = new Set();
function elicitationKey(binding, token, remote) {
    const owner = binding.ownerToken ?? binding;
    let ownerId = elicitationOwners.get(owner);
    if (ownerId === undefined) {
        ownerId = ++elicitationOwnerCounter;
        elicitationOwners.set(owner, ownerId);
    }
    return `${ownerId}\u0000${binding.sessionId}\u0000${token}\u0000${remote}`;
}
function clearElicitations(binding, token) {
    if (!binding)
        return;
    const prefix = elicitationKey(binding, token, "");
    for (const [key, entry] of urlElicitations) {
        if (key.startsWith(prefix)) {
            entry.declinePending();
            entry.markCommitted();
            urlElicitations.delete(key);
        }
    }
    for (const key of consumedElicitations) {
        if (key.startsWith(prefix))
            consumedElicitations.delete(key);
    }
}
function progress(extra, token, value, diagnostic) {
    if (token === undefined)
        return;
    extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: value, total: 1 } })
        .catch(diagnostic);
}
export function createMcpRootsResult(binding, progressToken, extra, onProgressFailure) {
    extra.signal.throwIfAborted();
    binding.sessionSignal.throwIfAborted();
    progress(extra, progressToken, 0, onProgressFailure);
    const result = { roots: [{ uri: pathToFileURL(binding.cwd).href, name: basename(binding.cwd) }] };
    progress(extra, progressToken, 1, onProgressFailure);
    return result;
}
export function mapMcpSamplingResult(message, stopSequences = []) {
    if (message.stopReason === "error")
        throw exactMcpError(ErrorCode.InternalError, "MCP sampling failed");
    if (message.stopReason === "aborted")
        throw exactMcpError(ErrorCode.InternalError, "MCP sampling cancelled");
    if (message.content.some((block) => block.type === "toolCall")) {
        throw exactMcpError(ErrorCode.InternalError, "MCP sampling returned unsupported tool output");
    }
    let text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
    let stopReason = message.stopReason === "length" ? "maxTokens" : "endTurn";
    let earliest = -1;
    for (const stop of stopSequences) {
        const index = text.indexOf(stop);
        if (index >= 0 && (earliest < 0 || index < earliest))
            earliest = index;
    }
    if (earliest >= 0) {
        text = text.slice(0, earliest);
        stopReason = "stopSequence";
    }
    return {
        role: "assistant",
        model: `${message.provider}/${message.responseModel ?? message.model}`,
        content: { type: "text", text },
        stopReason,
    };
}
function installClientHandlers(client, binding, token, validator, timeoutMs, sleep, formTimeoutMs = timeoutMs) {
    if (!binding)
        return;
    const diagnostic = (suffix) => binding.emitDiagnostic(`[mcp:${token}] ${suffix}`);
    client.setRequestHandler(CreateMessageRequestSchema, async (request, extra) => {
        if (request.params.task || (request.params.includeContext && request.params.includeContext !== "none") || request.params.tools || request.params.toolChoice) {
            throw exactMcpError(ErrorCode.InvalidParams, request.params.task ? "Unsupported experimental MCP task" : "Unsupported MCP sampling capability");
        }
        const progressToken = request.params._meta?.progressToken;
        const turnSignal = binding.getTurnSignal();
        try {
            const result = await settleIncomingMcpOperation((signal) => {
                progress(extra, progressToken, 0, () => diagnostic("progress notification failed"));
                const pi = binding.getPi();
                const model = pi?.model;
                if (!pi || !model) {
                    throw exactMcpError(ErrorCode.InternalError, "MCP sampling requires an active pi session model");
                }
                const prepared = createMcpSamplingPayload(request.params, model);
                return (binding.modelRuntime ?? pi.modelRuntime).completeSimple(model, prepared.context, {
                    signal,
                    maxTokens: request.params.maxTokens,
                    temperature: request.params.temperature,
                    metadata: request.params.metadata,
                    onPayload: prepared.onPayload,
                }).then((message) => mapMcpSamplingResult(message, request.params.stopSequences));
            }, extra.signal, binding.sessionSignal, turnSignal, timeoutMs, sleep);
            progress(extra, progressToken, 1, () => diagnostic("progress notification failed"));
            return result;
        }
        catch (error) {
            if (error instanceof McpIncomingTerminalError) {
                if (error.terminalCause === "peer" || error.terminalCause === "session") {
                    throw error.terminalReason;
                }
                if (error.terminalCause === "turn") {
                    throw exactMcpError(ErrorCode.InternalError, "MCP sampling cancelled");
                }
                throw exactMcpError(ErrorCode.InternalError, "MCP sampling timed out");
            }
            if (error instanceof McpError)
                throw error;
            throw exactMcpError(ErrorCode.InternalError, "MCP sampling failed");
        }
    });
    client.setRequestHandler(ListRootsRequestSchema, (request, extra) => createMcpRootsResult(binding, request.params?._meta?.progressToken, extra, () => diagnostic("progress notification failed")));
    client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
        if (request.params.task)
            throw exactMcpError(ErrorCode.InvalidParams, "Unsupported experimental MCP task");
        // Snapshot publication at handler admission. An elicitation received
        // during open remains local even if session/new publishes while it is
        // settling, while still receiving the ordinary 0/1 progress pair.
        const publishedAtAdmission = binding.isPublished();
        const progressToken = request.params._meta?.progressToken;
        const turnSignal = binding.getTurnSignal();
        let urlKey;
        try {
            const response = await settleIncomingMcpOperation(async () => {
                progress(extra, progressToken, 0, () => diagnostic("progress notification failed"));
                if (!publishedAtAdmission)
                    return { action: "decline" };
                if (request.params.mode === "form") {
                    let validate;
                    try {
                        validate = validator.getValidator(request.params.requestedSchema);
                    }
                    catch {
                        throw exactMcpError(ErrorCode.InternalError, "MCP elicitation schema validation failed");
                    }
                    const value = await binding.client.request("elicitation/create", {
                        sessionId: binding.sessionId,
                        mode: "form",
                        message: request.params.message,
                        requestedSchema: request.params.requestedSchema,
                    });
                    if (value.action !== "accept")
                        return value;
                    const checked = validate(value.content);
                    if (!checked.valid)
                        throw exactMcpError(ErrorCode.InvalidParams, "Invalid MCP elicitation response");
                    return { action: "accept", content: checked.data };
                }
                const urlParams = request.params;
                urlKey = elicitationKey(binding, token, urlParams.elicitationId);
                if (urlElicitations.has(urlKey)) {
                    diagnostic("duplicate elicitation id");
                    return { action: "decline" };
                }
                if (consumedElicitations.has(urlKey)) {
                    diagnostic("reused elicitation id");
                    return { action: "decline" };
                }
                const opaque = `pi-acp-elicitation-${++elicitationCounter}`;
                let declinePending;
                let markCommitted;
                const earlyCompletion = new Promise((resolve) => {
                    declinePending = () => resolve({ action: "decline" });
                });
                const committed = new Promise((resolve) => { markCommitted = resolve; });
                urlElicitations.set(urlKey, {
                    opaque,
                    remote: urlParams.elicitationId,
                    state: "pending",
                    declinePending,
                    committed,
                    markCommitted,
                });
                const acpRequest = binding.client.request("elicitation/create", {
                    sessionId: binding.sessionId,
                    mode: "url",
                    message: urlParams.message,
                    elicitationId: opaque,
                    url: urlParams.url,
                });
                acpRequest.then(() => undefined, () => undefined);
                return Promise.race([acpRequest, earlyCompletion]);
            }, extra.signal, binding.sessionSignal, turnSignal, request.params.mode === "form" ? formTimeoutMs : timeoutMs, sleep, (outcome) => {
                if (!urlKey)
                    return;
                const entry = urlElicitations.get(urlKey);
                if (outcome.status === "fulfilled" && outcome.value.action === "accept" && entry) {
                    entry.state = "accepted";
                    entry.markCommitted();
                    return;
                }
                urlElicitations.delete(urlKey);
                consumedElicitations.add(urlKey);
                entry?.markCommitted();
            });
            progress(extra, progressToken, 1, () => diagnostic("progress notification failed"));
            if (response.action === "accept") {
                return request.params.mode === "form"
                    ? { action: "accept", content: response.content }
                    : { action: "accept" };
            }
            return { action: response.action };
        }
        catch (error) {
            if (error instanceof McpIncomingTerminalError) {
                if (error.terminalCause === "peer" || error.terminalCause === "session") {
                    throw error.terminalReason;
                }
                return { action: "cancel" };
            }
            if (error instanceof McpError)
                throw error;
            progress(extra, progressToken, 1, () => diagnostic("progress notification failed"));
            return { action: "decline" };
        }
    });
    client.setNotificationHandler(ElicitationCompleteNotificationSchema, async (notification) => {
        const key = elicitationKey(binding, token, notification.params.elicitationId);
        let entry = urlElicitations.get(key);
        if (!entry) {
            diagnostic(consumedElicitations.has(key) ? "late elicitation completion" : "unknown elicitation completion");
            return;
        }
        if (entry.state === "pending") {
            entry.declinePending();
            await entry.committed;
            entry = urlElicitations.get(key);
            if (!entry) {
                diagnostic("late elicitation completion");
                return;
            }
        }
        urlElicitations.delete(key);
        consumedElicitations.add(key);
        try {
            await binding.client.notify("elicitation/complete", { elicitationId: entry.opaque });
        }
        catch {
            diagnostic("ACP elicitation completion failed");
        }
    });
}
export async function connectDefaultMcpClient(server, signal, timeoutMs, sleep, binding) {
    const token = binding?.serverToken ?? safeToken(server.name);
    const validator = new AjvJsonSchemaValidator();
    const client = new Client({ name: "@automatalabs/pi-acp", version: PKG_VERSION }, {
        enforceStrictCapabilities: true,
        capabilities: { sampling: {}, roots: { listChanged: false }, elicitation: { form: {}, url: {} } },
        jsonSchemaValidator: validator,
    });
    let state = "opening";
    const fatalController = new AbortController();
    let disabledHandler = () => { };
    let toolsChangedHandler;
    let pendingToolsChanged = false;
    const fatal = () => {
        if (state === "opening") {
            clearElicitations(binding, token);
            fatalController.abort(new Error("MCP transport closed while opening"));
            return;
        }
        if (state !== "open")
            return;
        state = "disabled";
        fatalController.abort(new Error("MCP peer closed"));
        clearElicitations(binding, token);
        binding?.emitDiagnostic(`[mcp:${token}] connection closed; server disabled`);
        disabledHandler();
    };
    const transport = createTransport(server, token, sleep, fatal, timeoutMs);
    // Browser handoff waits for a person, independently of network deadlines.
    // Its progress keeps the outer tool call alive; turn/session cancellation
    // still settles the incoming request immediately.
    installClientHandlers(client, binding, token, validator, timeoutMs, sleep,
        server.name === "eido_browser" ? 30 * 60_000 : timeoutMs);
    const capabilityDiagnostic = (method) => binding?.emitDiagnostic(`[mcp:${token}] ${method}`);
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        const caps = client.getServerCapabilities();
        if (!caps?.tools?.listChanged)
            return capabilityDiagnostic("unexpected notifications/tools/list_changed");
        if (toolsChangedHandler)
            toolsChangedHandler();
        else
            pendingToolsChanged = true;
    });
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
        const caps = client.getServerCapabilities();
        capabilityDiagnostic(caps?.resources?.listChanged ? "notifications/resources/list_changed" : "unexpected notifications/resources/list_changed");
    });
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
        const caps = client.getServerCapabilities();
        capabilityDiagnostic(caps?.resources?.subscribe
            ? `notifications/resources/updated uri=${notification.params.uri}`
            : "unexpected notifications/resources/updated");
    });
    client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
        const caps = client.getServerCapabilities();
        capabilityDiagnostic(caps?.prompts?.listChanged ? "notifications/prompts/list_changed" : "unexpected notifications/prompts/list_changed");
    });
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
        if (!client.getServerCapabilities()?.logging) {
            capabilityDiagnostic("unexpected notifications/message");
            return;
        }
        const data = typeof notification.params.data === "string"
            ? notification.params.data
            : JSON.stringify(notification.params.data) ?? String(notification.params.data);
        binding?.emitDiagnostic(`[mcp:${token}] ${notification.params.level}: ${data}`);
    });
    client.onerror = () => {
        if (state === "opening" || state === "open")
            binding?.emitDiagnostic(`[mcp:${token}] transport error`);
    };
    try {
        await settleMcpOperation((connectSignal) => client.connect(transport, { timeout: timeoutMs, signal: connectSignal }), signal, binding?.sessionSignal, fatalController.signal, timeoutMs, sleep);
        state = "open";
    }
    catch (error) {
        state = "closing";
        await transport.close();
        state = "closed";
        throw error;
    }
    const options = (requestSignal, requestTimeout, onprogress) => ({
        signal: requestSignal,
        timeout: requestTimeout,
        resetTimeoutOnProgress: true,
        ...(onprogress ? { onprogress } : {}),
    });
    return {
        async listTools(cursor, requestSignal, requestTimeout, onprogress) {
            const raw = await client.listTools(cursor ? { cursor } : undefined, options(requestSignal, requestTimeout, onprogress));
            return { tools: raw.tools, nextCursor: raw.nextCursor, raw };
        },
        async callTool(name, args, requestSignal, requestTimeout, onprogress) {
            const result = await client.callTool({ name, arguments: typeof args === "object" && args !== null ? args : {} }, undefined, options(requestSignal, requestTimeout, onprogress));
            if (!("content" in result))
                throw new Error("MCP task result did not contain tool content");
            return result;
        },
        async ping(requestSignal, requestTimeout) { await client.ping(options(requestSignal, requestTimeout)); },
        getCapabilities: () => client.getServerCapabilities(),
        getInstructions: () => client.getInstructions(),
        async setLoggingLevel(requestSignal, requestTimeout) { await client.setLoggingLevel("info", options(requestSignal, requestTimeout)); },
        listResources: (cursor, requestOptions) => client.listResources(cursor ? { cursor } : undefined, requestOptions),
        listResourceTemplates: (cursor, requestOptions) => client.listResourceTemplates(cursor ? { cursor } : undefined, requestOptions),
        readResource: (uri, requestOptions) => client.readResource({ uri }, requestOptions),
        subscribeResource: (uri, requestOptions) => client.subscribeResource({ uri }, requestOptions),
        unsubscribeResource: (uri, requestOptions) => client.unsubscribeResource({ uri }, requestOptions),
        listPrompts: (cursor, requestOptions) => client.listPrompts(cursor ? { cursor } : undefined, requestOptions),
        getPrompt: (name, args, requestOptions) => client.getPrompt({ name, arguments: args }, requestOptions),
        complete: (params, requestOptions) => client.complete(params, requestOptions),
        setToolsChangedHandler(handler) {
            toolsChangedHandler = handler;
            if (pendingToolsChanged) {
                pendingToolsChanged = false;
                handler();
            }
        },
        setDisabledHandler(handler) {
            disabledHandler = handler;
            if (state === "disabled")
                handler();
        },
        ...("type" in server && server.type === "http" ? {
            disableOnTimeout: () => {
                fatal();
                void transport.close();
            },
        } : {}),
        getPeerSignal: () => fatalController.signal,
        jsonSchemaValidator: validator,
        closeIsBounded: true,
        async close() {
            if (state === "closed" || state === "closing")
                return;
            state = "closing";
            clearElicitations(binding, token);
            // Protocol._onclose() deliberately drops its transport reference as
            // soon as our logical close signal fires. Retain and close the wrapper
            // owner directly so EOF/fatal paths still join HTTP DELETE + physical
            // close instead of turning Client.close() into a no-op.
            await transport.close();
            state = "closed";
        },
    };
}
export function allocateAlias(server, tool, used) {
    const base = `mcp__${safeToken(server)}__${safeToken(tool)}`;
    let candidate = base.slice(0, 128);
    if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
    }
    for (let index = 2;; index += 1) {
        const suffix = `_${index}`;
        candidate = `${base.slice(0, 128 - suffix.length)}${suffix}`;
        if (!used.has(candidate)) {
            used.add(candidate);
            return candidate;
        }
    }
}
export function convertMcpContent(content) {
    switch (content.type) {
        case "text": return { type: "text", text: content.text };
        case "image": return { type: "image", data: content.data, mimeType: content.mimeType };
        case "audio": return { type: "text", text: `[audio mime=${content.mimeType} bytes=${Buffer.from(content.data, "base64").byteLength}]` };
        case "resource_link": return { type: "text", text: `[${content.title ?? content.name ?? content.uri}](${content.uri})` };
        case "resource": return "text" in content.resource
            ? { type: "text", text: content.resource.text }
            : { type: "text", text: `[embedded resource uri=${content.resource.uri} mime=${content.resource.mimeType ?? "application/octet-stream"} bytes=${Buffer.from(content.resource.blob, "base64").byteLength}]` };
        default: throw new Error("Unsupported MCP content block");
    }
}
export function convertMcpResult(result) {
    const { _meta, ...structuredContent } = result;
    const content = result.content.map(convertMcpContent);
    // MCP servers may provide actionable handles only in structuredContent.
    // pi's model transcript consumes content, while details are UI metadata.
    // Keep the original result for Code Mode and expose missing structured data
    // as text without duplicating servers that already return its JSON.
    if (result.structuredContent !== undefined) {
        const encoded = JSON.stringify(result.structuredContent);
        const included = result.content.some(block => {
            if (block.type !== "text") return false;
            try { return JSON.stringify(JSON.parse(block.text)) === encoded; }
            catch { return false; }
        });
        if (!included) content.push({ type: "text", text: encoded });
    }
    return { content, details: structuredContent, structuredContent };
}
const EMPTY_SCHEMA = Type.Object({});
const URI_SCHEMA = Type.Object({ uri: Type.String() });
const PROMPT_SCHEMA = Type.Object({ name: Type.String(), arguments: Type.Optional(Type.Record(Type.String(), Type.String())) });
const COMPLETE_SCHEMA = Type.Object({
    ref: Type.Union([
        Type.Object({ type: Type.Literal("ref/prompt"), name: Type.String() }),
        Type.Object({ type: Type.Literal("ref/resource"), uri: Type.String() }),
    ]),
    argument: Type.Object({ name: Type.String(), value: Type.String() }),
    context: Type.Optional(Type.Object({ arguments: Type.Optional(Type.Record(Type.String(), Type.String())) })),
});
async function pageAll(request, signal, deps, field, onUpdate, serverToken = "_") {
    const items = [];
    const pages = [];
    const seen = new Set();
    let cursor;
    do {
        if (cursor !== undefined) {
            if (seen.has(cursor))
                throw new Error("cycling pagination cursor");
            seen.add(cursor);
        }
        const page = await settleMcpOperation((requestSignal, resetTimeout) => request(cursor, {
            signal: requestSignal,
            resetTimeoutOnProgress: true,
            timeout: deps.mcpTimeoutMs,
            ...{ onprogress: (value) => {
                    resetTimeout();
                    const item = value;
                    onUpdate?.({
                        content: [{
                                type: "text",
                                text: `[mcp:${serverToken}] ${String(item.progress)}${item.total === undefined ? "" : `/${String(item.total)}`}${item.message === undefined ? "" : ` ${String(item.message)}`}`,
                            }],
                        details: value,
                    });
                } },
        }), signal, undefined, undefined, deps.mcpTimeoutMs, deps.sleep);
        pages.push(page);
        const values = page[field];
        if (!Array.isArray(values))
            throw new Error(`invalid ${field} result`);
        items.push(...values);
        cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
    } while (cursor !== undefined);
    return { items, pages };
}
function syntheticTool(policy, alias, description, parameters, execute) {
    return { ...policy, name: alias, label: alias, description, parameters, execute };
}
export async function bridgeMcpServers(servers, openSignal, deps, binding) {
    const seenNames = new Set();
    for (const server of servers) {
        if (seenNames.has(server.name))
            throw adapterError("mcp_init_error", { server: server.name });
        seenNames.add(server.name);
        if ("type" in server && server.type === "acp")
            throw adapterError("unsupported_mcp_transport", { server: server.name });
    }
    const states = [];
    const acquiredHandles = [];
    const failedResults = new Map();
    const aliasServers = new Map();
    const tools = [];
    const aliases = [];
    const usedAliases = new Set();
    const usedServerTokens = new Set();
    const serverTokens = new Map();
    let extensionApi;
    let piSession;
    let refreshQueue = Promise.resolve();
    let refreshScheduled = false;
    let closing = false;
    let poisoned = false;
    let refreshController = new AbortController();
    let refreshPaused = false;
    let boundaryTail = Promise.resolve();
    const pendingDiagnostics = [];
// Eido MCP runtime status v1
    const statusSink = deps.connectMcpClient[Symbol.for("eido.pi.mcp.status")]?.(binding);
    const statusRows = new Map();
    const publishStatus = () => statusSink?.publish([...statusRows.values()]);
    const reportStatus = (server, state, toolCount = 0) => {
        statusRows.set(server.name, {server, state, toolCount});
        publishStatus();
    };
    const assertReady = () => {
        if (closing || poisoned) throw adapterError("mcp_init_error", { server: "closed" });
    };
    const skipServer = async (server, state, handle, diagnose = true) => {
        if (state) {
            state.disabled = true;
            state.dirty = false;
            states.splice(states.indexOf(state), 1);
            for (const alias of state.validAliases) {
                const index = tools.findIndex(tool => tool.name === alias);
                if (index >= 0) tools.splice(index, 1);
                const reserved = aliases.indexOf(alias);
                if (reserved >= 0) aliases.splice(reserved, 1);
                aliasServers.delete(alias);
                usedAliases.delete(alias);
            }
            state.validAliases.clear();
        }
        if (handle) {
            await closeClients([handle], deps);
            const index = acquiredHandles.indexOf(handle);
            if (index >= 0) acquiredHandles.splice(index, 1);
        }
        reportStatus(server, server[Symbol.for("eido.pi.mcp.needs-auth")] ? "needs-auth" : "unavailable");
        if (!diagnose) return;
        const reason = server[Symbol.for("eido.pi.mcp.needs-auth")]
            ? "sign-in required. Open Extensions > MCP to sign in, then start or reload a task."
            : "unavailable. Check its configuration in Extensions > MCP, then start or reload a task.";
        pendingDiagnostics.push('[mcp:' + safeToken(server.name) + '] ' + reason + ' Other tools remain available.\n');
    };
    const acquireTurnBoundary = async () => {
        let release;
        const held = new Promise((resolve) => { release = resolve; });
        const prior = boundaryTail;
        boundaryTail = prior.then(() => held);
        await prior;
        return release;
    };
    const allocateServerToken = (name) => {
        if (serverTokens.has(name)) return serverTokens.get(name);
        const base = safeToken(name);
        let candidate = base;
        for (let index = 2; usedServerTokens.has(candidate); index += 1)
            candidate = `${base}_${index}`;
        usedServerTokens.add(candidate);
        serverTokens.set(name, candidate);
        return candidate;
    };
    const requestOptions = (state, signal, onprogress) => ({
        signal,
        timeout: state.timeoutMs,
        resetTimeoutOnProgress: true,
        ...(onprogress ? { onprogress } : {}),
    });
    const makeSynthetic = (state, operation) => {
        const alias = allocateAlias(state.token, operation, usedAliases);
        state.syntheticAliases.push(alias);
        state.validAliases.add(alias);
        aliases.push(alias);
        aliasServers.set(alias, state.server.name);
        const executeRequest = async (toolCallId, signal, onUpdate, operation) => {
            if (state.disabled || !state.validAliases.has(alias)) {
                throw new Error(`MCP tool ${alias} is no longer available`);
            }
            let acceptingUpdates = true;
            const guardedUpdate = (update) => {
                if (acceptingUpdates)
                    onUpdate?.(update);
            };
            let result;
            try {
                result = await settleMcpOperation((requestSignal, resetTimeout) => operation(requestSignal, (update) => { resetTimeout(); guardedUpdate(update); }), signal, binding?.sessionSignal, state.peerDead ? undefined : state.handle.getPeerSignal?.(), state.timeoutMs, deps.sleep);
            }
            catch (error) {
                if (isMcpTimeout(error))
                    state.handle.disableOnTimeout?.();
                throw new Error(isMcpTimeout(error) ? `MCP tool ${alias} timed out` : `MCP tool ${alias} failed`);
            }
            finally {
                acceptingUpdates = false;
            }
            void toolCallId;
            return result;
        };
        const updateProgress = (onUpdate) => (value) => {
            const item = value;
            onUpdate?.({
                content: [{
                        type: "text",
                        text: `[mcp:${state.token}] ${String(item.progress)}${item.total === undefined ? "" : `/${String(item.total)}`}${item.message === undefined ? "" : ` ${String(item.message)}`}`,
                    }],
                details: value,
            });
        };
        switch (operation) {
            case "list_resources": return syntheticTool(toolPolicy(state, operation, true), alias, "List MCP resources", EMPTY_SCHEMA, async (_id, _params, signal, onUpdate) => {
                const result = await executeRequest(_id, signal, onUpdate, (requestSignal, guardedUpdate) => pageAll(state.handle.listResources.bind(state.handle), requestSignal, { ...deps, mcpTimeoutMs: state.timeoutMs }, "resources", guardedUpdate, state.token));
                const paged = result;
                return { content: [{ type: "text", text: JSON.stringify({ resources: paged.items }) }], details: { pages: paged.pages } };
            });
            case "list_resource_templates": return syntheticTool(toolPolicy(state, operation, true), alias, "List MCP resource templates", EMPTY_SCHEMA, async (_id, _params, signal, onUpdate) => {
                const paged = await executeRequest(_id, signal, onUpdate, (requestSignal, guardedUpdate) => pageAll(state.handle.listResourceTemplates.bind(state.handle), requestSignal, { ...deps, mcpTimeoutMs: state.timeoutMs }, "resourceTemplates", guardedUpdate, state.token));
                return { content: [{ type: "text", text: JSON.stringify({ resourceTemplates: paged.items }) }], details: { pages: paged.pages } };
            });
            case "read_resource": return syntheticTool(toolPolicy(state, operation, true), alias, "Read an MCP resource", URI_SCHEMA, async (_id, params, signal, onUpdate) => {
                const input = params;
                const result = await executeRequest(_id, signal, onUpdate, (requestSignal, guardedUpdate) => state.handle.readResource(input.uri, requestOptions(state, requestSignal, updateProgress(guardedUpdate))));
                return { content: result.contents.map((content) => content.text !== undefined
                        ? { type: "text", text: content.text }
                        : { type: "text", text: `[embedded resource uri=${content.uri} mime=${content.mimeType ?? "application/octet-stream"} bytes=${Buffer.from(content.blob ?? "", "base64").byteLength}]` }), details: result };
            });
            case "subscribe_resource": return syntheticTool(toolPolicy(state, operation, true), alias, "Subscribe to an MCP resource", URI_SCHEMA, async (_id, params, signal, onUpdate) => {
                const input = params;
                const result = await executeRequest(_id, signal, onUpdate, (requestSignal, guardedUpdate) => state.handle.subscribeResource(input.uri, requestOptions(state, requestSignal, updateProgress(guardedUpdate))));
                return { content: [{ type: "text", text: `Subscribed to ${input.uri}` }], details: result };
            });
            case "unsubscribe_resource": return syntheticTool(toolPolicy(state, operation, true), alias, "Unsubscribe from an MCP resource", URI_SCHEMA, async (_id, params, signal, onUpdate) => {
                const input = params;
                const result = await executeRequest(_id, signal, onUpdate, (requestSignal, guardedUpdate) => state.handle.unsubscribeResource(input.uri, requestOptions(state, requestSignal, updateProgress(guardedUpdate))));
                return { content: [{ type: "text", text: `Unsubscribed from ${input.uri}` }], details: result };
            });
            case "list_prompts": return syntheticTool(toolPolicy(state, operation, true), alias, "List MCP prompts", EMPTY_SCHEMA, async (_id, _params, signal, onUpdate) => {
                const paged = await executeRequest(_id, signal, onUpdate, (requestSignal, guardedUpdate) => pageAll(state.handle.listPrompts.bind(state.handle), requestSignal, { ...deps, mcpTimeoutMs: state.timeoutMs }, "prompts", guardedUpdate, state.token));
                return { content: [{ type: "text", text: JSON.stringify({ prompts: paged.items }) }], details: { pages: paged.pages } };
            });
            case "get_prompt": return syntheticTool(toolPolicy(state, operation, true), alias, "Get an MCP prompt", PROMPT_SCHEMA, async (_id, params, signal, onUpdate) => {
                const input = params;
                const result = await executeRequest(_id, signal, onUpdate, (requestSignal, guardedUpdate) => state.handle.getPrompt(input.name, input.arguments, requestOptions(state, requestSignal, updateProgress(guardedUpdate))));
                const content = [
                    ...(result.description ? [{ type: "text", text: `[mcp prompt description]\n${result.description}` }] : []),
                    ...result.messages.flatMap((message) => [{ type: "text", text: `[mcp prompt role=${message.role}]` }, convertMcpContent(message.content)]),
                ];
                return { content, details: result };
            });
            case "complete": return syntheticTool(toolPolicy(state, operation, true), alias, "Complete an MCP prompt or resource argument", COMPLETE_SCHEMA, async (_id, params, signal, onUpdate) => {
                const result = await executeRequest(_id, signal, onUpdate, (requestSignal, guardedUpdate) => state.handle.complete(params, requestOptions(state, requestSignal, updateProgress(guardedUpdate))));
                return { content: [{ type: "text", text: JSON.stringify(result.completion) }], details: result };
            });
            default: throw new Error("unknown synthetic MCP operation");
        }
    };
    const remoteDefinition = (state, remote, alias) => ({
        ...toolPolicy(state, remote.name),
        annotations: remote.annotations,
        outputSchema: createMcpResultSchema(remote.outputSchema),
        name: alias,
        label: remote.title ?? remote.annotations?.title ?? remote.name,
        description: remote.description ?? `MCP tool ${remote.name}`,
        parameters: remote.inputSchema,
        execute: async (toolCallId, params, signal, onUpdate) => {
            if (state.disabled || !state.validAliases.has(alias) || state.aliases.get(remote.name) !== alias) {
                throw new Error(`MCP tool ${alias} is no longer available`);
            }
            let acceptingUpdates = true;
            let result;
            try {
                result = await settleMcpOperation((requestSignal, resetTimeout) => state.handle.callTool(remote.name, params, requestSignal, state.timeoutMs, (value) => {
                    if (!acceptingUpdates)
                        return;
                    resetTimeout();
                    const progressValue = value;
                    const text = `[mcp:${state.token}] ${String(progressValue.progress)}${progressValue.total === undefined ? "" : `/${String(progressValue.total)}`}${progressValue.message === undefined ? "" : ` ${String(progressValue.message)}`}`;
                    onUpdate?.({ content: [{ type: "text", text }], details: value });
                }), signal, binding?.sessionSignal, state.peerDead ? undefined : state.handle.getPeerSignal?.(), state.timeoutMs, deps.sleep);
                const validate = state.validators.get(alias);
                if (validate && !result.isError) {
                    if (result.structuredContent === undefined || !validate(result.structuredContent).valid)
                        throw new Error("invalid MCP tool output");
                }
            }
            catch (error) {
                if (isMcpTimeout(error))
                    state.handle.disableOnTimeout?.();
                throw new Error(isMcpTimeout(error) ? `MCP tool ${alias} timed out` : `MCP tool ${alias} failed`);
            }
            finally {
                acceptingUpdates = false;
            }
            const projection = convertMcpResult(result);
            if (result.isError) {
                failedResults.set(toolCallId, projection);
                throw new Error(`MCP tool ${alias} failed`);
            }
            return projection;
        },
    });
    const enumerate = async (state, lifecycleSignal) => {
        const listed = [];
        const pages = [];
        const seenCursors = new Set();
        const seenNames = new Set();
        let cursor;
        do {
            if (cursor !== undefined) {
                if (seenCursors.has(cursor))
                    throw new Error("cycling tools/list cursor");
                seenCursors.add(cursor);
            }
            let page;
            try {
                page = await settleMcpOperation((requestSignal, resetTimeout) => state.handle.listTools(cursor, requestSignal, state.timeoutMs, resetTimeout), lifecycleSignal, binding?.sessionSignal, state.handle.getPeerSignal?.(), state.timeoutMs, deps.sleep);
            }
            catch (error) {
                if (isMcpTimeout(error))
                    state.handle.disableOnTimeout?.();
                throw error;
            }
            pages.push(page.raw ?? page);
            for (const tool of page.tools) {
                if (seenNames.has(tool.name) || tool.execution?.taskSupport === "required")
                    throw new Error("invalid MCP tool catalog");
                seenNames.add(tool.name);
                listed.push(tool);
            }
            cursor = page.nextCursor;
        } while (cursor !== undefined);
        return { tools: listed, pages };
    };
    const poison = (state) => {
        if (poisoned)
            return;
        poisoned = true;
        closing = true;
        void statusSink?.close();
        refreshController.abort(new Error("MCP refresh commit failed"));
        binding?.emitDiagnostic(`[mcp:${state.token}] tools/list refresh commit failed; session terminated`);
        binding?.poison?.(state.server.name);
    };
    const refreshOne = async (state) => {
        if (closing || refreshPaused || state.peerDead || state.disabled || !extensionApi || !piSession)
            return;
        let candidate;
        let candidateUsed;
        let nextAliases;
        let definitions;
        let validators;
        let removed;
        const addedReservations = [];
        try {
            candidate = await enumerate(state, refreshController.signal);
            candidateUsed = new Set(usedAliases);
            nextAliases = new Map(state.aliases);
            const previousNames = new Set(state.tools.map((tool) => tool.name));
            definitions = [];
            validators = new Map();
            for (const remote of candidate.tools) {
                let alias = nextAliases.get(remote.name);
                if (!alias) {
                    alias = allocateAlias(state.token, remote.name, candidateUsed);
                    nextAliases.set(remote.name, alias);
                    addedReservations.push({ alias, server: state.server.name });
                }
                if (remote.outputSchema)
                    validators.set(alias, state.validatorProvider.getValidator(remote.outputSchema));
                definitions.push(remoteDefinition(state, remote, alias));
                previousNames.delete(remote.name);
            }
            removed = [...previousNames]
                .map((name) => state.aliases.get(name))
                .filter((value) => value !== undefined);
        }
        catch (error) {
            if (isMcpTimeout(error))
                state.handle.disableOnTimeout?.();
            if (refreshPaused && !closing && !state.peerDead && !state.disabled)
                state.dirty = true;
            if (!closing && !refreshPaused && !state.peerDead && !state.disabled) {
                reportStatus(state.server, "degraded", state.tools.length);
            }
            if (!closing && !refreshPaused && !state.peerDead && !state.disabled)
                binding?.emitDiagnostic(`[mcp:${state.token}] tools/list refresh failed`);
            return;
        }
        const release = await acquireTurnBoundary();
        if (closing || refreshPaused || state.peerDead || state.disabled || !extensionApi || !piSession) {
            if (refreshPaused && !closing && !state.peerDead && !state.disabled)
                state.dirty = true;
            release();
            return;
        }
        let mutationStarted = false;
        try {
            for (const definition of definitions) {
                mutationStarted = true;
                extensionApi.registerTool(definition);
            }
            const active = new Set(piSession.getActiveToolNames());
            for (const alias of removed) {
                active.delete(alias);
                const definition = piSession.getToolDefinition(alias);
                if (definition) extensionApi.registerTool({ ...definition, exposure: "hidden" });
            }
            for (const definition of definitions) {
                if (definition.exposure === "direct" && !state.validAliases.has(definition.name)) active.add(definition.name);
                if (definition.exposure === "hidden") active.delete(definition.name);
            }
            mutationStarted = true;
            piSession.setActiveToolsByName([...active]);
            usedAliases.clear();
            for (const alias of candidateUsed)
                usedAliases.add(alias);
            for (const reservation of addedReservations) {
                aliases.push(reservation.alias);
                aliasServers.set(reservation.alias, reservation.server);
            }
            state.aliases = nextAliases;
            state.tools = candidate.tools;
            state.pages = candidate.pages;
            reportStatus(state.server, "connected", candidate.tools.length);
            state.validators = validators;
            state.validAliases = new Set([...state.syntheticAliases, ...definitions.map(({ name }) => name)]);
            for (const alias of removed) {
                const index = tools.findIndex(tool => tool.name === alias);
                if (index >= 0) tools[index] = { ...tools[index], exposure: "hidden" };
            }
            for (const definition of definitions) {
                const index = tools.findIndex(tool => tool.name === definition.name);
                if (index >= 0) tools[index] = definition;
                else tools.push(definition);
            }
        }
        catch {
            if (mutationStarted)
                poison(state);
            else
                binding?.emitDiagnostic(`[mcp:${state.token}] tools/list refresh failed`);
        }
        finally {
            release();
        }
    };
    const runRefreshBatches = async () => {
        while (!closing && !refreshPaused) {
            const batch = states.filter((state) => state.dirty && !state.initializing && !state.peerDead && !state.disabled);
            if (batch.length === 0)
                return;
            for (const state of batch)
                state.dirty = false;
            for (const state of batch)
                await refreshOne(state);
        }
    };
    const scheduleRefreshes = () => {
        if (refreshScheduled || closing || refreshPaused || !extensionApi || !piSession)
            return;
        refreshScheduled = true;
        refreshQueue = refreshQueue
            .then(runRefreshBatches)
            .finally(() => {
            refreshScheduled = false;
            if (!refreshPaused && states.some((state) => state.dirty && !state.initializing && !state.peerDead && !state.disabled))
                scheduleRefreshes();
        });
        refreshQueue.catch(() => undefined);
    };
    const refresh = (state) => {
        if (closing || state.peerDead || state.disabled)
            return;
        state.dirty = true;
        if (!state.initializing && !refreshPaused)
            scheduleRefreshes();
    };
    const connectServers = async (servers, openSignal) => {
        const acquiredStart = acquiredHandles.length;
    try {
        for (const server of servers) {
            reportStatus(server, "connecting");
            const token = allocateServerToken(server.name);
            const timeoutMs = server[Symbol.for("eido.pi.mcp.options")]?.timeoutMs ?? deps.mcpTimeoutMs;
            let handle;
            let state;
            try {
                const serverBinding = binding ? { ...binding, serverToken: token } : undefined;
                const connecting = deps.connectMcpClient(server, openSignal, serverBinding);
                connecting.then(() => undefined, () => undefined);
                try {
                    handle = await settleMcpOperation(() => connecting, openSignal, binding?.sessionSignal, undefined, timeoutMs, deps.sleep);
                }
                catch (error) {
                    // The outer transport-start bound can win before the factory returns its owner. Observe and
                    // close a detached late handle so a real stdio child cannot escape rollback.
                    void connecting.then((late) => late.close()).catch(() => undefined);
                    throw error;
                }
                // Ownership transfers immediately when connect returns.  Ping, logging,
                // and enumeration are all post-connect work and rollback must close
                // this handle if any of them fails.
                acquiredHandles.push(handle);
                state = {
                    server,
                    timeoutMs,
                    token,
                    handle,
                    tools: [],
                    pages: [],
                    aliases: new Map(),
                    validators: new Map(),
                    validatorProvider: handle.jsonSchemaValidator ?? new AjvJsonSchemaValidator(),
                    syntheticAliases: [],
                    validAliases: new Set(),
                    peerDead: false,
                    disabled: false,
                    dirty: false,
                    initializing: true,
                };
                states.push(state);
                handle.setToolsChangedHandler?.(() => refresh(state));
                handle.setDisabledHandler?.(() => {
                    if (state.peerDead || state.disabled || closing)
                        return;
                    // Transport death is observable immediately, but alias validity is
                    // committed only while holding the turn boundary.  The running turn
                    // therefore retains its selected definition and receives the remote
                    // connection failure, not a premature tombstone.
                    state.peerDead = true;
                    reportStatus(server, "disconnected");
                    state.dirty = false;
                    refreshQueue = refreshQueue.then(async () => {
                        if (!piSession || closing)
                            return;
                        const release = await acquireTurnBoundary();
                        try {
                            if (!piSession || closing)
                                return;
                            const active = new Set(piSession.getActiveToolNames());
                            for (const alias of [...state.syntheticAliases, ...state.aliases.values()]) {
                                active.delete(alias);
                                const definition = piSession.getToolDefinition(alias);
                                if (definition) extensionApi.registerTool({ ...definition, exposure: "hidden" });
                            }
                            piSession.setActiveToolsByName([...active]);
                            for (const alias of state.validAliases) {
                                const index = tools.findIndex(tool => tool.name === alias);
                                if (index >= 0) tools[index] = { ...tools[index], exposure: "hidden" };
                            }
                            state.validAliases.clear();
                            state.disabled = true;
                        }
                        catch {
                            poison(state);
                        }
                        finally {
                            release();
                        }
                    });
                    refreshQueue.catch(() => undefined);
                });
                if (handle.ping) {
                    await settleMcpOperation((requestSignal) => handle.ping(requestSignal, timeoutMs), openSignal, binding?.sessionSignal, handle.getPeerSignal?.(), timeoutMs, deps.sleep);
                }
                else if (handle.getPeerSignal?.().aborted) {
                    throw new McpOperationTerminalError("peer", handle.getPeerSignal?.().reason);
                }
            }
            catch (error) {
                if (error instanceof McpOperationTerminalError
                    && (error.terminalCause === "lifecycle" || error.terminalCause === "session")) {
                    throw error.terminalReason;
                }
                if (openSignal.aborted)
                    throw openSignal.reason;
                await skipServer(server, state, handle);
                continue;
            }
            const caps = handle.getCapabilities?.();
            try {
                if (caps?.logging && handle.setLoggingLevel) {
                    await settleMcpOperation((requestSignal) => handle.setLoggingLevel(requestSignal, timeoutMs), openSignal, binding?.sessionSignal, handle.getPeerSignal?.(), timeoutMs, deps.sleep);
                }
                const operations = [];
                if (caps?.resources)
                    operations.push("list_resources", "list_resource_templates", "read_resource");
                if (caps?.resources?.subscribe)
                    operations.push("subscribe_resource", "unsubscribe_resource");
                if (caps?.prompts)
                    operations.push("list_prompts", "get_prompt");
                if (caps?.completions)
                    operations.push("complete");
                for (const operation of operations)
                    tools.push(makeSynthetic(state, operation));
                const initial = caps?.tools
                    ? await enumerate(state, openSignal)
                    : { tools: [], pages: [] };
                if (state.peerDead || handle.getPeerSignal?.().aborted) {
                    throw new McpOperationTerminalError("peer", handle.getPeerSignal?.().reason);
                }
                state.tools = initial.tools;
                state.pages = initial.pages;
            }
            catch (error) {
                if (error instanceof McpOperationTerminalError
                    && (error.terminalCause === "lifecycle" || error.terminalCause === "session")) {
                    throw error.terminalReason;
                }
                if (openSignal.aborted)
                    throw openSignal.reason;
                await skipServer(server, state, handle);
                continue;
            }
        }
        // Keep the initialization window bridge-wide. Once every configured server has completed its
        // first catalog, snapshot the dirty set and close that window for all servers. Notifications
        // accepted while these coalesced passes run become ordinary post-open dirty work and therefore do
        // not create an unbounded open-time quiescence loop.
        const initialStates = states.filter(state => state.initializing);
        const initialDirty = initialStates.filter((state) => state.dirty);
        for (const state of initialStates)
            state.initializing = false;
        for (const state of initialDirty) {
            state.dirty = false;
            try {
                const refreshed = state.handle.getCapabilities?.()?.tools
                    ? await enumerate(state, openSignal)
                    : { tools: [], pages: [] };
                state.tools = refreshed.tools;
                state.pages = refreshed.pages;
            }
            catch (error) {
                if (error instanceof McpOperationTerminalError
                    && (error.terminalCause === "lifecycle" || error.terminalCause === "session")) {
                    throw error.terminalReason;
                }
                if (openSignal.aborted)
                    throw openSignal.reason;
                binding?.emitDiagnostic(`[mcp:${state.token}] tools/list refresh failed`);
            }
            if (state.peerDead || state.handle.getPeerSignal?.().aborted) {
                await skipServer(state.server, state, state.handle);
            }
        }
        // Every capability-conditioned synthetic reservation precedes every remote tool reservation.
        for (const state of initialStates.filter(state => !state.disabled)) {
            try {
                for (const remote of state.tools) {
                    const alias = allocateAlias(state.token, remote.name, usedAliases);
                    state.aliases.set(remote.name, alias);
                    aliases.push(alias);
                    aliasServers.set(alias, state.server.name);
                    state.validAliases.add(alias);
                    if (remote.outputSchema)
                        state.validators.set(alias, state.validatorProvider.getValidator(remote.outputSchema));
                    tools.push(remoteDefinition(state, remote, alias));
                }
                reportStatus(state.server, "connected", state.tools.length);
            }
            catch {
                await skipServer(state.server, state, state.handle);
            }
        }
    }
    catch (error) {
        const rollback = acquiredHandles.slice(acquiredStart);
        for (const state of [...states]) if (rollback.includes(state.handle)) await skipServer(state.server, state, state.handle, false);
        await closeClients(rollback, deps);
        acquiredHandles.splice(acquiredStart);
        throw error;
    }
    };
    try {await connectServers(servers, openSignal);}
    catch (error) {await statusSink?.close(); throw error;}
// Eido MCP registry v1
    const fixedNames = new Set(servers.filter(server => !server[Symbol.for("eido.pi.mcp.options")]).map(server => server.name));
    const fingerprint = server => {
        const options = server[Symbol.for("eido.pi.mcp.options")];
        return JSON.stringify([server, options?.config, options?.autoEnableCodemode, options?.cwd, options?.unresolved, options?.origin, options?.extensionPath]);
    };
    const managed = new Map(servers.filter(server => !fixedNames.has(server.name)).map(server => [server.name, fingerprint(server)]));
    const resolveRegistered = deps.connectMcpClient[Symbol.for("eido.pi.mcp.registered")];
    let registrationRevision = 0;
    let pendingRegistration;
    let registrationController;
    const retire = async state => {
        state.disabled = true;
        state.dirty = false;
        for (const alias of state.validAliases) {
            const definition = piSession?.getToolDefinition(alias) ?? tools.find(tool => tool.name === alias);
            if (definition) extensionApi?.registerTool({ ...definition, exposure: "hidden" });
        }
        for (const alias of [...state.syntheticAliases, ...state.aliases.values()]) {
            const toolIndex = tools.findIndex(tool => tool.name === alias);
            if (toolIndex >= 0) tools.splice(toolIndex, 1);
            const aliasIndex = aliases.indexOf(alias);
            if (aliasIndex >= 0) aliases.splice(aliasIndex, 1);
            usedAliases.delete(alias);
            aliasServers.delete(alias);
        }
        state.validAliases.clear();
        states.splice(states.indexOf(state), 1);
        await closeClients([state.handle], deps);
        const acquiredIndex = acquiredHandles.indexOf(state.handle);
        if (acquiredIndex >= 0) acquiredHandles.splice(acquiredIndex, 1);
    };
    const reconcileRegistrations = async (registrations, signal, revision, retry = false) => {
        if (!resolveRegistered || closing) return;
        let next;
        try {next = (await resolveRegistered(binding?.cwd, registrations)).filter(server => !fixedNames.has(server.name));}
        catch {pendingDiagnostics.push("MCP configuration could not be loaded. Check Extensions > MCP; existing connections were kept.\n"); return;}
        if (closing || signal.aborted || revision !== registrationRevision) return;
        const wanted = new Map(next.map(server => [server.name, fingerprint(server)]));
        for (const name of statusRows.keys()) if (!wanted.has(name) && !fixedNames.has(name)) statusRows.delete(name);
        publishStatus();
        for (const state of [...states]) {
            if (managed.has(state.server.name) && (state.disabled || state.peerDead || wanted.get(state.server.name) !== managed.get(state.server.name))) await retire(state);
        }
        const add = next.filter(server => !states.some(state => state.server.name === server.name) && (retry || managed.get(server.name) !== wanted.get(server.name)));
        managed.clear();
        for (const [name, value] of wanted) managed.set(name, value);
        const previousTools = new Set(tools.map(tool => tool.name));
        await connectServers(add, signal);
        if (closing || signal.aborted) return;
        for (const tool of tools) if (!previousTools.has(tool.name)) extensionApi?.registerTool(tool);
    };
    const scheduleRegistrations = registrations => {
        registrationController?.abort(new Error("MCP registration superseded"));
        pendingRegistration = { registrations, revision: ++registrationRevision };
        if (closing || refreshPaused) return;
        refreshQueue = refreshQueue.then(async () => {
            if (closing || refreshPaused || !pendingRegistration) return;
            const next = pendingRegistration;
            const release = await acquireTurnBoundary();
            const controller = new AbortController();
            try {
                if (closing || refreshPaused || next !== pendingRegistration) return;
                registrationController = controller;
                await reconcileRegistrations(next.registrations, AbortSignal.any([refreshController.signal, controller.signal]), next.revision, true);
                if (next === pendingRegistration) pendingRegistration = undefined;
            } finally {if (registrationController === controller) registrationController = undefined; release();}
        }).catch(error => {
            if (!closing && !refreshPaused) binding?.emitDiagnostic("MCP registration update failed; reload the task to retry.\n");
        });
    };
    const inlineExtension = {
        name: "agentprism-pi-acp-mcp",
        factory(api) {
            extensionApi = api;
            api.on("mcp_servers_change", event => { scheduleRegistrations(event.servers); });
            api.on("session_start", () => { if (piSession) scheduleRegistrations(api.getMcpServers()); });
            for (const tool of tools)
                api.registerTool(tool);
        },
    };
    const instructionsExtension = {
        name: "agentprism-pi-acp-control",
        factory(api) {
            api.on("before_agent_start", (event) => {
                for (const text of pendingDiagnostics.splice(0)) binding?.emitDiagnostic(text);
                const suffix = states
                    .filter((state) => !state.disabled && !state.peerDead && [...state.validAliases].some(alias => piSession?.getActiveToolNames().includes(alias)))
                    .map((state) => ({ token: state.token, instructions: state.handle.getInstructions?.() }))
                    .filter((item) => Boolean(item.instructions))
                    .map((item) => `\n\n# MCP server instructions (${item.token})\n${item.instructions}`)
                    .join("");
                return suffix ? { systemPrompt: `${event.systemPrompt}${suffix}` } : undefined;
            });
        },
    };
    let physicalCloses;
    let closePromise;
    const startDisposal = () => {
        void statusSink?.close();
        if (!closing)
            closing = true;
        physicalCloses ??= closeClients(states.map(({ handle }) => handle), deps);
        physicalCloses.catch(() => undefined);
    };
    const abortRefreshes = () => {
        refreshPaused = true;
        if (!refreshController.signal.aborted)
            refreshController.abort(new Error("MCP refresh aborted"));
    };
    return {
        clients: states.map(({ handle }) => handle),
        tools,
        aliases,
        aliasServers,
        failedResults,
        inlineExtension,
        instructionsExtension,
        async initializeRegistrations() {
            await reconcileRegistrations(extensionApi?.getMcpServers() ?? [], openSignal, registrationRevision);
        },
        bindSession(session) {
            assertReady();
            piSession = session;
            scheduleRefreshes();
        },
        assertReady,
        async acquireTurnBoundary() {
            while (pendingRegistration && !closing && !refreshPaused) {
                const pending = refreshQueue;
                await pending;
                if (refreshQueue === pending) break;
            }
            return acquireTurnBoundary();
        },
        startDisposal,
        abortRefreshes,
        resumeRefreshes() {
            if (closing || !refreshPaused)
                return;
            refreshController = new AbortController();
            refreshPaused = false;
            if (pendingRegistration) scheduleRegistrations(pendingRegistration.registrations);
            scheduleRefreshes();
        },
        drainRefreshes: () => refreshQueue,
        close() {
            startDisposal();
            abortRefreshes();
            closePromise ??= (async () => {
                await refreshQueue.catch(() => undefined);
                const release = await acquireTurnBoundary();
                release();
                await physicalCloses;
                await statusSink?.close();
            })();
            return closePromise;
        },
    };
}
async function closeClients(clients, deps) {
    const closes = [...clients].reverse().map((client) => {
        let close;
        try {
            // Invocation itself is part of the synchronous logical-close prefix.
            close = client.close();
        }
        catch {
            return Promise.resolve();
        }
        close.catch(() => undefined);
        return client.closeIsBounded
            ? close.catch(() => undefined)
            : bounded(close, NEVER_ABORTED, deps.mcpTimeoutMs, deps.sleep).catch(() => undefined);
    });
    await Promise.allSettled(closes);
}
export async function disposeMcpBridge(clients, deps) {
    await closeClients(clients, deps);
}
