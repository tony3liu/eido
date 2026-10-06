import type { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
/** pi does not export its loader options type; derive it from the constructor. */
type DefaultResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];
/** The bare session `_meta` key (the same key claude-agent-acp reads, so clients that switch
 *  between the two servers keep one wire shape). */
export declare const SYSTEM_PROMPT_META_KEY = "systemPrompt";
/** What the server advertises under `InitializeResponse._meta.systemPrompt`. */
export declare const SYSTEM_PROMPT_ADVERTISEMENT: Readonly<{
    replace: true;
    append: true;
}>;
export interface SystemPromptOverrides {
    /** Replaces pi's built-in system prompt (pi's custom-prompt slot). */
    replace?: string;
    /** Appended after pi's built-in (or replaced) prompt and the operator's append entries. */
    append?: string;
}
/**
 * Read `_meta.systemPrompt` off a session request. A string replaces the prompt; an object carries
 * `replace` and/or `append`. Returns undefined when the key is absent or asks for nothing, and
 * rejects malformed values with `invalid_system_prompt` (`-32602`) BEFORE any session state is
 * created — an unusable instruction must fail loudly, never run under the default prompt.
 */
export declare function readSystemPromptMeta(meta: unknown): SystemPromptOverrides | undefined;
/** The `DefaultResourceLoader` override hooks that realize the instructions; empty when none. */
export declare function systemPromptLoaderOverrides(overrides: SystemPromptOverrides | undefined): Pick<DefaultResourceLoaderOptions, "systemPromptOverride" | "appendSystemPromptOverride">;
export {};
//# sourceMappingURL=system-prompt.d.ts.map