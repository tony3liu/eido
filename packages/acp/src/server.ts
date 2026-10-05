import { runAcp } from "@automatalabs/pi-acp";
import { createAgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { AgentContext, Stream } from "@agentclientprotocol/sdk";
import { editorTools } from "./editor-tools.ts";
import { createPreview } from "./preview.ts";
import { browserLifecycle } from "./browser-lifecycle.ts";
import { accessPolicy } from "./access-policy.ts";
import { installPiCommands } from "./pi-commands.ts";

export async function startEidoAgent(agentDir: string, sessionDir: string, stream?: Stream, modelRuntime?: ModelRuntime) {
  const runtime = modelRuntime ?? await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false,
  });
  let connectClient!: (client: AgentContext) => void;
  const clientReady = new Promise<AgentContext>(resolve => { connectClient = resolve; });
  const server = await runAcp({
    stream,
    deps: {
      agentDir,
      sessionDir,
      modelRuntime: runtime,
      createAgentSession: async options => {
        if (!options.cwd || !options.sessionManager) throw new Error("Missing ACP session context.");
        const client = await clientReady;
        const preview = createPreview(options.cwd, join(agentDir, "previews"), options.sessionManager.getSessionId(), client);
        // Settings are owned by pi. New tasks see credentials/models changed in
        // Eido's settings without replacing the model of an active conversation.
        if (!modelRuntime) await runtime.refresh({ allowNetwork: false });
        if (options.resourceLoader) {
          const getExtensions = options.resourceLoader.getExtensions.bind(options.resourceLoader);
          options.resourceLoader.getExtensions = () => {
            const loaded = getExtensions();
            return { ...loaded, extensions: [...loaded.extensions, preview.extension, accessPolicy(agentDir)] };
          };
          const append = options.resourceLoader.getAppendSystemPrompt.bind(options.resourceLoader);
          options.resourceLoader.getAppendSystemPrompt = () => [...append(),
            "For static HTML/CSS/JS tasks, use preview start with explicit files and an HTML entry to serve current editor buffers, including unsaved changes. Open its exact URL with the bundled browser tools, observe, interact, then observe the actual result. After a failure, read and repair the files, start a new preview and repeat the check. Capture a screenshot when visual inspection matters. Before reporting completion, use preview status; a stale or unknown input state does not verify current edits. Include the run ID and tested criteria in the result. Preview status and successful browser calls are not acceptance passes. Evidence covers only listed static inputs, not arbitrary builds or external dependencies. Re-observe after cancellation or user takeover. Stop preview when finished. Eido automatically closes the task browser when this turn ends or is cancelled; reopen and re-observe in a later turn. If the target cannot be started with available tools, report missing verification instead of claiming success."
          ];
        }
        const browserNames = options.resourceLoader?.getExtensions().extensions
          .filter(extension => extension.path === "<inline:agentprism-pi-acp-mcp>")
          .flatMap(extension => [...extension.tools.keys()])
          .filter(name => name.startsWith("mcp__eido_browser__")) ?? [];
        const created = await createAgentSession({
          ...options,
          agentDir,
          tools: ["read", "edit", "write", "preview", "bash", ...browserNames],
          customTools: [...editorTools(options.cwd, options.sessionManager.getSessionId(), client), preview.tool],
        });
        const browser = browserLifecycle(created.session);
        const prompt = created.session.prompt.bind(created.session);
        created.session.prompt = async (...args) => {
          try { return await prompt(...args); } finally { await browser.close(); }
        };
        // The adapter awaits pi.abort() on cancellation. Settlement hooks are not
        // guaranteed on an aborted turn, so release preview after tools settle.
        const abort = created.session.abort.bind(created.session);
        created.session.abort = async () => {
          try { await abort(); } finally {
            const results = await Promise.allSettled([preview.stop(), browser.close()]);
            const failed = results.find(result => result.status === "rejected");
            if (failed?.status === "rejected") throw failed.reason;
          }
        };
        // pi-acp validates its tracked bash registration, even when it is inactive.
        // Keep that registration without activating shell access. MCP tools
        // keep pi-acp's permission, cancellation, image and lifecycle handling.
        const browserTools = created.session.getAllTools().filter(tool =>
          tool.sourceInfo.path === "<inline:agentprism-pi-acp-mcp>"
          && tool.name.startsWith("mcp__eido_browser__")
        ).map(tool => tool.name);
        const activeTools = new Set(["read", "edit", "write", "preview", ...browserTools]);
        created.session.setActiveToolsByName([...activeTools]);
        const beforeToolCall = created.session.agent.beforeToolCall;
        created.session.agent.beforeToolCall = async (context, signal) => {
          if (!activeTools.has(context.toolCall.name)) {
            return { block: true, reason: "This tool is not enabled in Eido. Use editor, preview and bundled browser tools." };
          }
          browser.track(context.toolCall.name);
          return beforeToolCall?.(context, signal);
        };
        installPiCommands(created.session);
        return created;
      },
    },
  });
  connectClient(server.connection.client);
  return server;
}
