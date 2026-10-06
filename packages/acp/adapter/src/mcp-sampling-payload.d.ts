import type { CreateMessageRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
type SamplingParams = CreateMessageRequest["params"];
type SamplingRole = "user" | "assistant";
type MediaKind = "image" | "audio";
interface MediaMarker {
    marker: string;
    role: SamplingRole;
    kind: MediaKind;
    mimeType: string;
    data: string;
}
export interface McpSamplingPayload {
    context: Context;
    onPayload(payload: unknown): unknown;
}
/**
 * Build a role-faithful Pi context and a request-local provider-payload rewrite. Media is represented
 * by collision-free markers until Pi has assembled the concrete provider request body.
 */
export declare function createMcpSamplingPayload(params: SamplingParams, model: Model<Api>): McpSamplingPayload;
/** Pure structural codec used by the ten pinned built-in API payload fixtures. */
export declare function rewriteMcpSamplingPayload(payload: unknown, api: Api, media: readonly MediaMarker[]): unknown;
export {};
//# sourceMappingURL=mcp-sampling-payload.d.ts.map