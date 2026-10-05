import type { AgentSession, ToolInfo, ToolDefinition } from "@earendil-works/pi-coding-agent";

export const agentToolCategories = ["read", "edit", "write", "preview", "browser", "subagent", "extensions", "mcp"];
const mcpPath = "<inline:agentprism-pi-acp-mcp>";
const discovery = new Map([['codemode', 'builtin:codemode'], ['tool_search', 'builtin:tool-search']]);

export function validAgentToolSelector(value: string): boolean {
  return agentToolCategories.includes(value) || /^(?:tool|mcp):[A-Za-z0-9_.-]+$/.test(value);
}

export function availableAgentTools(tools: ToolInfo[]): ToolInfo[] {
  return tools.filter(tool => discovery.get(tool.name) === tool.sourceInfo.path || tool.name !== "bash" && tool.sourceInfo.source !== "builtin"
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
  type McpDefinition = ToolDefinition & {eidoMcpExposure?:string; eidoMcpAutoEnableCodemode?:boolean};
  const definition = (name:string) => session.getToolDefinition(name) as McpDefinition|undefined;
  const refresh = (reset = false) => {
    const tools = allTools().filter(filter);
    allowed = new Set(resolveAgentTools(selectors, tools, reset));
    const indirect = tools.filter(tool => allowed.has(tool.name) && ['codemode','deferred'].includes(tool.exposure));
    const automatic = new Set<string>();
    for (const tool of indirect) {
      const config = definition(tool.name);
      const exposure = config?.eidoMcpExposure ?? tool.exposure;
      if (exposure === 'codemode' && config?.eidoMcpAutoEnableCodemode !== false) automatic.add('codemode');
      if (exposure === 'deferred') automatic.add('tool_search');
    }
    for (const name of automatic) {
      if (tools.some(tool => tool.name === name && tool.sourceInfo.path === discovery.get(name))) allowed.add(name);
      else automatic.delete(name);
    }
    const active = new Set(session.getActiveToolNames().filter(name => allowed.has(name)));
    for (const tool of tools) {
      if (allowed.has(tool.name) && selectors?.includes(`tool:${tool.name}`) && tool.exposure !== 'hidden') {
        active.add(tool.name);
        continue;
      }
      if (!allowed.has(tool.name) || !['direct','model-only'].includes(tool.exposure)) continue;
      if (definition(tool.name)?.defaultActive === false) continue;
      if (reset || !['direct','model-only'].includes(previous.get(tool.name) ?? '')) active.add(tool.name);
    }
    for (const name of automatic) active.add(name);
    previous = new Map(tools.map(tool => [tool.name, tool.exposure]));
    session.setActiveToolsByName([...active]);
  };
  const policy = {allows:(name:string) => allowed.has(name), changed:()=>refresh(), reset:()=>refresh(true)};
  Object.defineProperty(session, Symbol.for('eido.pi.tools'), {value:policy});
  // Keep registry ownership visible to ACP, but discovery cannot reveal tools
  // that this role is not allowed to use.
  session.getAllTools = () => allTools().map(tool => policy.allows(tool.name) ? tool : {...tool, exposure:'hidden'});
  policy.reset();
  return policy;
}
