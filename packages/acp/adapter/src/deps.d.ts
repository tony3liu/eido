import { ModelRuntime, SessionManager, type CreateAgentSessionOptions, type CreateAgentSessionResult, type NewSessionOptions, type SessionInfo } from "@earendil-works/pi-coding-agent";
import type { McpServer } from "@agentclientprotocol/sdk";
import { type McpClientHandle, type McpSessionBinding } from "./mcp-bridge.js";
export interface PiAcpDeps {
    createAgentSession(opts: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
    sessions: {
        create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager;
        open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager;
        forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager;
        list(cwd: string, sessionDir?: string): Promise<SessionInfo[]>;
        listAll(sessionDir?: string): Promise<SessionInfo[]>;
    };
    modelRuntime: ModelRuntime;
    /**
     * Pi's agent directory — the source of the user's settings, extensions, and MCP servers.
     *
     * Defaults to pi's own `getAgentDir()` (`$PI_CODING_AGENT_DIR`, else `~/.pi/agent`), so running
     * the server picks up the operator's real pi configuration exactly as before. It is injectable
     * because `newSession()` reads it BEFORE `createAgentSession`: the settings manager and the
     * resource loader are built from it and the loader then loads (and starts) the user's
     * extensions. A caller that stubs `createAgentSession` alone therefore still gets the ambient
     * configuration and everything it spawns, with no session runtime left to shut any of it down.
     * Tests point this at an isolated directory; production leaves it unset.
     *
     * Optional so the frozen `new PiAcpAgent(deps)` contract (pi-acp spec §4.1) stays source
     * compatible: a hand-built deps object that omits it keeps the previous ambient behaviour.
     * `resolveDeps` always populates it.
     */
    agentDir?: string;
    sessionDir?: string;
    connectMcpClient(server: McpServer, signal: AbortSignal, binding?: McpSessionBinding): Promise<McpClientHandle>;
    sleep(ms: number, signal: AbortSignal): Promise<void>;
    graceMs: number;
    mcpTimeoutMs: number;
}
export declare function realSleep(ms: number, signal: AbortSignal): Promise<void>;
export declare function resolveDeps(partial?: Partial<PiAcpDeps>): Promise<PiAcpDeps>;
//# sourceMappingURL=deps.d.ts.map