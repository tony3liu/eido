import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseFrontmatter, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { agentToolCategories, validAgentToolSelector } from "./agent-tools.ts";

const lockfile = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("proper-lockfile");

export interface AgentRole {
  name: string;
  description: string;
  tools: string[];
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  systemPrompt: string;
}
const tools = agentToolCategories;
const builtins: AgentRole[] = [
  {name: "scout", description: "Inspect code and gather references", tools: ["read"], systemPrompt: "Inspect the assigned code. Return verified findings with file references. Do not modify files."},
  {name: "reviewer", description: "Review correctness and risks", tools: ["read"], systemPrompt: "Review the assigned changes. Prioritize actionable defects with file references. Separate verified defects from suggestions."},
  {name: "worker", description: "Implement changes in native editor buffers", tools, systemPrompt: "Complete the assigned implementation. Read before editing. Preserve user edits; if a write conflicts, re-read and reconcile. Verify changes with the available tools."},
  {name: "verifier", description: "Verify current buffers in a test browser", tools: ["read", "preview", "browser"], systemPrompt: "Verify the assigned behavior using current buffers and browser observations. Report criteria, actual observations and preview run ID. Stop test resources when finished. Do not claim unobserved success."},
];
const validName = (name: string) => /^[a-z][a-z0-9_-]{0,63}$/.test(name);
export function parseAgentRole(source: string): AgentRole {
  const {frontmatter: f, body} = parseFrontmatter<Record<string, unknown>>(source);
  if (typeof f.name !== "string" || !validName(f.name)) throw new Error("Agent name must use lowercase letters, numbers, underscores or hyphens.");
  if (typeof f.description !== "string" || !f.description.trim()) throw new Error("Agent description is required.");
  const selected = f.tools === undefined ? ["read"] : typeof f.tools === "string" ? f.tools.split(",").map(v => v.trim()) : f.tools;
  if (!Array.isArray(selected) || !selected.length || selected.some(t => typeof t !== "string" || !validAgentToolSelector(t))) {
    throw new Error(`Agent tools must be a nonempty list of ${tools.join(", ")}, tool:<name>, or mcp:<server>.`);
  }
  if (f.model !== undefined && (typeof f.model !== "string" || !f.model.trim())) throw new Error("Agent model must be a configured provider/model ID.");
  if (f.thinking !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh"].includes(String(f.thinking))) throw new Error("Invalid agent thinking level.");
  if (!body.trim()) throw new Error("Agent instructions are required below the frontmatter.");
  return {name: f.name, description: f.description, tools: [...new Set(selected)], model: f.model as string | undefined,
    thinking: f.thinking as AgentRole["thinking"], systemPrompt: body.trim()};
}
export async function discoverAgentRoles(agentDir: string) {
  const roles = new Map(builtins.map(role => [role.name, {...role, tools: [...role.tools]}]));
  const errors: string[] = [];
  const directory = join(agentDir, "agents");
  for (const file of await readdir(directory, {withFileTypes: true}).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  })) {
    if (!file.isFile() || !file.name.endsWith(".md")) continue;
    try {
      const role = parseAgentRole(await readFile(join(directory, file.name), "utf8"));
      if (file.name !== `${role.name}.md`) throw new Error("Filename must match the agent name.");
      roles.set(role.name, role);
    } catch (error) {
      roles.delete(file.name.slice(0, -3));
      errors.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {roles: [...roles.values()], errors};
}
function roleSource(role: AgentRole) {
  return `---\nname: ${role.name}\ndescription: ${JSON.stringify(role.description)}\ntools: [${role.tools.join(", ")}]\n${role.model ? `model: ${JSON.stringify(role.model)}\n` : ""}${role.thinking ? `thinking: ${role.thinking}\n` : ""}---\n${role.systemPrompt}\n`;
}
export async function manageAgentRoles(agentDir: string, argument: string, ui?: ExtensionUIContext, signal?: AbortSignal) {
  const {roles, errors} = await discoverAgentRoles(agentDir);
  const directory = join(agentDir, "agents");
  const files: string[] = await readdir(directory, {encoding: "utf8"}).catch(error => {if (error.code === "ENOENT") return []; throw error;});
  const removalLabel = (name: string) => builtins.some(r => r.name === name) ? `Reset ${name}` : `Delete ${name}`;
  if (!argument && !ui) return [...roles.map(r => `- ${r.name}: ${r.description} (${r.tools.join(", ")})`), ...errors].join("\n");
  const selected = argument || await ui?.select("Global agents", ["List agents", "Create agent", ...roles.map(r => `Edit ${r.name}`),
    ...roles.filter(r => files.includes(`${r.name}.md`)).map(r => removalLabel(r.name))]);
  if (!selected) return "Agent configuration cancelled.";
  if (selected === "List agents" || selected === "list") return [...roles.map(r => `- ${r.name}: ${r.description} (${r.tools.join(", ")}; model: ${r.model || "inherit"})`), ...errors].join("\n");
  if (!ui) throw new Error("Editing global agents requires the native agent form.");
  const removal = /^(delete|reset)\s+([a-z][a-z0-9_-]{0,63})$/i.exec(selected);
  if (removal) {
    const name = removal[2]!, path = join(directory, `${name}.md`);
    const isBuiltin = builtins.some(r => r.name === name);
    if (!files.includes(`${name}.md`)) throw new Error("This role has no custom configuration to remove.");
    const original = await readFile(path, "utf8");
    if (!await ui.confirm(`${isBuiltin ? "Reset" : "Delete"} agent ${name}?`, isBuiltin
      ? "Restore the built-in role for future delegations. Running agents keep their current configuration."
      : "Remove this global role from future delegations. Running agents and existing task history are preserved.")) return "Agent configuration cancelled.";
    signal?.throwIfAborted();
    const release = await lockfile.lock(path, {realpath: false, stale: 10_000, retries: 0});
    try {
      if (await readFile(path, "utf8") !== original) throw new Error("This agent changed while the form was open. Reopen it to keep the latest changes.");
      signal?.throwIfAborted();
      await rm(path);
    } finally {await release();}
    return `${isBuiltin ? "Reset" : "Deleted"} global agent ${name}. Running agents and task history are unchanged.`;
  }
  const role = roles.find(r => r.name === selected.replace(/^Edit /, ""));
  if (!role && selected !== "Create agent" && selected !== "new") throw new Error(`Unknown agent: ${selected}.`);
  const name = role?.name || await ui.input("Create a global agent", "lowercase-agent-name");
  if (!name) return "Agent configuration cancelled.";
  if (!validName(name)) throw new Error("Invalid agent name.");
  if (!role && roles.some(r => r.name === name)) throw new Error("This agent already exists. Choose Edit to change it.");
  const path = join(directory, `${name}.md`);
  const readCurrent = () => readFile(path, "utf8").catch(error => {if (error.code === "ENOENT") return undefined; throw error;});
  const original = await readCurrent();
  if (!role && original !== undefined) throw new Error("This agent already exists. Repair its file before editing.");
  const source = await ui.editor(`Global agent · ${name}`, roleSource(role ?? {name, description: "Describe this agent", tools: ["read"], systemPrompt: "Describe the assigned role and expected result."}));
  if (source === undefined) return "Agent configuration cancelled.";
  const parsed = parseAgentRole(source);
  if (parsed.name !== name) throw new Error("Keep the agent name unchanged. Create a new agent to use another name.");
  signal?.throwIfAborted();
  await mkdir(directory, {recursive: true, mode: 0o700});
  const release = await lockfile.lock(path, {realpath: false, stale: 10_000, retries: 0})
    .catch(() => {throw new Error("This agent is being edited. Try again after the other edit finishes.");});
  const temporary = join(directory, `.${name}-${randomUUID()}.tmp`);
  try {
    if (await readCurrent() !== original) throw new Error("This agent changed while the form was open. Reopen it to keep the latest changes.");
    await writeFile(temporary, source, {flag: "wx", mode: 0o600});
    signal?.throwIfAborted();
    await rename(temporary, path);
  } finally {await release(); await rm(temporary, {force: true});}
  return `Saved global agent ${name}. New delegations use this configuration; running agents keep their current configuration.`;
}
