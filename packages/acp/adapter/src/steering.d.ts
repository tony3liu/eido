import { type ContentBlock, type PromptRequest } from "@agentclientprotocol/sdk";
export declare const SESSION_STEERING_METHOD: "_session/steering";
export interface SteeringRequest {
    sessionId: string;
    prompt: ContentBlock[];
    _meta?: PromptRequest["_meta"];
}
export type SteeringResponse = {
    outcome: "injected";
} | {
    outcome: "promptRequired";
    reason: "noRunningTurn";
};
/** Runtime parser used by the ACP SDK's custom-request overload. */
export declare const steeringRequestParser: {
    parse(value: unknown): SteeringRequest;
};
//# sourceMappingURL=steering.d.ts.map