import { type AgentContext, type PromptRequest, type PromptResponse, type SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentSession, SessionEntry, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { PiAcpDeps } from "./deps.js";
import type { McpBridge, McpResultProjection } from "./mcp-bridge.js";
import { type ChildProcessRegistrySlot } from "./child-process-registry.js";
import type { SteeringRequest, SteeringResponse } from "./steering.js";
import { type LoadedTurnStatus } from "./loaded-turn.js";
export interface PiSessionOptions {
    sessionId: string;
    session: AgentSession;
    manager: SessionManager;
    client: AgentContext;
    deps: PiAcpDeps;
    mcpBridge: McpBridge;
    failedMcpResults: Map<string, McpResultProjection>;
    availableModels: readonly Model<Api>[];
    settingsManager: SettingsManager;
    childRegistry: ChildProcessRegistrySlot;
    lifecycleController: AbortController;
    onWedged(sessionId: string, session: PiSession, cleanupRetryRequired: boolean): Promise<void>;
}
export declare class PiSession {
    readonly sessionId: string;
    readonly pi: AgentSession;
    readonly manager: SessionManager;
    private readonly client;
    private readonly deps;
    private readonly mcpBridge;
    private readonly failedMcpResults;
    private availableModels;
    private readonly settingsManager;
    private modelPreferences;
    private readonly childRegistry;
    private readonly lifecycleController;
    private readonly onWedged;
    private readonly pending;
    private pump;
    private pumpFailure;
    private stopped;
    private closing;
    private disposed;
    private unsubscribe;
    private activeTurn;
    private steerChain;
    private configReserved;
    private cleanupDirty;
    private cleanupGeneration;
    private resourceDisposePromise;
    private bridgeClosePromise;
    /** The `_session/loaded_turn` extension's watch flag: set when a
     *  `loadedTurnStatus()` query answered `running` (a client is waiting
     *  for that turn's authoritative end), cleared — and the
     *  `_session/loaded_turn/ended` notification sent — when the turn
     *  finishes for any reason (response outcome with its stop reason, or
     *  a failure with its error). */
    private loadedTurnReportedRunning;
    constructor(options: PiSessionOptions);
    get busy(): boolean;
    /**
     * The `_session/loaded_turn/query` answer — the authoritative
     * founding-turn terminal classification for a loaded session (see
     * `packages/pi-acp/src/loaded-turn.ts`):
     *
     * - `running` when a turn is executing in this process right now (the
     *   client then waits for the `_session/loaded_turn/ended` push — the
     *   watch flag is armed here so the turn's finish sends it),
     * - `completed` when the session journal's last message entry is an
     *   assistant message (pi persists every complete LLM message
     *   atomically at `message_end`, so a completed turn always leaves an
     *   assistant leaf and the replay's trailing assistant message is the
     *   turn's FINAL message — authoritative, never a quiet-gap guess),
     * - `interrupted` otherwise (the journal shows an interrupted or
     *   abandoned turn — no turn is running, so re-issue is safe).
     */
    loadedTurnStatus(): LoadedTurnStatus;
    configOptions(): import("@agentclientprotocol/sdk").SessionConfigOption[];
    publishAvailableModels(models: readonly Model<Api>[]): Promise<void>;
    activeTurnSignal(): AbortSignal | undefined;
    emitMcpDiagnostic(text: string): void;
    enqueue(update: SessionUpdate): void;
    private startPump;
    drain(): Promise<void>;
    replay(entries: readonly SessionEntry[]): Promise<void>;
    setConfig(configId: string, value: string | boolean): Promise<import("@agentclientprotocol/sdk").SessionConfigOption[]>;
    private finish;
    private notificationFailure;
    private abortTurn;
    private startDisposal;
    private cleanupTurn;
    private turnError;
    private runTurnTask;
    private cleanupWedged;
    private handlePiResolved;
    private handlePiRejected;
    prompt(params: PromptRequest, requestSignal: AbortSignal): Promise<PromptResponse>;
    /** Open the session's single turn slot and run one pi prompt through the full turn
     *  machinery (turn boundary, cancellation, settlement, usage). Admission is the caller's
     *  job: prompt() rejects while busy. Steering never calls this method. */
    private startTurn;
    /** `_session/steering`: inject only into the live turn. Requests are serialized per
     *  session so concurrent steering calls cannot cross a turn boundary. */
    steer(params: SteeringRequest): Promise<SteeringResponse>;
    private performSteer;
    /** Remove native Pi queue residue at a turn boundary. Nothing left by steering may be
     *  consumed by a later public prompt. Unexpected cleanup failures stay exceptional. */
    private discardOrphanedSteering;
    cancel(): void;
    childCleanupFailure(): void;
    dispose(): Promise<void>;
    disposeAfterCleanupFailure(): Promise<void>;
    get remainingChildren(): number;
    get cleanupRetryRequired(): boolean;
    disposeResources(): Promise<void>;
    poison(): void;
}
//# sourceMappingURL=session.d.ts.map