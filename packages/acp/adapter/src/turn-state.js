// Eido-owned turn evidence. pi remains unchanged; only its public journal API is used.
export const TURN_RECORD = "eido.turn.v1";

export function savedTurnState(entries) {
    // Inspect the selected branch, never a result from a sibling branch. Sidecars,
    // usage records and UI notifications do not change a turn's terminal state.
    const boundary = entries.findLastIndex(entry => entry.type === "custom" && entry.customType === TURN_RECORD);
    if (boundary >= 0 && entries[boundary].data?.status === "running") {
        // A pi message or plugin command result is earlier than ACP cleanup and
        // settlement. An unfinished boundary wins over all intermediate results.
        const data = entries[boundary].data;
        return {version: 1, id: typeof data.id === "string" ? data.id : undefined, status: "interrupted"};
    }
    for (const entry of [...entries].reverse()) {
        if (entry.type === "custom" && entry.customType === TURN_RECORD) {
            const data = entry.data;
            if (data?.version !== 1 || typeof data.id !== "string" ||
                !["running", "completed", "cancelled", "failed"].includes(data.status))
                return {version: 1, status: "interrupted"};
            return {...data, status: data.status === "running" ? "interrupted" : data.status};
        }
        if (entry.type === "custom" && ["eido.command.v1", "eido.command.result.v1"].includes(entry.customType)) {
            return {version: 1, id: entry.id, status: entry.data?.status === "completed" ? "completed"
                : entry.data?.status === "cancelled" ? "cancelled" : "failed"};
        }
        if (entry.type === "custom" && entry.customType === "eido.command.input.v1")
            return {version: 1, id: entry.id, status: "interrupted"};
        if (entry.type === "message") {
            // A message can precede tools or cleanup. Legacy history has no ACP
            // settlement evidence; retain failure/cancellation, otherwise unknown.
            const reason = entry.message?.stopReason;
            return {version: 1, id: entry.id, status: reason === "error" ? "failed"
                : reason === "aborted" ? "cancelled" : "interrupted"};
        }
    }
    return {version: 1, status: "idle"};
}

export function terminalTurnStatus(outcome) {
    if (!("response" in outcome)) return "failed";
    return outcome.response.stopReason === "end_turn" ? "completed"
        : outcome.response.stopReason === "cancelled" ? "cancelled" : "failed";
}
