import type { AvailableCommand, SessionConfigOption, SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

// The audited adapter hook runs inside its existing turn boundary. Commands
// share admission, cancellation and notification ordering with ordinary prompts.
export const PI_COMMAND_BRIDGE = Symbol.for("eido.pi.commands");
export const PI_COMMAND_RECORD = "eido.command.v1";
export const piCommands: AvailableCommand[] = [
  { name: "session", description: "Show pi session details, context and usage" },
  { name: "name", description: "Show or change this task's name", input: { hint: "[name]" } },
  { name: "model", description: "List models or select a model for this task", input: { hint: "[provider/model]" } },
  { name: "thinking", description: "Show or set this task's thinking level", input: { hint: "[level]" } },
  { name: "compact", description: "Compact context with pi; uses the current model", input: { hint: "[instructions]" } },
];

interface CommandContext {
  enqueue(update: SessionUpdate): void;
  configOptions(): SessionConfigOption[];
  applyConfigAtBoundary(id: string, value: string): Promise<SessionConfigOption[]>;
  activeTurnSignal(): AbortSignal | undefined;
}

function values(option: SessionConfigOption | undefined): {value: string; name: string}[] {
  if (!option || option.type !== "select") return [];
  return option.options.flatMap(item => "options" in item ? item.options : [item]);
}

function sessionInfo(pi: AgentSession): string {
  const stats = pi.getSessionStats();
  const usage = stats.contextUsage;
  return [
    "**pi session**",
    `Name: ${pi.sessionName ?? "Untitled"}`,
    `ID: ${stats.sessionId}`,
    `Model: ${pi.model ? `${pi.model.provider}/${pi.model.id}` : "None"}`,
    `Thinking: ${pi.thinkingLevel}`,
    `Messages: ${stats.userMessages} user, ${stats.assistantMessages} assistant`,
    `Tools: ${stats.toolCalls} calls, ${stats.toolResults} results`,
    `Context: ${usage?.tokens == null ? "Unknown" : usage.tokens.toLocaleString()} / ${usage?.contextWindow.toLocaleString() ?? "Unknown"} tokens`,
    `Tokens: ${stats.tokens.total.toLocaleString()} total (${stats.tokens.input} input, ${stats.tokens.output} output, ${stats.tokens.cacheRead} cache read, ${stats.tokens.cacheWrite} cache write)`,
    `Cost: $${stats.cost.toFixed(4)}`,
  ].join("\n\n");
}

export function installPiCommands(pi: AgentSession) {
  const bridge = {
    commands: piCommands,
    async run(text: string, images: unknown[] | undefined, context: CommandContext): Promise<boolean> {
      if (!text.trimStart().startsWith("/")) return false;
      const match = /^\s*\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
      const name = match?.[1] ?? "";
      const argument = match?.[2]?.trim() ?? "";
      const signal = context.activeTurnSignal();
      const record = (output: string, status: "completed" | "failed" | "cancelled") => {
        // Custom entries are excluded from the model projection. Local command
        // history survives reload without creating fake user/assistant turns.
        pi.sessionManager.appendCustomEntry(PI_COMMAND_RECORD, { command: text.trim(), output, status });
        context.enqueue({ sessionUpdate: "agent_message_chunk", content: {type: "text", text: output} });
      };
      try {
        signal?.throwIfAborted();
        if (images?.length) throw new Error("Slash commands do not accept image attachments. Remove the attachment and retry.");
        if (!piCommands.some(command => command.name === name)) {
          throw new Error(`/${name || "…"} is not available in Eido yet. Supported commands: ${piCommands.map(command => `/${command.name}`).join(", ")}.`);
        }
        let output: string;
        switch (name) {
          case "session":
            if (argument) throw new Error("Usage: /session (no arguments).");
            output = sessionInfo(pi);
            break;
          case "name":
            if (argument) {
              if (argument.length > 256 || /[\r\n]/.test(argument)) throw new Error("Use a single-line name of at most 256 characters.");
              pi.setSessionName(argument);
              context.enqueue({sessionUpdate: "session_info_update", title: pi.sessionName ?? argument});
            }
            output = pi.sessionName ? `Session name: ${pi.sessionName}` : "This task has no name yet. Use /name <name>.";
            break;
          case "model":
          case "thinking": {
            const id = name === "model" ? "model" : "thinkingLevel";
            const option = context.configOptions().find(option => option.id === id);
            const choices = values(option);
            if (!argument) {
              output = `${name === "model" ? "Model" : "Thinking level"}: ${option?.currentValue || "None"}\n\n`
                + (choices.length ? choices.map(choice => `- ${choice.value}`).join("\n") : "No configured models are available. Open pi Models & Credentials in settings.")
                + `\n\nUse /${name} <${name === "model" ? "provider/model" : "level"}> or the selector beside the composer. This changes the current task; global defaults stay in settings.`;
            } else {
              const value = name === "thinking" ? argument.toLowerCase() : argument;
              if (!choices.some(choice => choice.value === value)) throw new Error(`Unknown ${name === "model" ? "model" : "thinking level"}: ${argument}. Run /${name} to see available values.`);
              signal?.throwIfAborted();
              const configOptions = await context.applyConfigAtBoundary(id, value);
              context.enqueue({sessionUpdate: "config_option_update", configOptions});
              output = `${name === "model" ? "Model" : "Thinking level"}: ${configOptions.find(option => option.id === id)?.currentValue}`;
            }
            break;
          }
          case "compact": {
            context.enqueue({sessionUpdate: "agent_thought_chunk", content: {type: "text", text: "Compacting context with pi…\n"}});
            // pi.compact() begins by awaiting abort(). Wire cancellation again at
            // compaction_start so cancellation in that gap cannot escape it.
            const cancel = () => pi.abortCompaction();
            signal?.addEventListener("abort", cancel, {once: true});
            const unsubscribe = pi.subscribe(event => {
              if (event.type === "compaction_start" && signal?.aborted) cancel();
            });
            try {
              const result = await pi.compact(argument || undefined);
              signal?.throwIfAborted();
              output = `Context compacted: ${result.tokensBefore.toLocaleString()} → ${result.estimatedTokensAfter?.toLocaleString() ?? "unknown"} estimated tokens.\n\n${result.summary}`;
            } finally {
              unsubscribe();
              signal?.removeEventListener("abort", cancel);
            }
            break;
          }
          default: throw new Error("Unsupported command.");
        }
        record(output, "completed");
      } catch (error) {
        if (signal?.aborted) {
          record(`/${name} cancelled.`, "cancelled");
          throw error;
        }
        record(`Command failed: ${error instanceof Error ? error.message : String(error)}`, "failed");
      }
      return true;
    },
  };
  Object.defineProperty(pi, PI_COMMAND_BRIDGE, {value: bridge});
}
