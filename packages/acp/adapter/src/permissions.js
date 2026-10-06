// Adapted for Eido from @automatalabs/pi-acp 0.9.4 (Apache-2.0). See ../LICENSE.
import { methods } from "@agentclientprotocol/sdk";
import { mapKind } from "./translate.js";
function raceSignal(promise, signal) {
    promise.then(() => undefined, () => undefined);
    if (signal.aborted)
        return Promise.resolve(undefined);
    return Promise.race([
        promise,
        new Promise((resolve) => {
            signal.addEventListener("abort", () => resolve(undefined), { once: true });
        }),
    ]);
}
export function installPermissionWrapper(session, host) {
    const alwaysAllowed = new Set();
    session[Symbol.for("eido.pi.permission")] = async (event, signal) => {
        const toolName = event.toolName;
        let block = false;
        let reason;
        if (!alwaysAllowed.has(toolName)) {
            await host.drain();
            const turnSignal = host.turnSignal() ?? signal ?? new AbortController().signal;
            try {
                const pending = host.client.request(methods.client.session.requestPermission, {
                    sessionId: host.sessionId,
                    toolCall: {
                        toolCallId: event.toolCallId,
                        title: toolName,
                        kind: mapKind(toolName),
                        _meta: { toolName, ...(event.parentToolCallId ? {parentToolCallId:event.parentToolCallId} : {}) },
                    },
                    options: [
                        { optionId: "allow_always", name: `Always allow ${toolName}`, kind: "allow_always" },
                        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
                        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
                    ],
                }, { cancellationSignal: turnSignal });
                const response = await raceSignal(pending, turnSignal);
                if (response === undefined) {
                    block = true;
                    reason = "cancelled";
                }
                else if (typeof response.outcome !== "object" || response.outcome === null || !("outcome" in response.outcome)) {
                    block = true;
                    reason = "unrecognized permission selection";
                }
                else if (response.outcome.outcome === "cancelled") {
                    block = true;
                    reason = "cancelled";
                }
                else if (response.outcome.optionId === "allow_once") {
                    block = false;
                }
                else if (response.outcome.optionId === "allow_always") {
                    alwaysAllowed.add(toolName);
                    block = false;
                }
                else if (response.outcome.optionId === "reject_once") {
                    block = true;
                    reason = "denied by user";
                }
                else {
                    block = true;
                    reason = "unrecognized permission selection";
                }
            }
            catch {
                block = true;
                reason = "permission unavailable";
            }
        }
        if (block)
            return { block: true, reason };
        return undefined;
    };
}
