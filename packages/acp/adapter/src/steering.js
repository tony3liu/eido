// Adapted for Eido from @automatalabs/pi-acp 0.9.4 (Apache-2.0). See ../LICENSE.
import { RequestError, } from "@agentclientprotocol/sdk";
export const SESSION_STEERING_METHOD = "_session/steering";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isContentBlock(value) {
    if (!isRecord(value) || typeof value.type !== "string")
        return false;
    switch (value.type) {
        case "text":
            return typeof value.text === "string";
        case "image":
        case "audio":
            return typeof value.data === "string" && typeof value.mimeType === "string";
        case "resource_link":
            return typeof value.uri === "string" && typeof value.name === "string";
        case "resource": {
            const resource = value.resource;
            return isRecord(resource)
                && typeof resource.uri === "string"
                && (typeof resource.text === "string" || typeof resource.blob === "string");
        }
        default:
            return false;
    }
}
/** Runtime parser used by the ACP SDK's custom-request overload. */
export const steeringRequestParser = {
    parse(value) {
        if (!isRecord(value)
            || typeof value.sessionId !== "string"
            || !Array.isArray(value.prompt)
            || !value.prompt.every(isContentBlock)
            || (value._meta !== undefined
                && value._meta !== null
                && !isRecord(value._meta))) {
            throw RequestError.invalidParams(undefined, "invalid _session/steering request");
        }
        return value;
    },
};
