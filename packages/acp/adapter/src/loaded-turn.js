// Adapted for Eido from @automatalabs/pi-acp 0.9.4 (Apache-2.0). See ../LICENSE.
import { RequestError } from "@agentclientprotocol/sdk";
/** Loaded-turn settlement evidence from Eido's journal records.
 * Running requires an active in-process turn. Completed requires a successful
 * ACP settlement or an explicit legacy command result. All other states map to
 * interrupted for wire compatibility; interruption never authorizes replay.
 */
export const LOADED_TURN_QUERY_METHOD = "_session/loaded_turn/query";
export const LOADED_TURN_ENDED_METHOD = "_session/loaded_turn/ended";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Runtime parser used by the ACP SDK's custom-request overload. */
export const loadedTurnQueryParser = {
    parse(value) {
        if (!isRecord(value) || typeof value.sessionId !== "string") {
            throw RequestError.invalidParams(undefined, "invalid _session/loaded_turn/query request");
        }
        return value;
    },
};
