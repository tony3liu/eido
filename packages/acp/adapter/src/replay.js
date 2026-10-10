// Adapted for Eido from @automatalabs/pi-acp 0.9.4 (Apache-2.0). See ../LICENSE.
import { mapKind, toContent, toolDurationMeta, fileLocations } from "./translate.js";
function blocks(content) {
    if (typeof content === "string")
        return [{ type: "text", text: content }];
    return (content ?? []).map((item) => item.type === "text"
        ? { type: "text", text: item.text }
        : { type: "image", data: item.data, mimeType: item.mimeType });
}
function bashExecutionToText(message) {
    let text = `Ran \`${message.command ?? ""}\`\n`;
    text += message.output ? `\`\`\`\n${message.output}\n\`\`\`` : "(no output)";
    if (message.cancelled)
        text += "\n\n(command cancelled)";
    else if (message.exitCode !== null && message.exitCode !== undefined && message.exitCode !== 0) {
        text += `\n\nCommand exited with code ${message.exitCode}`;
    }
    if (message.truncated && message.fullOutputPath) {
        text += `\n\n[Output truncated. Full output: ${message.fullOutputPath}]`;
    }
    return text;
}
function replayMessage(message) {
    switch (message.role) {
        case "user":
            return blocks(message.content).map((content) => ({
                sessionUpdate: "user_message_chunk",
                content,
            }));
        case "assistant": {
            const updates = [];
            for (const item of (message.content ?? [])) {
                if (item.type === "text") {
                    updates.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: item.text } });
                }
                else if (item.type === "thinking") {
                    updates.push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: item.thinking } });
                }
                else if (item.type === "toolCall") {
                    updates.push({
                        sessionUpdate: "tool_call",
                        toolCallId: item.id,
                        title: item.name,
                        kind: mapKind(item.name),
                        status: "pending",
                        rawInput: item.arguments,
                        locations: fileLocations(item.arguments),
                        _meta: { toolName: item.name },
                    });
                }
            }
            return updates;
        }
        case "toolResult": {
            const update = {
                sessionUpdate: "tool_call_update",
                toolCallId: message.toolCallId ?? "",
                status: message.isError ? "failed" : "completed",
                content: toContent({ content: message.content }),
                _meta: toolDurationMeta(message.durationMs),
            };
            if (message.details !== undefined)
                update.rawOutput = message.details;
            const nested = (message.nestedCalls?.calls ?? []).flatMap(call => [
                { sessionUpdate: "tool_call", toolCallId: call.id, title: call.name, kind: mapKind(call.name), status: "pending",
                  rawInput: call.arguments, locations: fileLocations(call.arguments), _meta: {toolName:call.name,parentToolCallId:call.id.slice(0,call.id.lastIndexOf('/')) || message.toolCallId} },
                { sessionUpdate: "tool_call_update", toolCallId:call.id, status:call.status === 'ok' ? 'completed' : 'failed',
                  content:[{type:'content',content:{type:'text',text:call.error ?? (call.status === 'ok' ? 'Nested call completed. Detailed output is recorded in the parent tool result.' : 'Nested call was interrupted; no action was replayed.')}}],
                  rawOutput:{durationMs:call.durationMs,argumentsBytes:call.argumentsBytes} }
            ]);
            return [...nested, update];
        }
        case "bashExecution":
            return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: bashExecutionToText(message) } }];
        case "custom":
            return message.display
                ? blocks(message.content).map((content) => ({
                    sessionUpdate: "agent_message_chunk",
                    content,
                }))
                : [];
        case "system":
        case "branchSummary":
        case "compactionSummary":
            return [];
    }
}
export function replayEntry(entry) {
    switch (entry.type) {
        case "message":
            return replayMessage(entry.message).map(update => ["user_message_chunk", "agent_message_chunk", "agent_thought_chunk"].includes(update.sessionUpdate) ? {...update, messageId: entry.id} : update);
        case "custom_message":
            return entry.display
                ? blocks(entry.content).map((content) => ({
                    sessionUpdate: "agent_message_chunk",
                    content,
                }))
                : [];
        case "thinking_level_change":
        case "model_change":
        // Model-attributed spend outside the conversation (prompt-cache warming); it reaches the
        // client through the cost gauge, never as history.
        case "usage":
        // A context edit changes what the model sees of an earlier entry, not the history the user
        // saw: the raw target entry replays as it was written.
        case "context_edit":
        case "compaction":
            return [];
        case "branch_summary":
            return [{sessionUpdate:"agent_message_chunk", messageId:entry.id, content:{type:"text", text:"**Branch summary**\n\n" + entry.summary}}];
        case "custom":
            if (entry.customType === "eido.agents.event.v1" && entry.data?.update) {
                const update = structuredClone(entry.data.update);
                if (update.status === "in_progress" || update.status === "pending") {
                    update.status = "failed";
                    if (update.rawInput?.eidoAgent) {
                        update.rawInput.eidoAgent.state = "Interrupted";
                        update.rawInput.eidoAgent.detail = update.rawInput.eidoAgent.detail.replace(/Running|Queued|Stopping/g, "Interrupted");
                    }
                    update.content = [{type:"content",content:{type:"text",text:"Run interrupted. Continue or retry explicitly; no actions were replayed."}}];
                }
                return [update];
            }
            if (entry.customType === "eido.subagent.v1" && entry.data?.kind === "parent") {
                const child = entry.data;
                return [{ sessionUpdate: "tool_call_update", toolCallId: child.toolCallId, title: child.title, status: "failed", content: [{type:"content", content:{type:"text", text:"Subagent interrupted before its result was recorded."}}], _meta: {subagent_session_info: {session_id: child.childSessionId, message_start_index: 0}} }];
            }
            if (entry.customType === "eido.notice.v1" && typeof entry.data?.text === "string")
                return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n\n" + entry.data.text + "\n\n" } }];
            if (entry.customType === "eido.command.input.v1" && typeof entry.data?.command === "string")
                return [{sessionUpdate:"user_message_chunk", messageId:entry.id, content:{type:"text",text:entry.data.command}}];
            if (entry.customType === "eido.command.result.v1" && typeof entry.data?.output === "string")
                return [{sessionUpdate:"agent_message_chunk", messageId:entry.id, content:{type:"text",text:entry.data.output}}];
            if (entry.customType === "eido.command.v1" && typeof entry.data?.command === "string" && typeof entry.data?.output === "string") {
                return [
                    { sessionUpdate: "user_message_chunk", content: { type: "text", text: entry.data.command } },
                    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: entry.data.output } },
                ];
            }
            return [];
        case "label":
        case "session_info":
            return [];
        default: {
            const exhaustive = entry;
            return exhaustive;
        }
    }
}
