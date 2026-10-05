import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { client, methods, type CreateElicitationRequest, type CreateElicitationResponse, type SessionUpdate } from "@agentclientprotocol/sdk";
import { startEidoAgent } from "../src/server.ts";
import { fixtureModel, type FixtureStep } from "./fixture-model.ts";

async function harness(steps: FixtureStep[] = [], options: {
  setup?: (cwd: string) => Promise<void>;
  form?: (params: CreateElicitationRequest, signal: AbortSignal) => Promise<CreateElicitationResponse>;
} = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "eido-commands-")));
  const settings = JSON.stringify({defaultProvider: "eido-fixture", defaultModel: "scripted", defaultThinkingLevel: "off", compaction: {enabled: false, keepRecentTokens: 100, reserveTokens: 1000}});
  await writeFile(join(cwd, "settings.json"), settings);
  await options.setup?.(cwd);
  const fixture = await fixtureModel(cwd, steps);
  const toAgent = new TransformStream(), toClient = new TransformStream();
  const server = await startEidoAgent(cwd, join(cwd, "sessions"), {readable: toAgent.readable, writable: toClient.writable}, fixture.runtime);
  const updates: {sessionId: string; update: SessionUpdate}[] = [];
  const connection = client({name: "eido-command-test"})
    .onNotification(methods.client.session.update, ({params}) => { updates.push(params); })
    .onRequest(methods.client.elicitation.create, ({params, signal}) => options.form?.(params, signal) ?? {action: "cancel"})
    .connect({readable: toClient.readable, writable: toAgent.writable});
  await connection.agent.request(methods.agent.initialize, {protocolVersion: 1, clientCapabilities: options.form ? {elicitation: {form: {}}} : {}});
  return {
    cwd, settings, updates, requests: fixture.requests, connection,
    newTask: () => connection.agent.request(methods.agent.session.new, {cwd, mcpServers: []}),
    prompt: (sessionId: string, text: string) => connection.agent.request(methods.agent.session.prompt, {sessionId, prompt: [{type: "text", text}]}),
    text: (sessionId: string) => updates.filter(item => item.sessionId === sessionId).flatMap(({update}) => update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? [update.content.text] : []).join("\n"),
    entries: async () => {
      const files = await readdir(join(cwd, "sessions"));
      return (await Promise.all(files.filter(file => file.endsWith(".jsonl")).map(file => readFile(join(cwd, "sessions", file), "utf8")))).flatMap(text => text.trim().split("\n").map(line => JSON.parse(line)));
    },
    dispose: async () => {await server.agent.dispose(); connection.close(); server.connection.close(); await rm(cwd, {recursive: true, force: true});},
  };
}

