import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

// pi stores system messages in its transcript. pi-acp 0.9.4's replay
// switch omits this role and returns undefined, aborting session/load.
const directory = new URL("../packages/acp/node_modules/@automatalabs/pi-acp/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", directory), "utf8"));
if (manifest.version !== "0.9.4") throw new Error("Review the Eido replay patch before changing pi-acp versions.");
const path = new URL("dist/replay.js", directory);
const original = await readFile(path, "utf8");
const before = '        case "branchSummary":';
const after = '        case "system":\n        case "branchSummary":';
if (!original.includes(after)) {
  if (createHash("sha256").update(original).digest("hex") !== "00262549fb1c65d1d4e1623ba6150eb51f5de47a8756fbf5e6eed240a879eadf") {
    throw new Error("pi-acp replay source differs from the audited 0.9.4 release.");
  }
  if (!original.includes(before)) throw new Error("Unexpected pi-acp replay implementation.");
  await writeFile(path, original.replace(before, after));
}
console.log("Applied Eido pi-acp system-message replay compatibility patch.");

// Advertise the actual product runtime, keeping the adapter revision in its title.
const pi = JSON.parse(await readFile(new URL("../packages/acp/node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8"));
if (pi.version !== "1.0.2") throw new Error("Review the bundled pi version before updating the ACP runtime.");
const agentPath = new URL("dist/agent.js", directory);
const agentSource = await readFile(agentPath, "utf8");
const agentBefore = 'name: "@automatalabs/pi-acp",\n                title: "pi coding agent",\n                version: PKG_VERSION,';
const agentAfter = 'name: "eido-pi",\n                title: "Eido pi (ACP adapter 0.9.4)",\n                version: "1.0.2",';
if (!agentSource.includes(agentAfter)) {
  if (agentSource.split(agentBefore).length !== 2) throw new Error("Unexpected ACP agent identity; review the patch.");
  await writeFile(agentPath, agentSource.replace(agentBefore, agentAfter));
}

// Eido deliberately supports only global pi settings. This documented pi
// option skips project settings reads and project-scoped resource loading.
const settingsSource = await readFile(agentPath, "utf8");
const settingsBefore = "SettingsManager.create(cwd, agentDir)";
const settingsAfter = "SettingsManager.create(cwd, agentDir, { projectTrusted: false })";
if (!settingsSource.includes(settingsAfter)) {
  if (settingsSource.split(settingsBefore).length !== 2) throw new Error("Unexpected ACP settings construction; review the patch.");
  await writeFile(agentPath, settingsSource.replace(settingsBefore, settingsAfter));
}

// Eido's command bridge is optional and lives in product source. Keep the
// published adapter's turn admission, MCP boundary, cancellation and pump.
// Exact single replacements fail closed on incompatible upstream changes.
async function patchSource(url, before, after) {
  const source = await readFile(url, "utf8");
  if (source.includes(after)) return;
  if (source.split(before).length !== 2) throw new Error(`Review Eido command patch: ${url.pathname}`);
  await writeFile(url, source.replace(before, after));
}
const sessionPath = new URL("dist/session.js", directory);
await patchSource(sessionPath,
  '            const result = await applyConfig(this.pi, this.deps.modelRuntime, this.availableModels, configId, value, this.settingsManager.getEnabledModels());\n            this.availableModels = result.availableModels;\n            this.modelPreferences = result.preferences;\n            return result.configOptions;',
  '            return await this.applyConfigAtBoundary(configId, value);');
await patchSource(sessionPath,
  '    finish(turn, outcome) {',
  '    async applyConfigAtBoundary(configId, value) {\n        const result = await applyConfig(this.pi, this.deps.modelRuntime, this.availableModels, configId, value, this.settingsManager.getEnabledModels());\n        this.availableModels = result.availableModels;\n        this.modelPreferences = result.preferences;\n        return result.configOptions;\n    }\n    finish(turn, outcome) {');
await patchSource(sessionPath,
  '                piPromise = this.pi.prompt(text, { images: converted.images });',
  '                piPromise = (async () => {\n                    const commands = this.pi[Symbol.for("eido.pi.commands")];\n                    if (commands && await commands.run(text, converted.images, this)) return;\n                    return this.pi.prompt(text, { images: converted.images });\n                })();');
await patchSource(sessionPath,
  '        const leaf = this.manager.getLeafEntry();',
  '        const leaf = this.manager.getLeafEntry();\n        if (leaf?.type === "custom" && leaf.customType === "eido.command.v1")\n            return leaf.data?.status === "cancelled" ? "interrupted" : "completed";');
await patchSource(agentPath,
  '            this.live.set(id, wrapper);\n            bindingState.published = true;\n            this.opening.delete(id);\n            return wrapper;',
  '            const commands = pi[Symbol.for("eido.pi.commands")];\n            if (commands) {\n                wrapper.enqueue({ sessionUpdate: "available_commands_update", availableCommands: commands.commands });\n                await wrapper.drain();\n                this.gate(opening);\n            }\n            this.live.set(id, wrapper);\n            bindingState.published = true;\n            this.opening.delete(id);\n            return wrapper;');
if (!(await readFile(path, "utf8")).includes('entry.customType === "eido.command.v1"')) {
  await patchSource(path,
  '        case "custom":\n        case "label":',
  '        case "custom":\n            if (entry.customType === "eido.command.v1" && typeof entry.data?.command === "string" && typeof entry.data?.output === "string") {\n                return [\n                    { sessionUpdate: "user_message_chunk", content: { type: "text", text: entry.data.command } },\n                    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: entry.data.output } },\n                ];\n            }\n            return [];\n        case "label":');
}
await patchSource(path,
  '            if (entry.customType === "eido.command.v1" && typeof entry.data?.command === "string" && typeof entry.data?.output === "string") {',
  '            if (entry.customType === "eido.notice.v1" && typeof entry.data?.text === "string")\n                return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: entry.data.text } }];\n            if (entry.customType === "eido.command.v1" && typeof entry.data?.command === "string" && typeof entry.data?.output === "string") {');

// A local command is a real interaction, even before the first model turn.
// Pi normally keeps setup-only journals in memory. Include Eido's custom
// command record in that persistence gate without adding it to model context.
await patchSource(new URL("../../@earendil-works/pi-coding-agent/dist/core/session-manager.js", directory),
  'return this.fileEntries.some((e) => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"));',
  'return this.fileEntries.some((e) => (e.type === "message" && (e.message.role === "user" || e.message.role === "assistant")) || (e.type === "custom" && e.customType === "eido.command.v1"));');
console.log("Applied Eido pi command discovery, dispatch and history patches.");

await patchSource(path,
  '        case "custom_message":\n            return entry.display\n                ? blocks(entry.content).map((content) => ({\n                    sessionUpdate: "user_message_chunk",',
  '        case "custom_message":\n            return entry.display\n                ? blocks(entry.content).map((content) => ({\n                    sessionUpdate: "agent_message_chunk",');
await patchSource(new URL("dist/translate.js", directory),
  '        case "agent_start":',
  '        case "message_end":\n            if (event.message.role === "custom" && event.message.display) {\n                const content = typeof event.message.content === "string" ? [{ type: "text", text: event.message.content }] : event.message.content ?? [];\n                return content.map((item) => ({ sessionUpdate: "agent_message_chunk", content: item }));\n            }\n            return [];\n        case "session_info_changed":\n            return [{ sessionUpdate: "session_info_update", title: event.name ?? "" }];\n        case "agent_start":');
// For removals the replacement is a substring of the old text, so the
// generic insertion helper's "already patched" check cannot be used.
const translatePath = new URL("dist/translate.js", directory);
for (const [before, after] of [
  ['        case "message_start":\n        case "message_end":', '        case "message_start":'],
  ['        case "entry_appended":\n        case "session_info_changed":', '        case "entry_appended":'],
]) {
  const source = await readFile(translatePath, "utf8");
  if (source.includes(before)) await writeFile(translatePath, source.replace(before, after));
  else if (!source.includes(after)) throw new Error("Review Eido event translation patch.");
}
