export declare const TURN_RECORD: "eido.turn.v1";
export interface TurnState {
    version: number;
    id?: string;
    status: "idle" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
}
export declare function savedTurnState(entries: readonly unknown[]): TurnState;
export declare function terminalTurnStatus(outcome: {response: {stopReason: string}} | {error: unknown}): TurnState["status"];
