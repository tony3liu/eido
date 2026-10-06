import type { PromptResponse, SessionUpdate, Usage } from "@agentclientprotocol/sdk";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
interface PiUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    reasoning?: number;
}
export interface AssistantLike {
    role: "assistant";
    usage: PiUsage;
    stopReason: string;
    errorMessage?: string;
    diagnostics?: Array<{
        type: string;
        timestamp: number;
        error?: {
            name?: string;
            message: string;
            stack?: string;
            code?: string | number;
        };
        details?: unknown;
    }>;
}
export declare function agentMessages(session: AgentSession): unknown[];
export declare function assistantMessages(messages: readonly unknown[]): AssistantLike[];
export declare function terminalAssistant(messages: readonly unknown[]): AssistantLike | undefined;
export declare function promptUsage(messages: readonly unknown[]): Usage;
export declare function usageUpdate(session: AgentSession): SessionUpdate;
export declare function response(stopReason: PromptResponse["stopReason"], messages: readonly unknown[]): PromptResponse;
export {};
//# sourceMappingURL=usage.d.ts.map