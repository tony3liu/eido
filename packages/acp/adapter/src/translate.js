// Adapted for Eido from @automatalabs/pi-acp 0.9.4 (Apache-2.0). See ../LICENSE.
export function mapKind(toolName) {
    switch (toolName) {
        case "read":
        case "ls":
            return "read";
        case "edit":
        case "write":
            return "edit";
        case "bash":
            return "execute";
        case "grep":
        case "find":
            return "search";
        default:
            return "other";
    }
}
export function fileLocations(args) {
    if (typeof args !== "object" || args === null)
        return undefined;
    const path = args.path;
    return typeof path === "string" ? [{ path }] : undefined;
}
export function contentItems(result) {
    return (result.content ?? []).map((item) => item.type === "text"
        ? { type: "text", text: item.text }
        : { type: "image", data: item.data, mimeType: item.mimeType });
}
export function toContent(result) {
    return contentItems(result).map((content) => ({ type: "content", content }));
}
function translateAssistantEvent(event) {
    switch (event.type) {
        case "text_delta":
            return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.delta } }];
        case "thinking_delta":
            return [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.delta } }];
        case "start":
        case "text_start":
        case "text_end":
        case "thinking_start":
        case "thinking_end":
        case "toolcall_start":
        case "toolcall_delta":
        case "toolcall_end":
        case "done":
        case "error":
            return [];
        default: {
            const exhaustive = event;
            return exhaustive;
        }
    }
}
export function translateEvent(event, failedResult) {
    switch (event.type) {
        case "message_update":
            return translateAssistantEvent(event.assistantMessageEvent);
        case "tool_execution_start":
            return [{
                    sessionUpdate: "tool_call",
                    toolCallId: event.toolCallId,
                    title: event.toolName,
                    kind: mapKind(event.toolName),
                    status: "pending",
                    rawInput: event.args,
                    locations: fileLocations(event.args),
                    _meta: { toolName: event.toolName, ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}) },
                }];
        case "tool_execution_update":
            const update = {
                sessionUpdate: "tool_call_update",
                toolCallId: event.toolCallId,
                status: "in_progress",
                content: toContent(event.partialResult),
            };
            const partial = event.partialResult;
            if (partial.details !== undefined)
                update.rawOutput = partial.details;
            return [update];
        case "tool_execution_end": {
            const result = failedResult ?? event.result;
            const update = {
                sessionUpdate: "tool_call_update",
                toolCallId: event.toolCallId,
                status: event.isError ? "failed" : "completed",
                content: toContent(result),
            };
            if (result.details !== undefined)
                update.rawOutput = result.details;
            return [update];
        }
        case "message_end":
            if (event.message.role === "custom" && event.message.display) {
                const content = typeof event.message.content === "string" ? [{ type: "text", text: event.message.content }] : event.message.content ?? [];
                return content.map((item) => ({ sessionUpdate: "agent_message_chunk", content: item }));
            }
            return [];
        case "session_info_changed":
            return [{ sessionUpdate: "session_info_update", title: event.name ?? "" }];
        case "agent_start":
        case "agent_end":
        case "turn_start":
        case "turn_end":
        case "message_start":
        case "agent_settled":
        case "queue_update":
        case "compaction_start":
        case "compaction_end":
        case "entry_appended":
        case "thinking_level_changed":
        case "auto_retry_start":
        case "auto_retry_end":
        case "summarization_retry_scheduled":
        case "summarization_retry_attempt_start":
        case "summarization_retry_finished":
        case "bash_execution_update":
            return [];
        default: {
            const exhaustive = event;
            return exhaustive;
        }
    }
}
