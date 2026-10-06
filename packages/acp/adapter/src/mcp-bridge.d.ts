import type { AgentContext, McpServer } from "@agentclientprotocol/sdk";
import type { AgentSession, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type CallToolResult, type ContentBlock, type JSONRPCMessage, type MessageExtraInfo, type ServerCapabilities, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { PiAcpDeps } from "./deps.js";
export interface McpSessionBinding {
    sessionId: string;
    cwd: string;
    client: AgentContext;
    sessionSignal: AbortSignal;
    getPi(): AgentSession | undefined;
    getTurnSignal(): AbortSignal | undefined;
    isPublished(): boolean;
    emitDiagnostic(text: string): void;
    /** Adapter-allocated collision-safe token for this configured server. */
    serverToken?: string;
    poison?(server: string): void;
    ownerToken?: object;
    modelRuntime?: PiAcpDeps["modelRuntime"];
}
export interface McpListResult {
    tools: Tool[];
    nextCursor?: string;
    raw?: unknown;
}
export interface McpClientHandle {
    listTools(cursor: string | undefined, signal: AbortSignal, timeoutMs: number): Promise<McpListResult>;
    callTool(name: string, args: unknown, signal: AbortSignal, timeoutMs: number, onprogress?: (progress: unknown) => void): Promise<CallToolResult>;
    close(): Promise<void>;
    ping?(signal: AbortSignal, timeoutMs: number): Promise<void>;
    getCapabilities?(): ServerCapabilities | undefined;
    getInstructions?(): string | undefined;
    setLoggingLevel?(signal: AbortSignal, timeoutMs: number): Promise<void>;
    listResources?(cursor: string | undefined, options: RequestOptions): Promise<unknown>;
    listResourceTemplates?(cursor: string | undefined, options: RequestOptions): Promise<unknown>;
    readResource?(uri: string, options: RequestOptions): Promise<unknown>;
    subscribeResource?(uri: string, options: RequestOptions): Promise<unknown>;
    unsubscribeResource?(uri: string, options: RequestOptions): Promise<unknown>;
    listPrompts?(cursor: string | undefined, options: RequestOptions): Promise<unknown>;
    getPrompt?(name: string, args: Record<string, string> | undefined, options: RequestOptions): Promise<unknown>;
    complete?(params: unknown, options: RequestOptions): Promise<unknown>;
    setToolsChangedHandler?(handler: () => void): void;
    setDisabledHandler?(handler: () => void): void;
    disableOnTimeout?(): void;
    getPeerSignal?(): AbortSignal;
    /** The per-server provider also supplied to this handle's SDK Client. */
    jsonSchemaValidator?: AjvJsonSchemaValidator;
    /** The handle's own close implementation enforces the shared physical deadline. */
    closeIsBounded?: boolean;
}
export declare class McpTimeoutError extends Error {
    constructor();
}
export type McpTerminalCause = "lifecycle" | "session" | "peer" | "timeout";
export declare class McpOperationTerminalError extends Error {
    readonly terminalCause: McpTerminalCause;
    readonly terminalReason?: unknown | undefined;
    constructor(terminalCause: McpTerminalCause, terminalReason?: unknown | undefined);
}
export type McpIncomingTerminalCause = "peer" | "session" | "turn" | "timeout";
export declare class McpIncomingTerminalError extends Error {
    readonly terminalCause: McpIncomingTerminalCause;
    readonly terminalReason?: unknown | undefined;
    constructor(terminalCause: McpIncomingTerminalCause, terminalReason?: unknown | undefined);
}
type McpOperationCommit<T> = {
    status: "fulfilled";
    value: T;
} | {
    status: "rejected";
    reason: unknown;
} | {
    status: "terminal";
    cause: McpTerminalCause;
    reason: unknown;
};
/**
 * One terminal arbiter for every MCP request.  Claims are committed in a
 * microtask so conditions that become observable at the same boundary are
 * resolved by the frozen precedence instead of Promise.race scheduling.
 */
export declare function settleMcpOperation<T>(operation: (requestSignal: AbortSignal) => Promise<T>, lifecycleSignal: AbortSignal | undefined, sessionSignal: AbortSignal | undefined, peerSignal: AbortSignal | undefined, timeoutMs: number, sleep: PiAcpDeps["sleep"], onCommit?: (outcome: McpOperationCommit<T>) => void): Promise<T>;
export declare function bounded<T>(operation: Promise<T> | (() => Promise<T>), signal: AbortSignal, timeoutMs: number, sleep: PiAcpDeps["sleep"]): Promise<T>;
export declare function settleIncomingMcpOperation<T>(operation: (requestSignal: AbortSignal) => Promise<T>, peerSignal: AbortSignal, sessionSignal: AbortSignal, turnSignal: AbortSignal | undefined, timeoutMs: number, sleep: PiAcpDeps["sleep"], onCommit?: (outcome: McpOperationCommit<T>) => void): Promise<T>;
export declare class CloseSignallingTransport implements Transport {
    private readonly raw;
    private readonly terminate;
    private readonly onRawError;
    private readonly onRawClose;
    private readonly timeoutMs;
    private readonly sleep;
    private readonly serverToken;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
    private signalled;
    private closePromise;
    constructor(raw: Transport, terminate: (() => Promise<void>) | undefined, onRawError: (error: Error) => boolean, onRawClose: () => void, timeoutMs: number, sleep: PiAcpDeps["sleep"], serverToken: string);
    get sessionId(): string | undefined;
    setProtocolVersion(version: string): void;
    start(): Promise<void>;
    send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;
    signalClose(): void;
    close(): Promise<void>;
    private closeOwned;
}
export declare function createMcpRootsResult(binding: Pick<McpSessionBinding, "cwd" | "sessionSignal">, progressToken: string | number | undefined, extra: {
    signal: AbortSignal;
    sendNotification(notification: {
        method: "notifications/progress";
        params: {
            progressToken: string | number;
            progress: number;
            total: number;
        };
    }): Promise<void>;
}, onProgressFailure: () => void): {
    roots: {
        uri: string;
        name: string;
    }[];
};
export declare function mapMcpSamplingResult(message: AssistantMessage, stopSequences?: readonly string[]): {
    role: "assistant";
    model: string;
    content: {
        type: "text";
        text: string;
    };
    stopReason: "maxTokens" | "endTurn" | "stopSequence";
};
export declare function connectDefaultMcpClient(server: McpServer, signal: AbortSignal, timeoutMs: number, sleep: PiAcpDeps["sleep"], binding?: McpSessionBinding): Promise<McpClientHandle>;
export declare function allocateAlias(server: string, tool: string, used: Set<string>): string;
export declare function convertMcpContent(content: ContentBlock): {
    type: "text";
    text: string;
} | {
    type: "image";
    data: string;
    mimeType: string;
};
export declare function convertMcpResult(result: CallToolResult): {
    content: ({
        type: "text";
        text: string;
    } | {
        type: "image";
        data: string;
        mimeType: string;
    })[];
    details: {
        [x: string]: unknown;
        content: ({
            type: "text";
            text: string;
            annotations?: {
                audience?: ("user" | "assistant")[] | undefined;
                priority?: number | undefined;
                lastModified?: string | undefined;
            } | undefined;
            _meta?: {
                [x: string]: unknown;
            } | undefined;
        } | {
            type: "image";
            data: string;
            mimeType: string;
            annotations?: {
                audience?: ("user" | "assistant")[] | undefined;
                priority?: number | undefined;
                lastModified?: string | undefined;
            } | undefined;
            _meta?: {
                [x: string]: unknown;
            } | undefined;
        } | {
            type: "audio";
            data: string;
            mimeType: string;
            annotations?: {
                audience?: ("user" | "assistant")[] | undefined;
                priority?: number | undefined;
                lastModified?: string | undefined;
            } | undefined;
            _meta?: {
                [x: string]: unknown;
            } | undefined;
        } | {
            uri: string;
            name: string;
            type: "resource_link";
            description?: string | undefined;
            mimeType?: string | undefined;
            size?: number | undefined;
            annotations?: {
                audience?: ("user" | "assistant")[] | undefined;
                priority?: number | undefined;
                lastModified?: string | undefined;
            } | undefined;
            _meta?: {
                [x: string]: unknown;
            } | undefined;
            icons?: {
                src: string;
                mimeType?: string | undefined;
                sizes?: string[] | undefined;
                theme?: "light" | "dark" | undefined;
            }[] | undefined;
            title?: string | undefined;
        } | {
            type: "resource";
            resource: {
                uri: string;
                text: string;
                mimeType?: string | undefined;
                _meta?: {
                    [x: string]: unknown;
                } | undefined;
            } | {
                uri: string;
                blob: string;
                mimeType?: string | undefined;
                _meta?: {
                    [x: string]: unknown;
                } | undefined;
            };
            annotations?: {
                audience?: ("user" | "assistant")[] | undefined;
                priority?: number | undefined;
                lastModified?: string | undefined;
            } | undefined;
            _meta?: {
                [x: string]: unknown;
            } | undefined;
        })[];
        _meta?: {
            [x: string]: unknown;
            progressToken?: string | number | undefined;
            "io.modelcontextprotocol/related-task"?: {
                taskId: string;
            } | undefined;
        } | undefined;
        structuredContent?: {
            [x: string]: unknown;
        } | undefined;
        isError?: boolean | undefined;
    };
};
export type McpResultProjection = ReturnType<typeof convertMcpResult>;
export interface McpBridge {
    clients: McpClientHandle[];
    tools: ToolDefinition[];
    aliases: string[];
    aliasServers: Map<string, string>;
    failedResults: Map<string, McpResultProjection>;
    inlineExtension: InlineExtension;
    instructionsExtension: InlineExtension;
    bindSession(session: AgentSession): void;
    assertReady(): void;
    acquireTurnBoundary(): Promise<() => void>;
    /** Synchronously start every owned client close without aborting refresh work. */
    startDisposal(): void;
    /** Abort refresh admission/work after transport and session-lifetime close starts. */
    abortRefreshes(): void;
    /** Reopen refresh admission only after a successful cancel-only generation. */
    resumeRefreshes(): void;
    drainRefreshes(): Promise<void>;
    close(): Promise<void>;
}
export declare function bridgeMcpServers(servers: readonly McpServer[], openSignal: AbortSignal, deps: PiAcpDeps, binding?: McpSessionBinding): Promise<McpBridge>;
export declare function disposeMcpBridge(clients: readonly McpClientHandle[], deps: PiAcpDeps): Promise<void>;
export {};
//# sourceMappingURL=mcp-bridge.d.ts.map