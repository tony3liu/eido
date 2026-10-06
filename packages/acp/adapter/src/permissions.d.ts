import { type AgentContext } from "@agentclientprotocol/sdk";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
interface PermissionHost {
    readonly sessionId: string;
    readonly client: AgentContext;
    drain(): Promise<void>;
    turnSignal(): AbortSignal | undefined;
}
export declare function installPermissionWrapper(session: AgentSession, host: PermissionHost): void;
export {};
//# sourceMappingURL=permissions.d.ts.map