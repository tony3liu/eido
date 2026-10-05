import { methods, type AgentContext, type AvailableCommand, type SessionConfigOption, type SessionUpdate } from "@agentclientprotocol/sdk";
import { resolveModelScopeWithDiagnostics, type AgentSession, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createPiUI } from "./pi-ui.ts";
import { exportPiSession, piChangelog } from "./pi-command-files.ts";
import { manageAgentRoles } from "./agent-roles.ts";
import { nativeUiAction } from "./native-ui.ts";
import { createPiSettings } from "../../../scripts/pi-settings.mjs";
import { shareCommand, bugCommand } from "./pi-sharing.ts";
import { sessionCommand, treeCommand } from "./pi-session-commands.ts";
import { loginPiProvider } from "./pi-auth.ts";
import {basename} from 'node:path';

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
  { name: "reload", description: "Reload global pi extensions, skills, templates and settings" },
  { name: "scoped-models", description: "Configure the global model shortlist", input: {hint: "[patterns | all]"} },
  { name: "export", description: "Export this pi session to HTML or JSONL", input: {hint: "[path.html | path.jsonl]"} },
  { name: "changelog", description: "Show release notes from the bundled pi version" },
  { name: "agents", description: "List, create or edit global agent roles", input: {hint: "[list | new | agent-name]"} },
  { name: "share", description: "Share a reviewed conversation export" },
  { name: "bug", description: "Prepare a report for pi developers", input:{hint:"[description]"} },
  { name: "logout", description: "Remove a provider's global pi credentials", input: {hint: "[provider]"} },
  { name: "login", description: "Sign in using pi provider authentication", input: {hint: "[provider] [api_key | oauth]"} },
  { name: "trust", description: "Choose global Agent Access for all tasks", input: {hint: "[ask | full]"} },
];
const nativeCommands: AvailableCommand[] = [
  {name:"quit", description:"Quit Eido through its normal save and shutdown flow"},
  {name:"tree", description:"Navigate the pi conversation tree", input:{hint:"[entry ID]"}},
  {name:"new", description:"Start a new task"},
  {name:"resume", description:"Resume a pi task", input:{hint:"[session ID]"}},
  {name:"fork", description:"Fork before a previous user message", input:{hint:"[message ID]"}},
  {name:"clone", description:"Clone the current conversation branch"},
  {name:"import", description:"Import a pi JSONL session as a new task", input:{hint:"<path.jsonl>"}},
  {name: "settings", description: "Open global pi settings"},
  {name: "hotkeys", description: "Open Eido keyboard shortcuts"},
  {name: "copy", description: "Copy the last pi assistant response to the clipboard"},
];

