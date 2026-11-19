import {createMcpConnector} from './mcp.ts';
import {createResearchServices} from './research.ts';
import {sessionOwners} from './session-owner.ts';
import {createShell} from './shell.ts';
import {refreshPiNetwork} from './pi-network.ts';
import {preparePromptContent,submittedDocuments,submittedRequirements} from './prompt-content.ts';
import {createDeliveryLedger, DELIVERY} from './delivery.ts';
import {nativeUiAction} from './native-ui.ts';
import { runAcp } from "../adapter/src/lib.js";
import { createAgentSession, ModelRuntime, type AgentSession } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {watchFile, unwatchFile, type Stats} from 'node:fs';
import { ndJsonStream, type AgentContext, type McpServer, type Stream } from "@agentclientprotocol/sdk";
import {Readable, Writable} from 'node:stream';
import { editorTools } from "./editor-tools.ts";
import { editorQueryTools } from "./editor-query.ts";
import { createPreview } from "./preview.ts";
import { browserLifecycle } from "./browser-lifecycle.ts";
import { accessPolicy } from "./access-policy.ts";
import { installPiCommands } from "./pi-commands.ts";
import { createSubagents } from "./subagents.ts";
import { installAgentToolPolicy } from "./agent-tools.ts";
import { configuredMcp } from "../../runtime/src/pi/extensions.mjs";
import { browserDecisionEnvironment } from "../../runtime/src/browser/config.mjs";
import {computerMcp} from '../../runtime/src/computer.mjs';
import {codemodeImages} from './codemode-images.ts';
import {createImageGeneration} from './image-generation.ts';
import {customImagePolicy, installCustomImagePolicy, installCustomModelCatalog} from './custom-model-policy.ts';

import {installResponsesCompat} from './responses-compat.ts';
import {createCatalogAliases} from './catalog-aliases.ts';

