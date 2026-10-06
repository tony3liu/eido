// Adapted for Eido from @automatalabs/pi-acp 0.9.4 (Apache-2.0). See ../LICENSE.
import { classifyTerminal, unexpectedError } from "./errors.js";
export function stopReasonFor(terminal, aborted) {
    if (aborted || terminal?.stopReason === "aborted")
        return "cancelled";
    switch (terminal?.stopReason) {
        case "stop":
        case "toolUse":
            return "end_turn";
        case "length":
            return "max_tokens";
        case "error":
            throw classifyTerminal(terminal);
        case "pending":
            // pi >=0.83.0 marks still-streaming partials "pending"; a finalized message always carries
            // a real reason. A resolved turn whose terminal message is still "pending" means the
            // stream ended without termination — same diagnostic seam as unknown reasons, but named.
            throw unexpectedError(new Error("pi turn resolved with a still-pending terminal message"), terminal);
        case undefined:
            return "end_turn";
        default:
            throw unexpectedError(new Error("Unknown pi stop reason"), terminal);
    }
}
