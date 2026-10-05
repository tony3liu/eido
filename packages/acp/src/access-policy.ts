import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BeforeAgentStartEvent, Extension } from "@earendil-works/pi-coding-agent";

export function accessPolicy(agentDir: string): Extension {
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
    }]]]),
    tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(),
  };
}
