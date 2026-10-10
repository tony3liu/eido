import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export function browserGuidance(session: AgentSession | undefined, config: {engine?:string;decisionConfigured?:boolean;textConfigured?:boolean}) {
  const entry=session?.getAllTools().find(tool=>tool.name==='mcp__eido_browser__browser_open');
  if(entry?.sourceInfo.path!=='<inline:agentprism-pi-acp-mcp>')return '';
  const policy=config.decisionConfigured
    ? `Eido Browser Use engine: ${config.engine==='legacy'?'Legacy':'Ultrafast'}. For a browser task, call browser_open to navigate, then browser_do with the ENTIRE goal and all required field values. Delegate supported clicking, typing, selection and scrolling to browser_do; do not split the goal into repeated browser_act calls. Ultrafast chooses the operation and indexed target in one Jev request per step; only TYPE_TEXT uses the separate text helper. ${config.textConfigured?'Browser Text Model is configured.':'Browser Text Model has no configured API key. If TYPE_TEXT is needed, report the missing global setting; direct input with an explicit fallback_reason can complete the task, but does not verify the Ultrafast text path.'}`
    : 'Eido Browser Use decision service has no configured API key. Direct browser tools remain available; do not claim these calls use the Jev or Ultrafast decision loop. Configure the Browser Decision Model in global settings to run browser_do.';
  return `\n${policy} Use browser_act only for an unsupported operation, a specific failed/unavailable service, or an explicit request for direct input. Supply fallback_reason for direct click/type/select/scroll when Ultrafast is configured. press_enter and press_key require the observed element number. Re-observe after an error or takeover before acting. Never replay completed actions automatically after changing engines. Request explain on browser_do to inspect its decision trace, or use browser_agent_state/browser_inspect. Screenshots and recordings are optional evidence, outside the default model loop. Verify actual page state before claiming success; likely_done is only a model decision. Report whether the task used Ultrafast, Legacy or direct fallback.`;
}

// The published MCP bridge owns a separate browser for each ACP session.
// A completed prompt retains the conversation, but must release its test browser.
export function browserLifecycle(session: AgentSession) {
  let used = false;
  let closing: Promise<void> | undefined;
  return {
    track(name: string) {
      if (name.startsWith("mcp__eido_browser__browser_")) used = true;
    },
    async close() {
      if (closing) return closing;
      if (!used) return;
      closing = (async () => {
        const name = "mcp__eido_browser__browser_close";
        const info = session.getAllTools().find(tool => tool.name === name);
        const tool = session.getToolDefinition(name);
        if (!tool || info?.sourceInfo.path !== "<inline:agentprism-pi-acp-mcp>") {
          throw new Error("The test browser cleanup tool is unavailable.");
        }
        // Invoke the existing runtime tool, after model tools settle. Cleanup is
        // unconditional, so it must not ask the model or enter approval hooks.
        const result = await tool.execute(`eido-cleanup-${randomUUID()}`, {}, AbortSignal.timeout(5000), undefined, {} as Parameters<typeof tool.execute>[4]);
        if (result.isError) throw new Error('The task browser did not confirm cleanup.');
        used = false;
      })().finally(() => { closing = undefined; });
      return closing;
    },
  };
}