test("ACP discovers pi commands; local commands persist and replay without model inference", {timeout: 30_000}, async () => {
  const h = await harness([context => {
    assert.doesNotMatch(JSON.stringify(context), /private-command-marker|pi session|Supported commands:/);
    return "Normal conversation.";
  }]);
  try {
    const a = await h.newTask();
    const discovered = h.updates.find(item => item.sessionId === a.sessionId && item.update.sessionUpdate === "available_commands_update")?.update;
    assert.equal(discovered?.sessionUpdate, "available_commands_update");
    if (discovered?.sessionUpdate !== "available_commands_update") throw new Error("Missing catalogue");
    assert.deepEqual(discovered.availableCommands.slice(0, 5).map(command => command.name), ["session", "name", "model", "thinking", "compact"]);
    await h.prompt(a.sessionId, "/name private-command-marker");
    assert.ok(h.updates.some(({update}) => update.sessionUpdate === "session_info_update" && update.title === "private-command-marker"));
    for (const command of ["/session", "/name", "/model", "/thinking", "/thinking off", "/model eido-fixture/scripted"]) {
      assert.equal((await h.prompt(a.sessionId, command)).stopReason, "end_turn");
    }
    assert.equal(h.requests(), 0);
    assert.match(h.text(a.sessionId), /Messages: 0 user, 0 assistant/);
    assert.ok(h.updates.some(({update}) => update.sessionUpdate === "config_option_update"));
    assert.equal(await readFile(join(h.cwd, "settings.json"), "utf8"), h.settings);
    const before = await h.entries();
    assert.ok(before.some(entry => entry.type === "custom" && entry.customType === "eido.command.v1"));
    assert.ok(!before.some(entry => entry.type === "message"));
    const list = await h.connection.agent.request(methods.agent.session.list, {cwd: h.cwd});
    assert.equal(list.sessions.find(session => session.sessionId === a.sessionId)?.title, "private-command-marker");
    await h.connection.agent.request(methods.agent.session.close, {sessionId: a.sessionId});
    h.updates.length = 0;
    await h.connection.agent.request(methods.agent.session.load, {sessionId: a.sessionId, cwd: h.cwd, mcpServers: []});
    assert.match(h.text(a.sessionId), /Session name: private-command-marker/);
    assert.ok(h.updates.some(({update}) => update.sessionUpdate === "user_message_chunk" && update.content.type === "text" && update.content.text === "/session"));
    assert.ok(h.updates.some(({update}) => update.sessionUpdate === "available_commands_update"));
    assert.equal(h.requests(), 0);
    await h.prompt(a.sessionId, "Normal prompt after local commands.");
    assert.equal(h.requests(), 1);
    const b = await h.newTask();
    await h.prompt(b.sessionId, "/name");
    assert.match(h.text(b.sessionId), /no name yet/);
  } finally { await h.dispose(); }
});

test("pi extension commands, prompt templates and skills use the dynamic ACP catalogue", {timeout: 30_000}, async () => {
  const received: CreateElicitationRequest[] = [];
  const h = await harness([
    context => {assert.match(JSON.stringify(context), /Explain orchard precisely/); return "Template expanded.";},
    context => {assert.match(JSON.stringify(context), /Use the fixture skill rules/); return "Skill expanded.";},
  ], {
    setup: async cwd => {
      await mkdir(join(cwd, "extensions"));
      await writeFile(join(cwd, "extensions/survey.js"), `export default function(pi) {
        pi.registerCommand("survey", {description: "Choose a fixture value", handler: async (args, ctx) => {
          if (!ctx.hasUI || ctx.mode !== "rpc") throw new Error("Missing native dialog binding");
          const selected = await ctx.ui.select("Fixture choice", ["Orchard", "Garden"]);
          if (selected) ctx.ui.notify("Selected " + selected);
          const value = await ctx.ui.input("Fixture input", "A short value");
          const confirmed = await ctx.ui.confirm("Fixture confirmation", "Use the entered value?");
          const edited = await ctx.ui.editor("Fixture editor", "First line\\nSecond line");
          if (edited !== "Edited first\\nEdited second") throw new Error("Editor lost line breaks");
          pi.sendMessage({customType:"fixture-survey", content: "Survey: " + selected + "/" + value + "/" + confirmed, display:true});
        }});
      }`);
      await mkdir(join(cwd, "prompts"));
      await writeFile(join(cwd, "prompts/brief.md"), "---\ndescription: Fixture template\n---\nExplain $1 precisely");
      await mkdir(join(cwd, "skills/fixture"), {recursive: true});
      await writeFile(join(cwd, "skills/fixture/SKILL.md"), "---\nname: fixture\ndescription: Fixture skill\n---\nUse the fixture skill rules");
    },
    form: async params => {
      received.push(params);
      if (params.message === "Fixture choice") return {action: "accept", content: {value: "Orchard"}};
      if (params.message === "Fixture input") return {action: "accept", content: {value: "local"}};
      if (params.message === "Fixture editor") {
        assert.equal(params.mode, "form");
        const schema = params.requestedSchema as {properties: {value: {_meta?: {eidoMultiline?: boolean}}}};
        assert.equal(schema.properties.value._meta?.eidoMultiline, true);
        return {action: "accept", content: {value: "Edited first\nEdited second"}};
      }
      return {action: "accept"};
    },
  });
  try {
    const a = await h.newTask();
    const catalogue = h.updates.flatMap(({update}) => update.sessionUpdate === "available_commands_update" ? update.availableCommands.map(command => command.name) : []);
    assert.ok(catalogue.includes("survey") && catalogue.includes("brief") && catalogue.includes("skill:fixture"), catalogue.join(","));
    await h.prompt(a.sessionId, "/survey");
    assert.equal(h.requests(), 0);
    assert.equal(received.length, 4);
    assert.ok(received.every(request => "sessionId" in request && request.sessionId === a.sessionId && request.mode === "form"));
    assert.match(h.text(a.sessionId), /Selected Orchard/);
    assert.match(h.text(a.sessionId), /Survey: Orchard\/local\/true/);
    await h.prompt(a.sessionId, "/brief orchard");
    await h.prompt(a.sessionId, "/skill:fixture");
    assert.equal(h.requests(), 2);
    await h.connection.agent.request(methods.agent.session.close, {sessionId: a.sessionId});
    h.updates.length = 0;
    await h.connection.agent.request(methods.agent.session.load, {sessionId: a.sessionId, cwd: h.cwd, mcpServers: []});
    assert.match(h.text(a.sessionId), /Selected Orchard/);
    assert.match(h.text(a.sessionId), /Survey: Orchard\/local\/true/);
  } finally { await h.dispose(); }
});

