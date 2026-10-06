import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { type AgentSession, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
export type ThinkingLevel = ModelThinkingLevel;
/** Additive ACP metadata understood by AgentPrism's generic config validator. */
export declare const CONFIG_OPTION_META_NAMESPACE = "@automatalabs/agentprism";
export declare const MODEL_DISCOVERY_META_KEY = "@automatalabs/agentprism.modelDiscovery";
export interface ModelDiscoveryPreferences {
    source: "enabledModels";
    preferred: string[];
    unmatched: string[];
}
export declare function modelDiscoveryPreferences(enabledModels: string[] | undefined, availableModels: readonly Model<Api>[]): Promise<ModelDiscoveryPreferences | undefined>;
/**
 * Pi's complete, ordered domain, derived once from pi's own model-aware helper.
 * This is intentionally not a hardcoded mirror of pi's module-private ladder.
 */
export declare const RECOGNIZED_THINKING_LEVELS: readonly ModelThinkingLevel[];
export declare function thinkingLevelOption(session: AgentSession): SessionConfigOption;
export declare function modelOption(session: AgentSession, availableModels: readonly Model<Api>[], preferences?: ModelDiscoveryPreferences): SessionConfigOption;
export declare function applyConfig(session: AgentSession, modelRuntime: ModelRuntime, _availableModels: readonly Model<Api>[], configId: string, value: string | boolean, enabledModels?: string[]): Promise<{
    configOptions: SessionConfigOption[];
    availableModels: readonly Model<Api>[];
    preferences: ModelDiscoveryPreferences | undefined;
}>;
//# sourceMappingURL=config.d.ts.map