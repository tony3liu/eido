import type { AgentSession, ToolInfo, ToolDefinition } from "@earendil-works/pi-coding-agent";

export const agentToolCategories = ["read", "edit", "write", "bash", "preview", "browser", "subagent", "extensions", "mcp"];
const mcpPath = "<inline:agentprism-pi-acp-mcp>";
const discovery = new Map([['codemode', 'builtin:codemode'], ['tool_search', 'builtin:tool-search']]);

export function validAgentToolSelector(value: string): boolean {
  return agentToolCategories.includes(value) || /^(?:tool|mcp):[A-Za-z0-9_.-]+$/.test(value);
}

export function availableAgentTools(tools: ToolInfo[]): ToolInfo[] {
  return tools.filter(tool => discovery.get(tool.name) === tool.sourceInfo.path || (tool.name !== "bash" || tool.sourceInfo.source === 'sdk') && tool.sourceInfo.source !== "builtin"
    && !tool.sourceInfo.path.startsWith("builtin:") && !tool.sourceInfo.path.startsWith("<builtin:")
    && tool.sourceInfo.path !== "<inline:agentprism-pi-acp-control>");
}

/** Resolve against the current pi registry, including extensions loaded on reload. */
export function resolveAgentTools(selectors: string[] | undefined, tools: ToolInfo[], requireMatches = true): string[] {
  const available = availableAgentTools(tools);
  if (!selectors) return available.map(tool => tool.name);
  const result = new Set<string>();
  for (const selector of selectors) {
    if (!validAgentToolSelector(selector)) throw new Error(`Invalid agent tool selector: ${selector}.`);
    const matches = available.filter(tool => {
      if (selector === "extensions") return !tool.sourceInfo.path.startsWith("<") && !tool.sourceInfo.path.startsWith('builtin:');
      if (selector === "mcp") return tool.sourceInfo.path === mcpPath;
      if (selector === "browser") return tool.sourceInfo.path === mcpPath && tool.name.startsWith("mcp__eido_browser__");
      if (selector.startsWith("mcp:")) return tool.sourceInfo.path === mcpPath && tool.name.startsWith(`mcp__${selector.slice(4)}__`);
      if (selector === "read") return ["read", "find", "grep", "ls"].includes(tool.name) && tool.sourceInfo.source === "sdk";
      return tool.name === selector.replace(/^tool:/, "");
    });
    if (requireMatches && !matches.length && (selector.startsWith("tool:") || selector.startsWith("mcp:"))) {
      throw new Error(`Agent tool ${selector} is unavailable. Enable its plugin or MCP server in Extensions, or update the role.`);
    }
    matches.forEach(tool => result.add(tool.name));
  }
  return [...result];
}

/** pi owns declarations and discovery; the role restricts every way of calling a tool. */
export function installAgentToolPolicy(session: AgentSession, selectors: string[]|undefined, filter: (tool:ToolInfo)=>boolean) {
  const allTools = session.getAllTools.bind(session);
  let allowed = new Set<string>();
  let previous = new Map<string,string>();
  const exposures = new WeakMap<ToolDefinition, ToolDefinition['exposure']>();
  const pending = new Set<string>();
  let defaults = new Set<string>();
  let refreshing=false;
  type McpDefinition = ToolDefinition & {eidoMcpExposure?:string; eidoMcpAutoEnableCodemode?:boolean};
  const definition = (name:string) => session.getToolDefinition(name) as McpDefinition|undefined;
  const readDefaults=()=>{
    const next=new Set((session.settingsManager.getDefaultTools()??[])
      .filter(name=>!name.startsWith('-')).map(name=>name.replace(/^\+/,'')));
    for(const name of next)if(!defaults.has(name)&&!definition(name))pending.add(name);
    defaults=next;
  };
  const refresh = (reset = false) => {
    if(refreshing)return;
    refreshing=true;
    try {
      const known=allTools();
      // Tool definitions belong to the SDK/resource-loader inputs. Exposure is
      // the public pi control for both model declarations and nested discovery.
      for(const info of known) {
        const tool=definition(info.name);if(!tool)continue;
        if(exposures.has(tool))tool.exposure=exposures.get(tool);
        else exposures.set(tool,tool.exposure);
      }
      const tools=allTools();
      allowed=new Set(resolveAgentTools(selectors,tools.filter(filter),reset));
      const automatic=new Set<string>();
      for(const tool of tools.filter(tool=>allowed.has(tool.name))) {
        const config=definition(tool.name);
        const exposure=config?.eidoMcpExposure??tool.exposure;
        if(exposure==='codemode'&&config?.eidoMcpAutoEnableCodemode!==false)automatic.add('codemode');
        if(exposure==='deferred')automatic.add('tool_search');
      }
      for(const name of automatic) {
        if(tools.some(tool=>tool.name===name&&tool.sourceInfo.path===discovery.get(name)))allowed.add(name);
        else automatic.delete(name);
      }
      const active=new Set(session.getActiveToolNames().filter(name=>allowed.has(name)));
      for(const tool of tools) {
        const config=definition(tool.name);
        if(!allowed.has(tool.name)) {if(config)config.exposure='hidden';continue;}
        if(!['direct','model-only'].includes(tool.exposure))continue;
        if(pending.has(tool.name)){active.add(tool.name);pending.delete(tool.name);}
        if(!selectors || !reset&&['direct','model-only'].includes(previous.get(tool.name)??''))continue;
        if(tool.sourceInfo.source==='sdk'||selectors.includes(`tool:${tool.name}`)||config?.defaultActive!==false)active.add(tool.name);
      }
      for(const name of automatic)active.add(name);
      previous=new Map(tools.map(tool=>[tool.name,tool.exposure]));
      session.setActiveToolsByName([...active]);
    } finally {refreshing=false;}
  };
  const hooks=new WeakMap<object,{refresh:()=>void;set:(names:string[])=>void}>();
  const bindRuntime=()=>{
    const runtime=session.resourceLoader.getExtensions().runtime;
    if(hooks.get(runtime)?.refresh===runtime.refreshTools)return;
    const refreshTools=runtime.refreshTools, setActive=runtime.setActiveTools;
    const hook={refresh:()=>{refreshTools();refresh();},set:(names:string[])=>{
      const before=session.getActiveToolNames();
      setActive(names);
      if(before.some(name=>allowed.has(name)&&!session.getActiveToolNames().includes(name)))pending.clear();
      refresh();
    }};
    hooks.set(runtime,hook);runtime.refreshTools=hook.refresh;runtime.setActiveTools=hook.set;
  };
  const policy={allows:(name:string)=>allowed.has(name),changed:()=>{bindRuntime();readDefaults();refresh();},
    registered:()=>refresh(),reset:()=>{bindRuntime();readDefaults();refresh(true);}};
  Object.defineProperty(session,Symbol.for('eido.pi.tools'),{value:policy});
  policy.reset();
  return policy;
}
