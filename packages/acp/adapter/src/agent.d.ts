import type { AgentNotificationContext, AgentRequestContext, AuthenticateRequest, CloseSessionRequest, ForkSessionRequest, InitializeRequest, ListSessionsRequest, LoadSessionRequest, NewSessionRequest, PromptRequest, ResumeSessionRequest, SetSessionConfigOptionRequest } from "@agentclientprotocol/sdk";
import type { PiAcpDeps } from "./deps.js";
import type { SteeringRequest, SteeringResponse } from "./steering.js";
import type { LoadedTurnQueryRequest, LoadedTurnStatus } from "./loaded-turn.js";
export { PKG_VERSION } from "./version.js";
export declare class PiAcpAgent {
    private readonly deps;
    private readonly live;
    private readonly opening;
    private readonly openingControllers;
    private readonly openingTasks;
    private readonly tombstones;
    private readonly cleanupRecords;
    private readonly mcpOwnerToken;
    private disposed;
    private disposePromise;
    private disposeSucceeded;
    constructor(deps: PiAcpDeps);
    initialize(_context: AgentRequestContext<InitializeRequest>): {
        protocolVersion: number;
        agentInfo: {
            name: string;
            title: string;
            version: string;
        };
        agentCapabilities: {
            loadSession: boolean;
            promptCapabilities: {
                image: boolean;
            };
            mcpCapabilities: {
                http: boolean;
                sse: boolean;
            };
            sessionCapabilities: {
                resume: {};
                fork: {};
                list: {};
                close: {};
                delete: {};
            };
        };
        authMethods: import("@agentclientprotocol/sdk").AuthMethod[];
        _meta: {
            steering: {
                supported: boolean;
            };
            loadedTurn: {
                supported: boolean;
            };
            systemPrompt: {
                replace: true;
                append: true;
            };
        };
    };
    authenticate(context: AgentRequestContext<AuthenticateRequest>): Record<string, never>;
    private ensureMayOpen;
    private reserve;
    private beginOpening;
    private track;
    private gate;
    private connectMcp;
    private construct;
    private openingError;
    newSession(context: AgentRequestContext<NewSessionRequest>): Promise<{
        sessionId: string;
        configOptions: import("@agentclientprotocol/sdk").SessionConfigOption[];
        modes: null;
    }>;
    private reattach;
    loadSession(context: AgentRequestContext<LoadSessionRequest>): Promise<{
        configOptions: import("@agentclientprotocol/sdk").SessionConfigOption[];
        modes: null;
    }>;
    resumeSession(context: AgentRequestContext<ResumeSessionRequest>): Promise<{
        configOptions: import("@agentclientprotocol/sdk").SessionConfigOption[];
        modes: null;
    }>;
    forkSession(context: AgentRequestContext<ForkSessionRequest>): Promise<{
        sessionId: string;
        configOptions: import("@agentclientprotocol/sdk").SessionConfigOption[];
        modes: null;
    }>;
    listSessions(context: AgentRequestContext<ListSessionsRequest>): Promise<{
        nextCursor?: string | undefined;
        sessions: {
            sessionId: string;
            cwd: string;
            title: string;
        }[];
    }>;
    deleteSession(context: AgentRequestContext<import("@agentclientprotocol/sdk").DeleteSessionRequest>): Promise<{}>;
    closeSession(context: AgentRequestContext<CloseSessionRequest>): Promise<{}>;
    private requireLive;
    setConfigOption(context: AgentRequestContext<SetSessionConfigOptionRequest>): Promise<{
        configOptions: import("@agentclientprotocol/sdk").SessionConfigOption[];
    }>;
    prompt(context: AgentRequestContext<PromptRequest>): Promise<import("@agentclientprotocol/sdk").PromptResponse>;
    steer(context: AgentRequestContext<SteeringRequest>): Promise<SteeringResponse>;
    /** `_session/loaded_turn/query` (see `src/loaded-turn.ts`): the loaded
     *  session's authoritative founding-turn terminal classification. */
    loadedTurnQuery(context: AgentRequestContext<LoadedTurnQueryRequest>): {
        status: LoadedTurnStatus;
    };
    cancel(context: AgentNotificationContext<{
        sessionId: string;
    }>): void;
    private terminateWedged;
    dispose(): Promise<void>;
    private disposeGeneration;
}
//# sourceMappingURL=agent.d.ts.map