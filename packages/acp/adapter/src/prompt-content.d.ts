import type { ContentBlock } from "@agentclientprotocol/sdk";
export interface PiImage {
    type: "image";
    data: string;
    mimeType: string;
}
export interface ConvertedPrompt {
    text: string;
    images: PiImage[];
}
export declare function convertPromptContent(blocks: readonly ContentBlock[]): ConvertedPrompt;
//# sourceMappingURL=prompt-content.d.ts.map