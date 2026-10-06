import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

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
