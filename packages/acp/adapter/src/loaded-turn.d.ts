/**
 * The `_session/loaded_turn` vendor extension — turn-TERMINAL state for
 * loaded sessions (the steering-extension precedent; a re-attaching
 * host's authoritative completion evidence). Advertised at
 * initialize via `_meta.loadedTurn.supported === true`; a client seam
 * against a server without the advertisement degrades guest-visibly
 * (never settles partial output, never re-issues a possibly-running
 * turn).
 *
 * - `_session/loaded_turn/query` — the client asks, right after a
 *   `session/load` response, whether the loaded session's founding turn
 *   is still running RIGHT NOW. pi-acp answers honestly from its own
 *   state: `running` when a turn is executing in this process, otherwise
 *   `completed` when the session journal's last message entry is an
 *   assistant message (the founding turn's final message — pi persists
 *   each complete LLM message atomically at `message_end`, so a
 *   completed turn always leaves an assistant leaf and the replay's
 *   trailing assistant message is authoritative), else `interrupted`
 *   (the journal shows an interrupted/abandoned turn — nothing is
 *   running, so re-issue is safe).
 * - `_session/loaded_turn/ended` — pushed when a turn that the query
 *   classified `running` ends: its ACP stop reason for a response
 *   outcome, or its error. (pi-acp can only report `running` while a
 *   turn is live in-process, and `session/load` rejects sessions that
 *   are already open in-process, so in practice the notification fires
 *   for a turn the client loaded while it was still executing — the
 *   contract is complete for that case.)
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