test("native model form selection applies config; cancelling a dialog releases the turn", {timeout: 30_000}, async () => {
  let cancelForm = false;
  let began!: () => void;
  const started = new Promise<void>(resolve => {began = resolve;});
  let dismissed = false;
  const h = await harness([], {form: async (_params, signal) => {
    if (!cancelForm) return {action: "accept", content: {value: "off"}};
    began();
    await new Promise<void>(resolve => {
      if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), {once: true});
    });
    dismissed = true;
    return {action: "cancel"};
  }});
  try {
    const a = await h.newTask();
    await h.prompt(a.sessionId, "/thinking");
    assert.ok(h.updates.some(({update}) => update.sessionUpdate === "config_option_update"));
    cancelForm = true;
    const pending = h.prompt(a.sessionId, "/thinking");
    await started;
    await h.connection.agent.notify(methods.agent.session.cancel, {sessionId: a.sessionId});
    assert.equal((await pending).stopReason, "cancelled");
    assert.equal(dismissed, true);
    await h.prompt(a.sessionId, "/session");
    assert.equal(h.requests(), 0);
  } finally { await h.dispose(); }
});

test("invalid, unknown and attached commands never reach the model or mutate configuration", {timeout: 30_000}, async () => {
  const h = await harness();
  try {
    const a = await h.newTask();
    for (const command of ["/session extra", "/model missing/model", "/thinking impossible", "/name first\nsecond", "/reload extra", "/changelog extra", "/unknown", "/"]) {
      h.updates.length = 0;
      await h.prompt(a.sessionId, command);
      assert.match(h.text(a.sessionId), /^Command failed:/);
    }
    h.updates.length = 0;
    await h.connection.agent.request(methods.agent.session.prompt, {sessionId: a.sessionId, prompt: [{type: "text", text: "/name changed"}, {type: "image", data: "AA==", mimeType: "image/png"}]});
    assert.match(h.text(a.sessionId), /do not accept image attachments/);
    await h.prompt(a.sessionId, "/name");
    assert.match(h.text(a.sessionId), /no name yet/);
    await h.prompt(a.sessionId, "/compact");
    assert.match(h.text(a.sessionId), /Nothing to compact/);
    assert.equal(h.requests(), 0);
    assert.equal(await readFile(join(h.cwd, "settings.json"), "utf8"), h.settings);
  } finally { await h.dispose(); }
});

