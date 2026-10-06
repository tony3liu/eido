import type { AgentSession } from "@earendil-works/pi-coding-agent";
export declare function emitPiSessionShutdown(session: AgentSession): Promise<boolean>;
/** `session_shutdown` then `dispose()` — pi's full teardown, in pi's order. */
export declare function shutdownPiSession(session: AgentSession): Promise<void>;
//# sourceMappingURL=pi-shutdown.d.ts.map