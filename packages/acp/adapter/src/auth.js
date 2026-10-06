// Adapted for Eido from @automatalabs/pi-acp 0.9.4 (Apache-2.0). See ../LICENSE.
import { adapterError } from "./errors.js";
// ACP schema 1.21.0 (`@agentclientprotocol/sdk` 1.4.0) removed the `env_var` auth method variant
// (agentclientprotocol/agent-client-protocol #1796/#2000), so the five provider API-key methods this
// server used to advertise (`anthropic-api-key`, `openai-api-key`, `gemini-api-key`, `xai-api-key`,
// `openrouter-api-key`) no longer have a wire shape. Provider keys stay ambient: pi reads
// ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / XAI_API_KEY / OPENROUTER_API_KEY from the
// spawn environment exactly as before; only the advertisement is gone.
export const AUTH_METHODS = [
    { id: "pi-stored-credentials", name: "pi stored credentials" },
];
const IDS = new Set(AUTH_METHODS.map(({ id }) => id));
export function authenticateMethod(methodId) {
    if (!IDS.has(methodId))
        throw adapterError("unknown_auth_method");
    return {};
}