test("reload refreshes commands and templates while preserving the session and model", {timeout: 30_000}, async () => {
  const h = await harness([context => {
    assert.match(JSON.stringify(context), /Fresh template orchard/);
    return "Model still usable after reload.";
  }]);
  try {
    const a = await h.newTask();
    await h.prompt(a.sessionId, "/name Reload fixture");
    await mkdir(join(h.cwd, "prompts"));
    await writeFile(join(h.cwd, "prompts/fresh.md"), "Fresh template $1");
    await h.prompt(a.sessionId, "/reload");
    assert.match(h.text(a.sessionId), /Reloaded global pi/);
    assert.ok(h.updates.some(({update}) => update.sessionUpdate === "available_commands_update" && update.availableCommands.some(command => command.name === "fresh")));
    assert.equal(h.requests(), 0);
    await h.prompt(a.sessionId, "/fresh orchard");
    assert.equal(h.requests(), 1);
    assert.match(h.text(a.sessionId), /Model still usable after reload/);
    await h.prompt(a.sessionId, "/name");
    assert.match(h.text(a.sessionId), /Session name: Reload fixture/);
  } finally { await h.dispose(); }
});

test("model shortlist saves global pi preferences and rejects unmatched patterns", {timeout: 30_000}, async () => {
  const h = await harness();
  try {
    const a = await h.newTask();
    await h.prompt(a.sessionId, "/scoped-models eido-fixture/*");
    assert.match(h.text(a.sessionId), /Global model shortlist: eido-fixture\/\*/);
    const saved = await readFile(join(h.cwd, "settings.json"), "utf8");
    assert.deepEqual(JSON.parse(saved).enabledModels, ["eido-fixture/*"]);
    assert.ok(h.updates.some(({update}) => update.sessionUpdate === "config_option_update" && JSON.stringify(update.configOptions).includes('"preferred":["eido-fixture/scripted"]')));
    await h.prompt(a.sessionId, "/scoped-models missing/no-such-model");
    assert.match(h.text(a.sessionId), /Unmatched model patterns/);
    assert.equal(await readFile(join(h.cwd, "settings.json"), "utf8"), saved);
    await h.prompt(a.sessionId, "/scoped-models all");
    assert.equal(JSON.parse(await readFile(join(h.cwd, "settings.json"), "utf8")).enabledModels, undefined);
    assert.equal(h.requests(), 0);
  } finally { await h.dispose(); }
});

test("reload reports broken extensions, removes stale commands, and recovers native dialogs", {timeout: 30_000}, async () => {
  const source = `export default pi => pi.registerCommand("reload-check", {
    description: "Reload fixture", handler: async (_args, ctx) => {
      const confirmed = await ctx.ui.confirm("Reload confirmation", "Continue?");
      pi.sendMessage({customType: "reload-check", content: "Reload dialog: " + confirmed, display: true});
    }
  });`;
  let forms = 0;
  const h = await harness([], {
    setup: async cwd => { await mkdir(join(cwd, "extensions")); await writeFile(join(cwd, "extensions/reload-check.js"), source); },
    form: async () => { forms++; return {action: "accept"}; },
  });
  try {
    const a = await h.newTask();
    await writeFile(join(h.cwd, "extensions/reload-check.js"), "export default () => { throw new Error('Fixture load failure'); }");
    h.updates.length = 0;
    await h.prompt(a.sessionId, "/reload");
    assert.match(h.text(a.sessionId), /Reload completed with extension errors/);
    assert.ok(h.updates.some(({update}) => update.sessionUpdate === "available_commands_update" && !update.availableCommands.some(command => command.name === "reload-check")));
    await writeFile(join(h.cwd, "extensions/reload-check.js"), source);
    await h.prompt(a.sessionId, "/reload");
    await h.prompt(a.sessionId, "/reload-check");
    assert.equal(forms, 1);
    assert.match(h.text(a.sessionId), /Reload dialog: true/);
    assert.equal(h.requests(), 0);
  } finally { await h.dispose(); }
});

