import {createMcpConnector} from './mcp.ts';
import {refreshPiNetwork} from './pi-network.ts';
import {preparePromptContent} from './prompt-content.ts';
import {createDeliveryLedger, DELIVERY} from './delivery.ts';
import {nativeUiAction} from './native-ui.ts';
import { runAcp } from "@automatalabs/pi-acp";
import { createAgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { AgentContext, McpServer, Stream } from "@agentclientprotocol/sdk";
import { editorTools } from "./editor-tools.ts";
import { editorQueryTools } from "./editor-query.ts";
import { createPreview } from "./preview.ts";
import { browserLifecycle } from "./browser-lifecycle.ts";
import { accessPolicy } from "./access-policy.ts";
import { installPiCommands } from "./pi-commands.ts";
import { createSubagents } from "./subagents.ts";
import { installAgentToolPolicy } from "./agent-tools.ts";
import { configuredMcp } from "../../../scripts/pi-extensions.mjs";
import { browserDecisionEnvironment } from "../../../scripts/browser-config.mjs";

export async function startEidoAgent(agentDir: string, sessionDir: string, stream?: Stream, modelRuntime?: ModelRuntime) {
  const runtime = modelRuntime ?? await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false,
  });
  let connectClient!: (client: AgentContext) => void;
  let supportsForms = false;
  let supportsNativeUi = false;
  const subagents = createSubagents(agentDir, sessionDir);
  const deliveries = new Map<string, ReturnType<typeof createDeliveryLedger>>();
  const clientReady = new Promise<AgentContext>(resolve => { connectClient = resolve; });
  const server = await runAcp({
    stream,
    deps: {
      agentDir,
      sessionDir,
      connectMcpClient: createMcpConnector(agentDir),
      modelRuntime: runtime,
      createAgentSession: async options => {
        if (!options.cwd || !options.sessionManager) throw new Error("Missing ACP session context.");
        const client = await clientReady;
        const browserDecision = await browserDecisionEnvironment(agentDir);
        const preview = createPreview(options.cwd, join(agentDir, "previews"), options.sessionManager.getSessionId(), client);
        // Settings are owned by pi. New tasks see credentials/models changed in
        // Eido's settings without replacing the model of an active conversation.
        if (!modelRuntime) await runtime.refresh({ allowNetwork: false });
        // Let pi resolve explicit lists, +/- modifiers, pending registrations and
        // reload additions. Only the absent-setting fallback is Eido-specific.
        if (options.settingsManager) {
          const defaults = options.settingsManager.getDefaultTools.bind(options.settingsManager);
          options.settingsManager.getDefaultTools = () => defaults() ?? ["read", "edit", "write", "find", "grep", "ls"];
        }
        if (options.resourceLoader) {
          const getExtensions = options.resourceLoader.getExtensions.bind(options.resourceLoader);
          options.resourceLoader.getExtensions = () => {
            const loaded = getExtensions();
            return { ...loaded, extensions: [...loaded.extensions, preview.extension, accessPolicy(agentDir)] };
          };
          const append = options.resourceLoader.getAppendSystemPrompt.bind(options.resourceLoader);
          options.resourceLoader.getAppendSystemPrompt = () => [...append(),
            "For development verification, use preview start with explicit editor files, including unsaved changes. For static HTML/CSS/JS supply an HTML entry. For projects supply commands for checks/builds and a server command; select installed dependency directories to copy into the captured project. Read the project configuration before choosing commands. Commands run in a copy and do not update source buffers. Open its exact URL with the bundled browser tools, observe, interact, then observe the actual result. After a failure, read and repair the files, start a new preview and repeat the check. Capture a screenshot when visual inspection matters. Before reporting completion, use preview status; a stale or unknown input state does not verify current edits. Include the run ID and tested criteria in the result. Preview status and successful browser calls are not acceptance passes. Evidence covers only captured files and copied dependencies. Successful check exits and server reachability alone do not demonstrate correct behavior. Commands that modify captured source invalidate freshness; repair editor buffers and recapture instead. Never install missing dependencies without user authorization. Re-observe after cancellation or user takeover. Stop preview when finished. Project commands and servers also stop automatically when this turn ends. Eido automatically closes the task browser when this turn ends or is cancelled; reopen and re-observe in a later turn. If the target cannot be started with available tools, report missing verification instead of claiming success."
          ];
        }
        const created = await createAgentSession({
          ...options,
          agentDir,
          // Preserve pi's defaultTools lifecycle with native file operations.
          tools: undefined,
          noTools: undefined,
          customTools: [...[...editorTools(options.cwd, options.sessionManager.getSessionId(), client),
            ...editorQueryTools(options.cwd, options.sessionManager.getSessionId(), client)]
            .map(tool => ({...tool, defaultActive: false})), preview.tool,
            ...(subagents.enabled ? [subagents.tool(options.sessionManager.getSessionId(), client)] : [])],
        });
        // pi reads most runtime settings dynamically. These Agent properties
        // are copied at creation, so refresh them at the same reload boundary.
        const settings = created.session.settingsManager;
        const reloadSettings = settings.reload.bind(settings);
        settings.reload = async () => {
          await reloadSettings();
          refreshPiNetwork(settings);
          created.session.agent.transport = settings.getTransport();
          created.session.agent.thinkingBudgets = settings.getThinkingBudgets();
          created.session.agent.maxRetryDelayMs = settings.getProviderRetrySettings().maxRetryDelayMs;
        };
        const ledger = createDeliveryLedger(created.session, (id,state) => {
          if(supportsNativeUi)void nativeUiAction(client,created.session.sessionId,'delivery_state',{id,state})
            .catch(error=>console.error('Delivery UI update failed',error));
        }, (message,entryId)=>subagents.consumedInput(created.session.sessionId,message,entryId));
        deliveries.set(created.session.sessionId, ledger);
        Object.defineProperty(created.session, DELIVERY, {value:ledger});
        const dispose = created.session.dispose.bind(created.session);
        created.session.dispose = () => { ledger.dispose(); if(deliveries.get(created.session.sessionId)===ledger)deliveries.delete(created.session.sessionId); dispose(); };
        const browser = browserLifecycle(created.session);
        const prompt = created.session.prompt.bind(created.session);
        created.session.prompt = async (...args) => {
          try { return await prompt(...args); } finally {
            const cleanup = await Promise.allSettled([browser.close(), preview.finishTurn(!!child)]);
            const failed = cleanup.find(result => result.status === "rejected");
            if (failed?.status === "rejected") throw failed.reason;
          }
        };
        // The adapter awaits pi.abort() on cancellation. Settlement hooks are not
        // guaranteed on an aborted turn, so release preview after tools settle.
        const abort = created.session.abort.bind(created.session);
        created.session.abort = async () => {
          try { await abort(); } finally {
            const results = await Promise.allSettled([preview.finishTurn(true), browser.close()]);
            const failed = results.find(result => result.status === "rejected");
            if (failed?.status === "rejected") throw failed.reason;
          }
        };
        // pi-acp validates its tracked bash registration, even when it is inactive.
        // Keep that registration without activating shell access. MCP tools
        // keep pi-acp's permission, cancellation, image and lifecycle handling.
        const child = subagents.register(created.session);
        const decisionTools = new Set(["do", "check", "choose"].map(name => `mcp__eido_browser__browser_${name}`));
        let toolPolicy: ReturnType<typeof installAgentToolPolicy>;
        try { toolPolicy = installAgentToolPolicy(created.session, child ? child.role?.tools ?? ["read"] : undefined,
          tool => !!browserDecision.TYPESAFE_API_KEY || !decisionTools.has(tool.name)); }
        catch (error) {created.session.dispose(); throw error;}
        const reload = created.session.reload.bind(created.session);
        created.session.reload = async (...args) => {
          await reload(...args);
          toolPolicy.changed();
        };
        const beforeToolCall = created.session.agent.beforeToolCall;
        created.session.agent.beforeToolCall = async (context, signal) => {
          if (!toolPolicy.allows(context.toolCall.name)) {
            return { block: true, reason: "This tool is not enabled for this agent." };
          }
          browser.track(context.toolCall.name);
          return beforeToolCall?.(context, signal);
        };
        installPiCommands(created.session, client, supportsForms, agentDir, supportsNativeUi);
        return created;
      },
    },
  });
  const initialize = server.agent.initialize.bind(server.agent);
  server.agent.initialize = context => {
    supportsForms = context.params.clientCapabilities?.elicitation?.form != null;
    supportsNativeUi = context.params.clientCapabilities?._meta?.eidoNativeUi === 1;
    subagents.setEnabled(context.params.clientCapabilities?._meta?.eidoSubagents === 1);
    const result = initialize(context);
    return {...result, agentCapabilities: {...result.agentCapabilities,
      promptCapabilities: {...result.agentCapabilities?.promptCapabilities, embeddedContext: true}}};
  };
  await subagents.connect(server);
  const deliver = server.agent.prompt.bind(server.agent);
  server.agent.prompt = context => {
    const prepared = {...context, params: {...context.params, prompt: preparePromptContent(context.params.prompt)}};
    const ledger = deliveries.get(context.params.sessionId);
    return ledger ? ledger.deliver(context.params, () => deliver(prepared)) : deliver(prepared);
  };
  const steer = server.agent.steer.bind(server.agent);
  server.agent.steer = context => {
    const prepared = {...context, params: {...context.params, prompt: preparePromptContent(context.params.prompt)}};
    const ledger = deliveries.get(context.params.sessionId);
    return ledger ? ledger.steer(context.params, () => steer(prepared)) : steer(prepared);
  };
  // The configured servers enter the same ACP MCP bridge as built-in tools.
  const withMcp = async <T extends {params: {mcpServers?: McpServer[]; cwd: string}}>(context: T): Promise<T> => {
    let configured: McpServer[] = [];
    try {configured = await configuredMcp(agentDir, context.params.cwd);}
    catch { /* The bridge reports invalid configuration after the task opens. */ }
    const bundled = context.params.mcpServers ?? [];
    const servers = [...bundled, ...configured.filter(server => !bundled.some(s => s.name === server.name))].map(server =>
      server.name === "eido_browser" && "command" in server
        ? {...server, env: [...server.env?.filter(entry => entry.name !== "EIDO_PI_CONFIG_DIR") ?? [], {name: "EIDO_PI_CONFIG_DIR", value: agentDir}]}
        : server);
    return {...context, params: {...context.params, mcpServers: servers}};
  };
  const create = server.agent.newSession.bind(server.agent), load = server.agent.loadSession.bind(server.agent);
  server.agent.newSession = async context => create(await withMcp(context));
  server.agent.loadSession = async context => load(await withMcp(context));
  connectClient(server.connection.client);
  return server;
}
