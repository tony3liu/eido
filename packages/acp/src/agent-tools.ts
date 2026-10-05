import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export const agentToolCategories = ["read", "edit", "write", "preview", "browser", "subagent", "extensions", "mcp"];
const mcpPath = "<inline:agentprism-pi-acp-mcp>";

export function validAgentToolSelector(value: string): boolean {
  return agentToolCategories.includes(value) || /^(?:tool|mcp):[A-Za-z0-9_.-]+$/.test(value);
}

export function availableAgentTools(tools: ToolInfo[]): ToolInfo[] {
  return tools.filter(tool => tool.name !== "bash" && tool.sourceInfo.source !== "builtin"
    && !tool.sourceInfo.path.startsWith("builtin:") && !tool.sourceInfo.path.startsWith("<builtin:")
    && tool.sourceInfo.path !== "<inline:agentprism-pi-acp-control>");
}

/** Resolve against the current pi registry, including extensions loaded on reload. */
export function resolveAgentTools(selectors: string[] | undefined, tools: ToolInfo[]): string[] {
  const available = availableAgentTools(tools);
  if (!selectors) return available.map(tool => tool.name);
  const result = new Set<string>();
  for (const selector of selectors) {
    if (!validAgentToolSelector(selector)) throw new Error(`Invalid agent tool selector: ${selector}.`);
    const matches = available.filter(tool => {
      if (selector === "extensions") return !tool.sourceInfo.path.startsWith("<");
      if (selector === "mcp") return tool.sourceInfo.path === mcpPath;
      if (selector === "browser") return tool.sourceInfo.path === mcpPath && tool.name.startsWith("mcp__eido_browser__");
      if (selector.startsWith("mcp:")) return tool.sourceInfo.path === mcpPath && tool.name.startsWith(`mcp__${selector.slice(4)}__`);
      if (selector === "read") return ["read", "find", "grep", "ls"].includes(tool.name) && tool.sourceInfo.source === "sdk";
      return tool.name === selector.replace(/^tool:/, "");
    });
    if (!matches.length && (selector.startsWith("tool:") || selector.startsWith("mcp:"))) {
      throw new Error(`Agent tool ${selector} is unavailable. Enable its plugin or MCP server in Extensions, or update the role.`);
    }
    matches.forEach(tool => result.add(tool.name));
  }
  return [...result];
}