test("exports use pi formats, refuse overwrite and clean temporary files; changelog is bundled", {timeout: 30_000}, async () => {
  const h = await harness();
  try {
    const a = await h.newTask();
    await h.prompt(a.sessionId, "/name Export fixture");
    for (const extension of ["html", "jsonl"]) {
      const path = join(h.cwd, `fixture export.${extension}`);
      await h.prompt(a.sessionId, `/export "${path}"`);
      const exported = await readFile(path, "utf8");
      if (extension === "html") assert.match(exported, /<!DOCTYPE html>/i);
      else assert.equal(JSON.parse(exported.trim().split("\n")[0]!).id, a.sessionId);
      await h.prompt(a.sessionId, `/export "${path}"`);
      assert.match(h.text(a.sessionId), /destination already exists/);
      assert.equal(await readFile(path, "utf8"), exported);
    }
    await h.prompt(a.sessionId, "/export");
    const exports = await readdir(join(h.cwd, "exports"));
    assert.equal(exports.length, 1);
    assert.ok(exports[0]?.endsWith(".html"));
    await h.prompt(a.sessionId, "/changelog");
    assert.match(h.text(a.sessionId), /1\.0\.2/);
    assert.equal(h.requests(), 0);
  } finally { await h.dispose(); }
});

test("compact runs pi's real summarization path and records a resumable compaction", {timeout: 30_000}, async () => {
  const h = await harness([
    () => "Earlier context. ".repeat(400),
    () => "Recent answer.",
    context => {assert.match(JSON.stringify(context), /context summarization assistant/); return "Summary: keep the orchard marker.";},
  ]);
  try {
    const a = await h.newTask();
    await h.prompt(a.sessionId, "Remember the orchard marker. ".repeat(100));
    await h.prompt(a.sessionId, "Continue.");
    h.updates.length = 0;
    assert.equal((await h.prompt(a.sessionId, "/compact retain the marker")).stopReason, "end_turn");
    assert.equal(h.requests(), 3);
    assert.match(h.text(a.sessionId), /Context compacted:/);
    assert.match(h.text(a.sessionId), /orchard marker/);
    assert.ok((await h.entries()).some(entry => entry.type === "compaction"));
    await h.connection.agent.request(methods.agent.session.close, {sessionId: a.sessionId});
    await h.connection.agent.request(methods.agent.session.load, {sessionId: a.sessionId, cwd: h.cwd, mcpServers: []});
    assert.equal(h.requests(), 3);
  } finally { await h.dispose(); }
});

test("compaction cancellation reserves one ACP turn while other tasks remain usable", {timeout: 30_000}, async () => {
  let began!: () => void;
  const started = new Promise<void>(resolve => {began = resolve;});
  const h = await harness([
    () => "Earlier context. ".repeat(400),
    () => "Recent answer.",
    async (_context, signal) => {
      began();
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) reject(new Error("cancelled"));
        else signal?.addEventListener("abort", () => reject(new Error("cancelled")), {once: true});
      });
      return "Unreachable summary";
    },
    () => "Task remains usable.",
  ]);
  try {
    const a = await h.newTask(), b = await h.newTask();
    await h.prompt(a.sessionId, "Remember the orchard. ".repeat(100));
    await h.prompt(a.sessionId, "Continue.");
    const pending = h.prompt(a.sessionId, "/compact");
    await started;
    await assert.rejects(h.prompt(a.sessionId, "/name must-not-change"));
    await assert.rejects(h.connection.agent.request(methods.agent.session.setConfigOption, {sessionId: a.sessionId, configId: "thinkingLevel", value: "off"}));
    await h.prompt(b.sessionId, "/session");
    assert.equal(h.requests(), 3);
    await h.connection.agent.notify(methods.agent.session.cancel, {sessionId: a.sessionId});
    assert.equal((await pending).stopReason, "cancelled");
    assert.ok(!(await h.entries()).some(entry => entry.type === "compaction"));
    assert.equal((await h.prompt(a.sessionId, "Continue after cancellation.")).stopReason, "end_turn");
    assert.equal(h.requests(), 4);
  } finally { await h.dispose(); }
});
