// Adapted for Eido from @automatalabs/pi-acp 0.9.4 (Apache-2.0). See ../LICENSE.
import { adapterError } from "./errors.js";
export function convertPromptContent(blocks) {
    const text = [];
    const images = [];
    for (const block of blocks) {
        switch (block.type) {
            case "text":
                text.push(block.text);
                break;
            case "image":
                images.push({ type: "image", data: block.data, mimeType: block.mimeType });
                break;
            case "resource_link":
                text.push(`[${block.title ?? block.name ?? block.uri}](${block.uri})`);
                break;
            case "resource":
                text.push("text" in block.resource
                    ? block.resource.text
                    : `[embedded resource: ${block.resource.uri}]`);
                break;
            case "audio":
                text.push("[unsupported audio content omitted]");
                break;
            default: {
                const exhaustive = block;
                return exhaustive;
            }
        }
    }
    const joined = text.join("\n\n");
    if (!text.some((segment) => segment.length > 0) && images.length === 0) {
        throw adapterError("empty_prompt");
    }
    return { text: joined, images };
}