export async function startEidoAgent(agentDir: string, sessionDir: string, stream?: Stream, modelRuntime?: ModelRuntime, options: {catalogAliases?:false|{timeoutMs?:number}} = {}) {
  const runtime = modelRuntime ?? await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false,
  });
  const imagePolicy = await customImagePolicy(agentDir);
  const disposeCatalog = installCustomModelCatalog(runtime, imagePolicy);
  const responsesCompat = installResponsesCompat(runtime, imagePolicy);
  // Pi resolves credentials through this public method for ordinary requests and
  // direct summaries alike. Check both sides of async credential resolution so
  // an edit between them cannot pair a fresh key with the old destination.
  const originalGetAuth = runtime.getAuth;
  const resolveAuth = originalGetAuth.bind(runtime);
  const guardedGetAuth: ModelRuntime['getAuth'] = async (model, options) => {
    if (typeof model !== 'string') await imagePolicy.assertCurrent(model);
    const auth = await (typeof model === 'string' ? resolveAuth(model, options) : resolveAuth(model, options));
    if (typeof model !== 'string') {
      await imagePolicy.assertCurrent(model);
      responsesCompat.recordAuth(model, auth);
    }
    return auth;
  };
  runtime.getAuth = guardedGetAuth;
  const imageGeneration = await createImageGeneration(agentDir, runtime);
  const aliases = options.catalogAliases === false ? undefined : createCatalogAliases(agentDir,runtime,imagePolicy,imageGeneration.supports,async()=>{
    await server.agent.refreshGlobalModelScope();
  },options.catalogAliases);
  imagePolicy.setAliasLookup(aliases?.lookup);
  let connectClient!: (client: AgentContext) => void;
  let supportsForms = false;
  let supportsNativeUi = false;
  const subagents = createSubagents(agentDir, sessionDir);
  const mcp = createMcpConnector(agentDir);
  const research = createResearchServices(agentDir);
  const deliveries = new Map<string, ReturnType<typeof createDeliveryLedger>>();
  const clientReady = new Promise<AgentContext>(resolve => { connectClient = resolve; });
  // The transport can receive initialize/new while asynchronous Eido setup is
  // still installing wrappers. Admit requests only after that setup completes.
  let admitRequests!: () => void;
  const ready = new Promise<void>(resolve => {admitRequests = resolve;});
  process.env.EIDO_ONE_CODE_STATE_DIR ??= join(agentDir, "one-code");
  const transport = stream ?? ndJsonStream(Writable.toWeb(process.stdout) as Parameters<typeof ndJsonStream>[0],
    Readable.toWeb(process.stdin) as Parameters<typeof ndJsonStream>[1]);
  const incoming = new TransformStream({async transform(message, controller) {
    await ready;
    controller.enqueue(message);
  }});
  const server = await runAcp({
    stream: {readable: transport.readable.pipeThrough(incoming), writable: transport.writable},
    deps: {
      ...{eidoClaimSession: sessionOwners(agentDir)},
      agentDir,
      sessionDir,
      connectMcpClient: mcp,
      builtinMcpClients: research.builtinMcpClients,
      modelRuntime: runtime,
      eidoImages: imageGeneration,
      createAgentSession: async options => {
        if (!options.cwd || !options.sessionManager) throw new Error("Missing ACP session context.");
        const client = await clientReady;
        let liveSession:AgentSession|undefined;
        const browserDecision = await browserDecisionEnvironment(agentDir);
        const images = codemodeImages();
        const researchHooks=research.get(options.sessionManager.getSessionId())?.hooks;
        const preview = createPreview(options.cwd, join(agentDir, "previews"), options.sessionManager.getSessionId(), client, 'preview', researchHooks);
        const shell = createShell(options.cwd, join(agentDir, "commands"), options.sessionManager.getSessionId(), client, researchHooks);
        // Settings are owned by pi. New tasks see credentials/models changed in
        // Eido's settings without replacing the model of an active conversation.
        await imagePolicy.refresh();
        if (!modelRuntime) await runtime.refresh({ allowNetwork: false });
        await imageGeneration.refresh();
        void aliases?.schedule();
        // Let pi resolve explicit lists, +/- modifiers, pending registrations and
        // reload additions. Only the absent-setting fallback is Eido-specific.
        if (options.settingsManager) {
          const defaults = options.settingsManager.getDefaultTools.bind(options.settingsManager);
          options.settingsManager.getDefaultTools = () => defaults() ?? ["read", "edit", "write", "find", "grep", "ls", "bash", "generate_image"];
        }
        if (options.resourceLoader) {
          const getExtensions = options.resourceLoader.getExtensions.bind(options.resourceLoader);
          options.resourceLoader.getExtensions = () => {
            const loaded = getExtensions();
            return { ...loaded, extensions: [preview.extension, shell.extension, accessPolicy(agentDir,()=>liveSession,name=>browser.track(name),{
              engine:browserDecision.EIDO_BROWSER_ENGINE,decisionConfigured:!!browserDecision.TYPESAFE_API_KEY,
              textConfigured:browserDecision.TEXT_MODEL_SOURCE==='pi'||!!browserDecision.TEXT_MODEL_API_KEY,textSource:browserDecision.TEXT_MODEL_SOURCE,
            }), ...loaded.extensions] };
          };
          const append = options.resourceLoader.getAppendSystemPrompt.bind(options.resourceLoader);
          options.resourceLoader.getAppendSystemPrompt = () => [...append(),
            'Follow the requested verification scope and skip checks the user declined. For a command-only check call preview with action "start", files and commands; omit server, entry and criterionIds unless they apply. Use the browser only for a real web preview. The command copy lacks .git and may lack tools from your login shell; use native grep/find instead of shell rg, and use read-only git -C <project-path> status for on-disk repository status. Use actual submitted criterion IDs, never invented ones. After an error read the specific result and change the input, or report the blocker if no valid alternative exists. Avoid repeating the same failed check. Report which checks actually ran and whether the inputs changed. For a browser preview, open its exact URL, observe the requested behavior, then check freshness and stop the preview. Never install missing dependencies without user authorization.'
          ];
        }
        const created = await createAgentSession({
          ...options,
          ...(options.model ? {model:imagePolicy.project(options.model)} : {}),
          agentDir,
          // Preserve pi's defaultTools lifecycle with native file operations.
          tools: undefined,
          noTools: undefined,
          customTools: [...[...editorTools(options.cwd, options.sessionManager.getSessionId(), client, images.get, researchHooks,
            () => options.resourceLoader?.getSkills().skills ?? []),
            ...editorQueryTools(options.cwd, options.sessionManager.getSessionId(), client)]
            .map(tool => ({...tool, defaultActive: false})), preview.tool, shell.tool,
            imageGeneration.tool(() => liveSession, options.sessionManager.getSessionId()),
            ...(subagents.enabled ? [subagents.tool(options.sessionManager.getSessionId(), client)] : [])],
        });
        liveSession=created.session;
        const disposeImagePolicy = installCustomImagePolicy(created.session, imagePolicy);
        await research.attach(created.session);
        const disposeImages = images.attach(created.session);
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
        created.session.dispose = () => { disposeImagePolicy(); disposeImages(); ledger.dispose(); if(deliveries.get(created.session.sessionId)===ledger)deliveries.delete(created.session.sessionId); dispose(); };
        const browser = browserLifecycle(created.session);
        const prompt = created.session.prompt.bind(created.session);
        created.session.prompt = async (...args) => {
          try {
            const result = await prompt(...args);
            // Extension commands can start a custom run without awaiting it.
            // Pi 1.2+ is busy during before_agent_start as well. Keep the ACP
            // turn and its resources alive until that public SDK run settles.
            await created.session.waitForIdle();
            return result;
          } finally {
            const cleanup = await Promise.allSettled([research.finishTurn(created.session.sessionId),mcp.finishTurn(created.session.sessionId), browser.close(), preview.finishTurn(!!child), shell.finishTurn()]);
            const failed = cleanup.find(result => result.status === "rejected");
            if (failed?.status === "rejected") throw failed.reason;
          }
        };
        // The adapter awaits pi.abort() on cancellation. Settlement hooks are not
        // guaranteed on an aborted turn, so release preview after tools settle.
        const abort = created.session.abort.bind(created.session);
        created.session.abort = async () => {
          try { await abort(); } finally {
            const results = await Promise.allSettled([research.finishTurn(created.session.sessionId),mcp.finishTurn(created.session.sessionId), preview.finishTurn(true), shell.finishTurn(), browser.close()]);
            const failed = results.find(result => result.status === "rejected");
            if (failed?.status === "rejected") throw failed.reason;
          }
        };
        // The SDK bash override uses current editor captures and the same native
        // process supervisor as preview. Role restrictions apply after discovery.
        const child = subagents.register(created.session);
        const decisionTools = new Set(["do", "check", "choose"].map(name => `mcp__eido_browser__browser_${name}`));
        let toolPolicy: ReturnType<typeof installAgentToolPolicy>;
        try { toolPolicy = installAgentToolPolicy(created.session, child ? child.role?.tools ?? ["read"] : undefined,
          tool => !!browserDecision.TYPESAFE_API_KEY || !decisionTools.has(tool.name)); }
        catch (error) {created.session.dispose(); throw error;}
        const reload = created.session.reload.bind(created.session);
        created.session.reload = async (...args) => {
          responsesCompat.clear();
          await imagePolicy.refresh();
          await reload(...args);
          await imageGeneration.refresh();
          void aliases?.schedule();
          toolPolicy.changed();
        };
        installPiCommands(created.session, client, supportsForms, agentDir, supportsNativeUi, () => server.agent.refreshGlobalModelScope());
        const dispatch = created.session.prompt.bind(created.session);
        created.session.prompt = async (...args) => {
          toolPolicy.changed();
          try { return await dispatch(...args); } finally { toolPolicy.registered(); }
        };
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
      _meta:{eidoResearch:1,eidoDocuments:1},
      promptCapabilities: {...result.agentCapabilities?.promptCapabilities, embeddedContext: true}}};
  };
  await subagents.connect(server);
  const deliver = server.agent.prompt.bind(server.agent);
  server.agent.prompt = context => {
    const prepared = {...context, params: {...context.params, prompt: preparePromptContent(context.params.prompt), _meta:{...context.params._meta,eidoHasAttachments:context.params.prompt.some(block=>block.type!=='text')}}};
    const ledger = deliveries.get(context.params.sessionId);
    const dispatch=async()=>{await research.submit(context.params.sessionId,submittedDocuments(context.params.prompt),submittedRequirements(context.params.prompt));return deliver(prepared);};
    return ledger ? ledger.deliver(context.params, dispatch) : dispatch();
  };
  const steer = server.agent.steer.bind(server.agent);
  server.agent.steer = context => {
    const prepared = {...context, params: {...context.params, prompt: preparePromptContent(context.params.prompt), _meta:{...context.params._meta,eidoHasAttachments:context.params.prompt.some(block=>block.type!=='text')}}};
    const ledger = deliveries.get(context.params.sessionId);
    const dispatch=async()=>{await research.submit(context.params.sessionId,submittedDocuments(context.params.prompt),submittedRequirements(context.params.prompt));return steer(prepared);};
    return ledger ? ledger.steer(context.params, dispatch) : dispatch();
  };
  // The configured servers enter the same ACP MCP bridge as built-in tools.
  const withMcp = async <T extends {params: {mcpServers?: McpServer[]; cwd: string}}>(context: T): Promise<T> => {
    let configured: McpServer[] = [];
    try {configured = await configuredMcp(agentDir, context.params.cwd);}
    catch { /* The bridge reports invalid configuration after the task opens. */ }
    const bundled = [...(context.params.mcpServers ?? []).filter(server => server.name !== 'eido_computer'), ...await computerMcp(agentDir)];
    const servers = [...bundled, ...configured.filter(server => !bundled.some(s => s.name === server.name))].map(server =>
      server.name === "eido_browser" && "command" in server
        ? {...server, env: [...server.env?.filter(entry => entry.name !== "EIDO_PI_CONFIG_DIR") ?? [], {name: "EIDO_PI_CONFIG_DIR", value: agentDir}]}
        : server);
    return {...context, params: {...context.params, mcpServers: servers}};
  };
  const create = server.agent.newSession.bind(server.agent), load = server.agent.loadSession.bind(server.agent);
  server.agent.newSession = async context => create(await withMcp(context));
  server.agent.loadSession = async context => load(await withMcp(context));
  // Settings run in a separate process. Refresh the advertised model options
  // when global model/auth files change, without replacing a task's model.
  // watchFile also follows atomic replacement of files and needs no directory
  // watcher for secrets, history, or transient lock files.
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refresh = Promise.resolve();
  const changed = (current:Stats, previous:Stats) => {
    if (stopped || (current.mtimeMs === previous.mtimeMs && current.ctimeMs === previous.ctimeMs && current.ino === previous.ino && current.size === previous.size)) return;
    void aliases?.invalidate();
    clearTimeout(timer);
    timer = setTimeout(() => {
      refresh = refresh.then(async () => {
        if (stopped) return;
        responsesCompat.clear();
        await imagePolicy.refresh();
        await runtime.refresh({allowNetwork:false});
        await imageGeneration.refresh();
        if (!stopped && !runtime.getError()) {
          await server.agent.refreshGlobalModelScope();
          void aliases?.schedule();
        }
      }).catch(() => { /* Keep current options; the settings view reports configuration errors. */ });
    }, 100);
    timer.unref();
  };
  const watched = ['auth.json', 'models.json', 'models-store.json'].map(name => join(agentDir, name));
  for (const path of watched) watchFile(path, {persistent:false, interval:500}, changed);
  const settingsPath = join(agentDir,'settings.json');
  // The resolver compares only the global default identity; thinking and other
  // settings changes preserve both positive and negative cache entries.
  const settingsChanged = () => {
    if (!stopped && aliases) void aliases.invalidate().then(()=>aliases.schedule());
  };
  watchFile(settingsPath,{persistent:false,interval:500},settingsChanged);
  const stopWatching = () => {
    stopped = true;
    aliases?.dispose();
    clearTimeout(timer);
    unwatchFile(settingsPath,settingsChanged);
    for (const path of watched) unwatchFile(path, changed);
  };
  const dispose = server.agent.dispose.bind(server.agent);
  server.agent.dispose = async () => {
    stopWatching(); await refresh;
    try { await dispose(); } finally { responsesCompat.dispose(); disposeCatalog(); if (runtime.getAuth === guardedGetAuth) runtime.getAuth = originalGetAuth; }
  };
  const close = server.connection.close.bind(server.connection);
  server.connection.close = () => { stopWatching(); return close(); };
  connectClient(server.connection.client);
  admitRequests();
  void aliases?.schedule();
  return server;
}
