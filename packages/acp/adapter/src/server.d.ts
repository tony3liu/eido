import { type Stream } from "@agentclientprotocol/sdk";
import { PiAcpAgent } from "./agent.js";
import { type PiAcpDeps } from "./deps.js";
export { PiAcpAgent } from "./agent.js";
export interface RunAcpOptions {
    deps?: Partial<PiAcpDeps>;
    stream?: Stream;
}
export declare function runAcp(options?: RunAcpOptions): Promise<{
    connection: import("@agentclientprotocol/sdk").AgentConnection;
    agent: PiAcpAgent;
}>;
//# sourceMappingURL=server.d.ts.map