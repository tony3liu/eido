/** Loaded-turn settlement evidence from Eido's journal records.
 * Running requires an active in-process turn. Completed requires a successful
 * ACP settlement or an explicit legacy command result. All other states map to
 * interrupted for wire compatibility; interruption never authorizes replay.
 */
export declare const LOADED_TURN_QUERY_METHOD: "_session/loaded_turn/query";
export declare const LOADED_TURN_ENDED_METHOD: "_session/loaded_turn/ended";
export type LoadedTurnStatus = "completed" | "running" | "interrupted";
export interface LoadedTurnQueryRequest {
    sessionId: string;
}
export interface LoadedTurnQueryResponse {
    status: LoadedTurnStatus;
}
export interface LoadedTurnEndedNotification {
    sessionId: string;
    /** The ACP stop-reason vocabulary for a turn that ended with a
     *  response; absent when the turn ended by failing. */
    stopReason?: string;
    /** The turn's error, when it ended by failing (the client then
     *  rejects the founding call instead of settling). */
    error?: {
        name: string;
        message: string;
    };
}
/** Runtime parser used by the ACP SDK's custom-request overload. */
export declare const loadedTurnQueryParser: {
    parse(value: unknown): LoadedTurnQueryRequest;
};
//# sourceMappingURL=loaded-turn.d.ts.map