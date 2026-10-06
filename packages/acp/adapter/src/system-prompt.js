// Adapted for Eido from @automatalabs/pi-acp 0.9.4 (Apache-2.0). See ../LICENSE.
import { adapterError } from "./errors.js";
/** The bare session `_meta` key (the same key claude-agent-acp reads, so clients that switch
 *  between the two servers keep one wire shape). */
export const SYSTEM_PROMPT_META_KEY = "systemPrompt";
/** What the server advertises under `InitializeResponse._meta.systemPrompt`. */
export const SYSTEM_PROMPT_ADVERTISEMENT = Object.freeze({ replace: true, append: true });
const FIELDS = ["replace", "append"];
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonBlankString(value, field) {
    if (typeof value !== "string" || value.trim() === "") {
        throw adapterError("invalid_system_prompt", { field });
    }
    return value;
}
/**
 * Read `_meta.systemPrompt` off a session request. A string replaces the prompt; an object carries
 * `replace` and/or `append`. Returns undefined when the key is absent or asks for nothing, and
 * rejects malformed values with `invalid_system_prompt` (`-32602`) BEFORE any session state is
 * created — an unusable instruction must fail loudly, never run under the default prompt.
 */
export function readSystemPromptMeta(meta) {
    if (!isRecord(meta))
        return undefined;
    const value = meta[SYSTEM_PROMPT_META_KEY];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value === "string")
        return { replace: nonBlankString(value, "replace") };
    if (!isRecord(value))
        throw adapterError("invalid_system_prompt", { field: SYSTEM_PROMPT_META_KEY });
    const unknown = Object.keys(value).find((key) => !FIELDS.includes(key));
    if (unknown !== undefined)
        throw adapterError("invalid_system_prompt", { field: unknown });
    const overrides = {};
    for (const field of FIELDS) {
        if (value[field] === undefined)
            continue;
        overrides[field] = nonBlankString(value[field], field);
    }
    return Object.keys(overrides).length > 0 ? overrides : undefined;
}
/** The `DefaultResourceLoader` override hooks that realize the instructions; empty when none. */
export function systemPromptLoaderOverrides(overrides) {
    if (!overrides)
        return {};
    const { replace, append } = overrides;
    return {
        ...(replace !== undefined ? { systemPromptOverride: () => replace } : {}),
        ...(append !== undefined ? { appendSystemPromptOverride: (base) => [...base, append] } : {}),
    };
}
