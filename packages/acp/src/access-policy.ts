import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSession, BeforeAgentStartEvent, Extension, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

export function accessPolicy(agentDir: string, session:()=>AgentSession|undefined, track:(name:string)=>void): Extension {
  const path = "<inline:eido-access>";
  return {
    path, resolvedPath: path, sourceInfo: { path, source: "inline", scope: "user", origin: "top-level" },
    handlers: new Map([["before_agent_start", [async (raw: unknown) => {
      let fullAccess = false;
      try { fullAccess = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")).eido?.fullAccess === true; }
      catch { /* The native permission handler also falls back to asking. */ }
      const event = raw as BeforeAgentStartEvent;
      event.systemPromptOptions.appendSystemPrompt += fullAccess
        ? "\nEido access mode: Full Access. The user delegates tool and permission decisions to pi. Carry out the requested task autonomously with enabled tools; do not pause for routine confirmations or ask the user to approve tool calls. Choose the necessary actions yourself, verify the outcome, and report genuine missing information or unavailable capabilities. Explicit user constraints still apply."
        : "\nEido access mode: Ask Before Actions. The native client handles tool permission requests.";
    }]], ["tool_call", [async (raw:unknown, rawContext:unknown) => {
      const pi=session(), event=raw as ToolCallEvent, context=rawContext as ExtensionContext;
      const policy=(pi as unknown as Record<symbol, {allows(name:string):boolean}|undefined>)?.[Symbol.for('eido.pi.tools')];
      if(!pi || !policy?.allows(event.toolName))return {block:true,reason:'This tool is not enabled for this agent.'};
      const permission=(pi as unknown as Record<symbol, ((event:ToolCallEvent,signal:AbortSignal|undefined)=>Promise<ToolCallEventResult|undefined>)|undefined>)[Symbol.for('eido.pi.permission')];
      if(!permission)return {block:true,reason:'The native permission handler is unavailable.'};
      track(event.toolName);
      return permission(event,context.signal);
    }]]]),
    tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(),
  };
}