interface CommandContext {
  enqueue(update: SessionUpdate): void;
  drain(): Promise<void>;
  historyUpdates(entries: readonly SessionEntry[]): SessionUpdate[];
  configOptions(): SessionConfigOption[];
  applyConfigAtBoundary(id: string, value: string): Promise<SessionConfigOption[]>;
  publishAvailableModels(models: readonly Model<Api>[]): Promise<void>;
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

function commandCatalogue(pi: AgentSession, nativeUi = false): AvailableCommand[] {
  const dynamic = [
    ...pi.extensionRunner.getRegisteredCommands().map(command => ({name: command.invocationName, description: command.description ?? "pi extension command", input: {hint: "[arguments]"}})),
    ...pi.promptTemplates.map(template => ({name: template.name, description: template.description || "pi prompt template", input: {hint: "[arguments]"}})),
    ...(pi.settingsManager.getEnableSkillCommands() ? pi.resourceLoader.getSkills().skills.map(skill => ({name: `skill:${skill.name}`, description: skill.description || "pi skill", input: {hint: "[instructions]"}})) : []),
  ];
  const seen = new Set<string>();
  return [...piCommands, ...(nativeUi ? nativeCommands : []), ...dynamic].filter(command => {
    if (seen.has(command.name)) return false;
    seen.add(command.name);
    return true;
  });
}

export function installPiCommands(pi: AgentSession, client: AgentContext, supportsForms: boolean, agentDir: string, nativeUi = false) {
  const catalogue = () => commandCatalogue(pi, nativeUi);
  const supported = [...piCommands, ...(nativeUi ? nativeCommands : [])];
  let activeContext: CommandContext | undefined;
  const ui = supportsForms ? createPiUI(pi, client, () => activeContext?.activeTurnSignal(), update => {
    if (activeContext) activeContext.enqueue(update);
    else void client.notify(methods.client.session.update, {sessionId: pi.sessionId, update}).catch(error => console.error("pi startup UI notification failed", error));
  }, nativeUi, agentDir, catalogue) : undefined;
  const bind = pi.bindExtensions.bind(pi);
  pi.bindExtensions = options => bind({...options, ...(ui ? {uiContext: ui, mode: "rpc" as const} : {}),
    onError(error) {
      options.onError?.(error);
      const text = `Extension ${basename(error.extensionPath)} (${error.event}): ${error.error}`;
      if (ui) ui.notify(text, 'error');
      else {
        pi.sessionManager.appendCustomEntry('eido.notice.v1', {text});
        const update:SessionUpdate = {sessionUpdate:'agent_message_chunk',content:{type:'text',text:`${text}\n\n`}};
        if (activeContext) activeContext.enqueue(update);
        else void client.notify(methods.client.session.update,{sessionId:pi.sessionId,update}).catch(error=>console.error('Extension error notification failed',error));
      }
    },
  });
  const bridge = {
    get commands() { return catalogue(); },
    async run(text: string, images: unknown[] | undefined, context: CommandContext): Promise<boolean> {
      activeContext = context;
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
        if (!supported.some(command => command.name === name) && catalogue().some(command => command.name === name)) {
          // Preserve pi's own extension dispatch and skill/template expansion.
          return false;
        }
        if (!supported.some(command => command.name === name)) {
          throw new Error(`/${name || "…"} is not available in Eido yet. Supported commands: ${supported.map(command => `/${command.name}`).join(", ")}.`);
        }
        let output: string;
        switch (name) {
          case "share": output = await shareCommand(pi, ui, agentDir, argument, signal); break;
          case "bug": output = await bugCommand(pi, ui, agentDir, argument, signal); break;
          case "quit":
            if (argument) throw new Error("Usage: /quit (no arguments).");
            record("Closing Eido…", "completed");
            await context.drain();
            await nativeUiAction(client, pi.sessionId, "quit", {}, signal);
            return true;
          case "tree": {
            const navigation = await treeCommand(pi, ui, argument, signal);
            record(navigation.output, "completed");
            if (navigation.changed) {
              await context.drain();
              await nativeUiAction(client, pi.sessionId, "replace_transcript", {
                updates: context.historyUpdates(pi.sessionManager.getBranch()), draft: navigation.draft,
              }, signal);
            }
            return true;
          }
          case "new": case "resume": case "fork": case "clone": case "import":
            output = await sessionCommand(pi, client, ui, name, argument, signal);
            break;
          case "settings":
          case "hotkeys":
          case "copy": {
            if (argument) throw new Error(`Usage: /${name} (no arguments).`);
            const text = name === "copy" ? pi.getLastAssistantText() : undefined;
            if (name === "copy" && !text) throw new Error("No pi assistant response to copy yet.");
            await nativeUiAction(client, pi.sessionId, name, text ? {text} : {}, signal);
            output = name === "copy" ? "Copied the last pi assistant response." : name === "settings" ? "Opened global pi settings." : "Opened Eido keyboard shortcuts.";
            break;
          }
          case "trust": {
            const selected = argument || await ui?.select("Agent Access · Global", ["Ask Before Actions", "Full Access"]);
            if (!selected) {output = "Agent Access unchanged. Use /trust ask or /trust full."; break;}
            if (!["ask", "full", "Ask Before Actions", "Full Access"].includes(selected)) throw new Error("Usage: /trust ask or /trust full. Eido supports global access only.");
            const fullAccess = selected === "full" || selected === "Full Access";
            if (fullAccess && !await ui?.confirm("Enable Full Access for all tasks?", "pi will decide tool permissions without asking. This changes the global Agent Access control beside the composer.")) {
              output = "Agent Access unchanged."; break;
            }
            signal?.throwIfAborted();
            await createPiSettings(agentDir).execute({operation: "access", fullAccess});
            if (nativeUi) await nativeUiAction(client, pi.sessionId, "access_changed", {}, signal);
            output = `Global Agent Access: ${fullAccess ? "Full Access" : "Ask Before Actions"}.`;
            break;
          }
          case "logout": {
            const credentials = await pi.modelRuntime.listCredentials({signal});
            const providers = credentials.map(credential => credential.providerId);
            if (!providers.length) {output = "No stored pi provider credentials."; break;}
            const selected = argument || await ui?.select("Remove global provider credentials", providers);
            if (!selected) {output = "Sign-out cancelled."; break;}
            if (!providers.includes(selected)) throw new Error(`No stored credentials for ${selected}.`);
            if (!await ui?.confirm(`Sign out of ${selected}?`, "Remove this provider's global credentials. Other providers and environment credentials are preserved.")) {output = "Sign-out cancelled."; break;}
            signal?.throwIfAborted();
            await pi.modelRuntime.logout(selected, {signal});
            await context.publishAvailableModels(await pi.modelRuntime.getAvailable());
            context.enqueue({sessionUpdate: "config_option_update", configOptions: context.configOptions()});
            output = `Removed global credentials for ${selected}.`;
            break;
          }
          case "login":
            output = await loginPiProvider(pi, client, ui, argument, signal);
            await context.publishAvailableModels(await pi.modelRuntime.getAvailable());
            context.enqueue({sessionUpdate: "config_option_update", configOptions: context.configOptions()});
            break;
          case "agents":
            output = await manageAgentRoles(agentDir, argument, ui, signal);
            break;
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
            let selected = argument;
            if (!selected && ui && choices.length) {
              const value = await ui.select(name === "model" ? "Select a model" : "Select thinking level", choices.map(choice => choice.value));
              if (value === undefined) { record(`/${name} selection cancelled.`, "cancelled"); return true; }
              selected = value;
            }
            if (!selected) {
              output = `${name === "model" ? "Model" : "Thinking level"}: ${option?.currentValue || "None"}\n\n`
                + (choices.length ? choices.map(choice => `- ${choice.value}`).join("\n") : "No configured models are available. Open pi Models & Credentials in settings.")
                + `\n\nUse /${name} <${name === "model" ? "provider/model" : "level"}> or the selector beside the composer. This changes the current task; global defaults stay in settings.`;
            } else {
              const value = name === "thinking" ? selected.toLowerCase() : selected;
              if (!choices.some(choice => choice.value === value)) throw new Error(`Unknown ${name === "model" ? "model" : "thinking level"}: ${selected}. Run /${name} to see available values.`);
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
          case "reload": {
            if (argument) throw new Error("Usage: /reload (no arguments).");
            await pi.reload({beforeSessionStart: async () => { await pi.modelRuntime.refresh({allowNetwork: false, signal}); }});
            const errors = pi.resourceLoader.getExtensions().errors;
            await context.publishAvailableModels(await pi.modelRuntime.getAvailable());
            context.enqueue({sessionUpdate: "available_commands_update", availableCommands: catalogue()});
            context.enqueue({sessionUpdate: "config_option_update", configOptions: context.configOptions()});
            if (errors.length) throw new Error(`Reload completed with extension errors:\n${errors.map(error => error.error).join("\n")}`);
            output = "Reloaded global pi extensions, skills, templates and settings.";
            break;
          }
          case "scoped-models": {
            const models = await pi.modelRuntime.getAvailable();
            const input = argument || await ui?.input("Global model shortlist", `Comma-separated provider/model patterns, or all. Current: ${pi.settingsManager.getEnabledModels()?.join(", ") || "all"}. Available: ${models.map(model => `${model.provider}/${model.id}`).join(", ")}`);
            if (!input) {
              output = `Global model shortlist: ${pi.settingsManager.getEnabledModels()?.join(", ") || "all"}.\n\nUse /scoped-models <comma-separated patterns> or /scoped-models all.`;
              break;
            }
            const patterns = input.trim() === "all" ? [] : input.split(",").map(value => value.trim()).filter(Boolean);
            const resolved = await resolveModelScopeWithDiagnostics(patterns, pi.modelRuntime);
            if (resolved.diagnostics.length) throw new Error(`Unmatched model patterns: ${resolved.diagnostics.map(item => item.pattern).join(", ")}.`);
            signal?.throwIfAborted();
            pi.settingsManager.setEnabledModels(patterns.length ? patterns : undefined);
            await pi.settingsManager.flush();
            const errors = pi.settingsManager.drainErrors();
            if (errors.length) throw new Error("Could not save the global model shortlist.");
            pi.setScopedModels(resolved.scopedModels);
            await context.publishAvailableModels(models);
            context.enqueue({sessionUpdate: "config_option_update", configOptions: context.configOptions()});
            output = `Global model shortlist: ${patterns.length ? patterns.join(", ") : "all"}.`;
            break;
          }
          case "export":
            output = await exportPiSession(pi, argument, agentDir);
            break;
          case "changelog":
            if (argument) throw new Error("Usage: /changelog (no arguments).");
            output = await piChangelog();
            break;
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
