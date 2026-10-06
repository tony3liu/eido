import type { ContentBlock, SessionUpdate, ToolCallContent, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
interface PiResult {
    content?: Array<{
        type: "text";
        text: string;
    } | {
        type: "image";
        data: string;
        mimeType: string;
    }>;
    details?: unknown;
}
export declare function mapKind(toolName: string): ToolKind;
export declare function fileLocations(args: unknown): ToolCallLocation[] | undefined;
export declare function contentItems(result: PiResult): ContentBlock[];
export declare function toContent(result: PiResult): ToolCallContent[];
export declare function translateEvent(event: AgentSessionEvent, failedResult?: PiResult): SessionUpdate[];
export {};
//# sourceMappingURL=translate.d.ts.map