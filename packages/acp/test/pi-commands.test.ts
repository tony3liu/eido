import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { client, methods, type CreateElicitationRequest, type CreateElicitationResponse, type SessionUpdate } from "@agentclientprotocol/sdk";
import { startEidoAgent } from "../src/server.ts";
import { fixtureModel, type FixtureStep } from "./fixture-model.ts";
import { NATIVE_UI_ACTION } from "../src/native-ui.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

async function harness(steps: FixtureStep[] = [], options: {
  setup?: (cwd: string) => Promise<void>;
  configureRuntime?: (runtime: ModelRuntime) => void;
  form?: (params: CreateElicitationRequest, signal: AbortSignal) => Promise<CreateElicitationResponse>;
  native?: (params: {sessionId: string; action: string; data: Record<string, unknown>}) => Promise<Record<string, unknown>>;
} = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "eido-commands-")));
  const settings = JSON.stringify({defaultProvider: "eido-fixture", defaultModel: "scripted", defaultThinkingLevel: "off", compaction: {enabled: false, keepRecentTokens: 100, reserveTokens: 1000}});
  await writeFile(join(cwd, "settings.json"), settings);
  await options.setup?.(cwd);
  const fixture = await fixtureModel(cwd, steps);
  options.configureRuntime?.(fixture.runtime);
  const toAgent = new TransformStream(), toClient = new TransformStream();
  const server = await startEidoAgent(cwd, join(cwd, "sessions"), {readable: toAgent.readable, writable: toClient.writable}, fixture.runtime);
  const updates: {sessionId: string; update: SessionUpdate}[] = [];
  const completedElicitations: string[] = [];
  const connection = client({name: "eido-command-test"})
    .onNotification(methods.client.session.update, ({params}) => { updates.push(params); })
    .onNotification(methods.client.elicitation.complete, ({params}) => {completedElicitations.push(params.elicitationId);})
    .onRequest(methods.client.elicitation.create, ({params, signal}) => options.form?.(params, signal) ?? {action: "cancel"})
    .onRequest(NATIVE_UI_ACTION, {parse: raw => raw as {sessionId: string; action: string; data: Record<string, unknown>}},
      async ({params}) => ({result: await options.native?.(params) ?? {}}))
    .connect({readable: toClient.readable, writable: toAgent.writable});
  await connection.agent.request(methods.agent.initialize, {protocolVersion: 1, clientCapabilities: {
    ...(options.form ? {elicitation: {form: {}}} : {}), ...(options.native ? {_meta: {eidoNativeUi: 1}} : {}),
  }});
  return {
    cwd, settings, updates, completedElicitations, requests: fixture.requests, connection,
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

test("native pi commands route to their owning task and never repeat UI actions during replay", async () => {
  const actions: {sessionId: string; action: string; data: Record<string, unknown>}[] = [];
  const h = await harness([() => 'The actual pi response.'], {native: async params => {actions.push(params); return {handled:true};}});
  try {
    const a = await h.newTask(), b = await h.newTask();
    await h.prompt(a.sessionId, '/copy');
    assert.match(h.text(a.sessionId), /No pi assistant response/);
    assert.equal(actions.length, 0);
    await h.prompt(a.sessionId, 'Reply once.');
    for (const cmd of ['/copy', '/settings', '/hotkeys']) await h.prompt(a.sessionId, cmd);
    assert.deepEqual(actions.map(a => a.action), ['copy','settings','hotkeys']);
    assert.ok(actions.every(action => action.sessionId === a.sessionId));
    assert.equal(actions[0]?.data.text, 'The actual pi response.');
    await h.prompt(b.sessionId, '/settings');
    assert.equal(actions.at(-1)?.sessionId, b.sessionId);
    const count = actions.length;
    await h.connection.agent.request(methods.agent.session.close, {sessionId:a.sessionId});
    await h.connection.agent.request(methods.agent.session.load, {sessionId:a.sessionId,cwd:h.cwd,mcpServers:[]});
    assert.equal(actions.length, count);
    assert.equal(h.requests(), 1);
  } finally {await h.dispose();}
});

test("global access and sign-out honor cancellation and preserve unrelated configuration", async () => {
  let accept = false;
  const h = await harness([], {
    setup: cwd => writeFile(join(cwd, 'fixture-auth.json'), JSON.stringify({deepseek:{type:'api_key',key:'disposable-provider-key'},openai:{type:'api_key',key:'other-key'}})),
    form: async () => ({action:accept ? 'accept' : 'cancel', content:{}}),
  });
  try {
    const task = await h.newTask();
    const before = await readFile(join(h.cwd,'settings.json'),'utf8');
    await h.prompt(task.sessionId, '/trust full');
    assert.equal(await readFile(join(h.cwd,'settings.json'),'utf8'), before);
    await h.prompt(task.sessionId, '/logout deepseek');
    assert.ok(JSON.parse(await readFile(join(h.cwd,'fixture-auth.json'),'utf8')).deepseek);
    accept = true;
    await h.prompt(task.sessionId, '/trust full');
    assert.equal(JSON.parse(await readFile(join(h.cwd,'settings.json'),'utf8')).eido.fullAccess,true);
    await h.prompt(task.sessionId, '/trust ask');
    const settings = JSON.parse(await readFile(join(h.cwd,'settings.json'),'utf8'));
    assert.equal(settings.eido.fullAccess,false);
    assert.equal(settings.defaultProvider,'eido-fixture');
    await h.prompt(task.sessionId, '/logout deepseek');
    const auth = JSON.parse(await readFile(join(h.cwd,'fixture-auth.json'),'utf8'));
    assert.equal(auth.deepseek, undefined);
    assert.equal(auth.openai.key, 'other-key');
    assert.doesNotMatch(h.text(task.sessionId), /disposable-provider-key|other-key/);
    assert.equal(h.requests(),0);
  } finally {await h.dispose();}
});

test("pi sign-in masks secrets and persists credentials only through pi", async () => {
  const secret = 'disposable-auth-fixture-value';
  let cancel = true;
  const h = await harness([], {
    setup: cwd => writeFile(join(cwd, 'fixture-auth.json'), JSON.stringify({deepseek:{type:'api_key',key:'previous-value'},openai:{type:'api_key',key:'unrelated-value'}})),
    form: async params => {
      assert.equal(params.mode, 'form');
      if (params.mode !== 'form') throw new Error('Expected secret form');
      assert.equal(((params as unknown as {requestedSchema:{properties:{value:{_meta:{eidoSecret:boolean}}}}}).requestedSchema.properties.value._meta.eidoSecret), true);
      return cancel ? {action:'cancel'} : {action:'accept',content:{value:secret}};
    },
  });
  try {
    const task = await h.newTask();
    const before = await readFile(join(h.cwd,'fixture-auth.json'),'utf8');
    await h.prompt(task.sessionId,'/login deepseek api_key');
    assert.match(h.text(task.sessionId),/Sign-in cancelled/);
    assert.equal(await readFile(join(h.cwd,'fixture-auth.json'),'utf8'),before);
    cancel = false;
    await h.prompt(task.sessionId,'/login deepseek api_key');
    const auth = JSON.parse(await readFile(join(h.cwd,'fixture-auth.json'),'utf8'));
    assert.equal(auth.deepseek.key,secret);
    assert.equal(auth.openai.key,'unrelated-value');
    assert.match(h.text(task.sessionId),/Signed in to DeepSeek/);
    assert.doesNotMatch(JSON.stringify(h.updates),new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(await h.entries()),new RegExp(secret));
    assert.equal(h.requests(),0);
  } finally {await h.dispose();}
});

test("pi OAuth uses native links and manual codes, completes only successful authorization", {timeout:30_000}, async () => {
  let fail = false;
  const forms: CreateElicitationRequest[] = [];
  const h = await harness([], {
    configureRuntime: runtime => {
      const provider = runtime.getProvider('deepseek')!;
      runtime.registerNativeProvider({...provider, auth:{oauth:{
        name:'Fixture account',
        async login(interaction) {
          interaction.notify({type:'device_code',verificationUri:'https://example.invalid/authorize',userCode:'TEST-CODE'});
          const code = await interaction.prompt({type:'manual_code',message:'Paste fixture code'});
          if (fail) throw new Error('Provider error with secret: ' + code);
          return {type:'oauth',access:code,refresh:'fixture-refresh',expires:Date.now()+3600000};
        },
        refresh: async credential => credential,
        toAuth: async credential => ({apiKey:credential.access}),
      }}});
    },
    form: async params => {
      forms.push(params);
      if (params.mode === 'url') return {action:'accept'};
      assert.equal(((params as unknown as {requestedSchema:{properties:{value:{_meta:{eidoSecret:boolean}}}}}).requestedSchema.properties.value._meta.eidoSecret),true);
      return {action:'accept',content:{value:'secret-code-fixture'}};
    },
  });
  try {
    const task = await h.newTask();
    await h.prompt(task.sessionId,'/login deepseek oauth');
    assert.ok(forms.some(form => form.mode === 'url' && form.message.includes('TEST-CODE')));
    assert.equal(h.completedElicitations.length,1);
    const before = await readFile(join(h.cwd,'fixture-auth.json'),'utf8');
    assert.equal(JSON.parse(before).deepseek.access,'secret-code-fixture');
    fail = true;
    await h.prompt(task.sessionId,'/login deepseek oauth');
    assert.match(h.text(task.sessionId),/Sign-in to DeepSeek failed/);
    assert.equal(h.completedElicitations.length,1);
    assert.equal(await readFile(join(h.cwd,'fixture-auth.json'),'utf8'),before);
    assert.doesNotMatch(JSON.stringify(h.updates),/secret-code-fixture|fixture-refresh/);
    assert.doesNotMatch(JSON.stringify(await h.entries()),/secret-code-fixture|fixture-refresh/);
    assert.equal(h.requests(),0);
  } finally {await h.dispose();}
});

test("cancelling OAuth dismisses the native request and releases the pi turn", {timeout:30_000}, async () => {
  let opened!:()=>void;
  const ready = new Promise<void>(resolve=>{opened=resolve;});
  let dismissed = false;
  const h = await harness([], {
    configureRuntime: runtime => runtime.registerNativeProvider({...runtime.getProvider('deepseek')!,auth:{oauth:{
      name:'Fixture cancel',
      async login(interaction) {
        interaction.notify({type:'auth_url',url:'https://example.invalid/cancel'});
        await new Promise<void>((_resolve,reject)=>{
          if (interaction.signal.aborted) reject(new Error('cancelled'));
          else interaction.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});
        });
        throw new Error('unreachable');
      },
      refresh:async credential=>credential,
      toAuth:async credential=>({apiKey:credential.access}),
    }}}),
    form:async (_params,signal)=>{
      opened();
      await new Promise<void>(resolve=>{
        if(signal.aborted) resolve(); else signal.addEventListener('abort',()=>resolve(),{once:true});
      });
      dismissed=true;
      return {action:'cancel'};
    },
  });
  try {
    const task=await h.newTask();
    const pending=h.prompt(task.sessionId,'/login deepseek oauth');
    await ready;
    await h.connection.agent.notify(methods.agent.session.cancel,{sessionId:task.sessionId});
    assert.equal((await pending).stopReason,'cancelled');
    assert.equal(dismissed,true);
    assert.equal(h.completedElicitations.length,0);
    const auth=await readFile(join(h.cwd,'fixture-auth.json'),'utf8').catch(()=> '{}');
    assert.equal(JSON.parse(auth).deepseek,undefined);
    await h.prompt(task.sessionId,'/session');
    assert.equal(h.requests(),0);
  } finally {await h.dispose();}
});

test("clone and fork create independent pi journals and preserve source history", async () => {
  const actions: {sessionId:string;action:string;data:Record<string,unknown>}[]=[];
  const h=await harness([()=> 'First response.',()=> 'Second response.'],{
    native:async request=>{actions.push(request);return {handled:true};},
  });
  try {
    const task=await h.newTask();
    await h.prompt(task.sessionId,'First user marker');
    await h.prompt(task.sessionId,'Second user marker');
    const sourcePath=(await h.connection.agent.request(methods.agent.session.list,{cwd:h.cwd})).sessions.find(s=>s.sessionId===task.sessionId);
    assert.ok(sourcePath);
    const sourceEntries=await h.entries();
    const user=sourceEntries.find(entry=>entry.type==='message' && entry.message?.role==='user' && JSON.stringify(entry.message.content).includes('Second user marker'));
    await h.prompt(task.sessionId,`/fork ${user.id}`);
    const fork=actions.at(-1)!;
    assert.equal(fork.action,'open_session');
    assert.equal(fork.sessionId,task.sessionId);
    assert.equal(fork.data.draft,'Second user marker');
    assert.notEqual(fork.data.id,task.sessionId);
    await h.connection.agent.request(methods.agent.session.load,{sessionId:fork.data.id as string,cwd:h.cwd,mcpServers:[]});
    assert.match(h.text(fork.data.id as string),/First response/);
    assert.doesNotMatch(h.text(fork.data.id as string),/Second response/);
    await h.prompt(task.sessionId,'/clone');
    const clone=actions.at(-1)!;
    assert.notEqual(clone.data.id,fork.data.id);
    await h.connection.agent.request(methods.agent.session.load,{sessionId:clone.data.id as string,cwd:h.cwd,mcpServers:[]});
    assert.match(h.text(clone.data.id as string),/Second response/);
    assert.ok(h.updates.some(event => event.sessionId === clone.data.id && event.update.sessionUpdate === 'session_info_update' && event.update.title === clone.data.title));
    const files=await readdir(join(h.cwd,'sessions'));
    assert.ok(files.every(file=>!file.startsWith('.session-copy-')));
    assert.equal(h.requests(),2);
  } finally {await h.dispose();}
});

test("native new/resume retains IDs and extension hooks can cancel a transition", async () => {
  const actions: {sessionId:string;action:string;data:Record<string,unknown>}[]=[];
  const h=await harness([],{
    setup:async cwd=>{
      await mkdir(join(cwd,'extensions'));
      await writeFile(join(cwd,'extensions/cancel-switch.js'),`export default pi => pi.on('session_before_switch', event => event.reason === 'new' ? {cancel:true} : undefined);`);
    },
    native:async request=>{actions.push(request);return {handled:true};},
  });
  try {
    const a=await h.newTask(), b=await h.newTask();
    await h.prompt(a.sessionId,'/name First task');
    await h.prompt(b.sessionId,'/name Second task');
    await h.prompt(a.sessionId,'/new');
    assert.match(h.text(a.sessionId),/cancelled by extension/);
    assert.equal(actions.length,0);
    await h.prompt(a.sessionId,`/resume ${b.sessionId}`);
    assert.equal(actions.at(-1)?.data.id,b.sessionId);
    assert.equal(actions.at(-1)?.sessionId,a.sessionId);
    await h.prompt(a.sessionId,`/resume ${a.sessionId}`);
    assert.equal(actions.length,1);
    assert.match(h.text(a.sessionId),/already open/);
    await h.prompt(a.sessionId,'/resume missing');
    assert.equal(actions.length,1);
    assert.equal(h.requests(),0);
  } finally {await h.dispose();}
});

test("import validates JSONL, removes live child ownership and preserves the original file", async () => {
  let accepted=true;
  const actions: {sessionId:string;action:string;data:Record<string,unknown>}[]=[];
  const h=await harness([], {form:async()=>({action:accepted?'accept':'cancel'}),native:async request=>{actions.push(request);return {handled:true};}});
  try {
    const task=await h.newTask();
    const path=join(h.cwd,'import.jsonl');
    const data=[
      {type:'session',version:3,id:'00000000-0000-4000-8000-000000000001',cwd:h.cwd,timestamp:new Date().toISOString()},
      {type:'custom',id:'child123',parentId:null,timestamp:new Date().toISOString(),customType:'eido.subagent.v1',data:{kind:'child',childSessionId:'old-child',parentSessionId:'old-parent',title:'Original scout'}},
      {type:'custom',id:'entry123',parentId:'child123',timestamp:new Date().toISOString(),customType:'eido.command.v1',data:{command:'/session',output:'Imported session marker',status:'completed'}},
    ].map(e=>JSON.stringify(e)).join('\n')+'\n';
    await writeFile(path,data);
    accepted=false;
    await h.prompt(task.sessionId,`/import "${path}"`);
    assert.equal(actions.length,0);
    accepted=true;
    await h.prompt(task.sessionId,`/import "${path}"`);
    const id=actions.at(-1)?.data.id as string;
    assert.ok(id && id!==task.sessionId);
    assert.equal(await readFile(path,'utf8'),data);
    await h.connection.agent.request(methods.agent.session.load,{sessionId:id,cwd:h.cwd,mcpServers:[]});
    assert.match(h.text(id),/Imported session marker/);
    assert.match(h.text(id),/Historical agent: Original scout/);
    const imported=(await readdir(join(h.cwd,'sessions'))).find(path=>path.includes(id))!;
    assert.doesNotMatch(await readFile(join(h.cwd,'sessions',imported),'utf8'),/eido\.subagent\.v1/);
    await writeFile(path,data+'invalid-json');
    await h.prompt(task.sessionId,`/import "${path}"`);
    assert.equal(actions.length,1);
    assert.match(h.text(task.sessionId),/malformed record/);
    for (const bad of [
      data.replace('"parentId":null', '"parentId":"child123"'),
      data.replace('"id":"entry123"', '"id":"child123"'),
      data.replace('"parentId":"child123"', '"parentId":"missing"'),
    ]) {
      await writeFile(path,bad);
      await h.prompt(task.sessionId,`/import "${path}"`);
      assert.equal(actions.length,1);
    }
    assert.match(h.text(task.sessionId),/invalid parent reference/);
    assert.match(h.text(task.sessionId),/duplicate entry IDs/);
    assert.equal(h.requests(),0);
  } finally {await h.dispose();}
});

test("tree navigation replays the selected branch in the same ACP task without repeating actions", async () => {
  const actions:{sessionId:string;action:string;data:Record<string,unknown>}[]=[];
  const h=await harness([()=> 'Earlier branch response.',()=> 'Later branch response.',context=>{
    assert.doesNotMatch(JSON.stringify(context),/Later branch response/);
    return 'New branch response.';
  }],{
    form:async()=>({action:'accept',content:{value:'No summary'}}),
    native:async request=>{actions.push(request);return {handled:true};},
  });
  try {
    const task=await h.newTask();
    await h.prompt(task.sessionId,'First question');
    await h.prompt(task.sessionId,'Later question');
    const earlier=(await h.entries()).find(e=>e.type==='message' && e.message?.role==='assistant' && JSON.stringify(e.message.content).includes('Earlier branch response'));
    await h.prompt(task.sessionId,`/tree ${earlier.id}`);
    const replace=actions.at(-1)!;
    assert.equal(replace.action,'replace_transcript');
    assert.equal(replace.sessionId,task.sessionId);
    assert.match(JSON.stringify(replace.data.updates),/Earlier branch response/);
    assert.doesNotMatch(JSON.stringify(replace.data.updates),/Later branch response/);
    await h.prompt(task.sessionId,'Continue new branch');
    assert.equal(h.requests(),3);
    assert.match(h.text(task.sessionId),/New branch response/);
    // The abandoned branch is still in pi's append-only journal.
    assert.match(JSON.stringify(await h.entries()),/Later branch response/);
    const count=actions.length;
    await h.connection.agent.request(methods.agent.session.close,{sessionId:task.sessionId});
    h.updates.length=0;
    await h.connection.agent.request(methods.agent.session.load,{sessionId:task.sessionId,cwd:h.cwd,mcpServers:[]});
    assert.equal(actions.length,count);
    assert.match(h.text(task.sessionId),/New branch response/);
    assert.doesNotMatch(h.text(task.sessionId),/Later branch response/);
  } finally {await h.dispose();}
});

test("all bundled pi commands are discoverable and native quit follows command journaling", async () => {
  const actions:string[]=[];
  const h=await harness([], {native:async request=>{actions.push(request.action);return {handled:true};}});
  try {
    const task=await h.newTask();
    const expected=['settings','model','tree','thinking','scoped-models','export','import','share','bug','copy','name','session','changelog','hotkeys','fork','clone','trust','login','logout','new','compact','resume','reload','quit'];
    const initial=(task._meta?.eidoCommands as {name:string}[] | undefined)?.map(c=>c.name) ?? [];
    for(const name of expected) assert.ok(initial.includes(name),`Initial state: ${name}`);
    const catalogue=h.updates.flatMap(({update})=>update.sessionUpdate==='available_commands_update'?update.availableCommands.map(c=>c.name):[]);
    for(const name of expected) assert.ok(catalogue.includes(name),name);
    await h.prompt(task.sessionId,'/quit');
    assert.deepEqual(actions,['quit']);
    assert.ok((await h.entries()).some(e=>e.type==='custom' && e.data?.command==='/quit' && e.data.status==='completed'));
    assert.equal(h.requests(),0);
  } finally {await h.dispose();}
});

test("sharing prepares a local artifact and cancellation never publishes", async () => {
  let selection='Export locally';
  let confirmations=0;
  const h=await harness([()=> 'Share fixture response'],{form:async params=>{
    if(params.message==='Share this conversation') return {action:'accept',content:{value:selection}};
    confirmations++;
    return {action:'cancel'};
  }});
  try {
    const task=await h.newTask();
    await h.prompt(task.sessionId,'Share fixture question');
    await h.prompt(task.sessionId,'/share');
    const files=await readdir(join(h.cwd,'exports'));
    assert.equal(files.length,1);
    const exported=await readFile(join(h.cwd,'exports',files[0]!),'utf8');
    const encoded=/<script id="session-data" type="application\/json">([^<]+)<\/script>/.exec(exported)?.[1];
    assert.ok(encoded);
    assert.match(Buffer.from(encoded,'base64').toString('utf8'),/Share fixture response/);
    selection='Secret GitHub gist';
    await h.prompt(task.sessionId,'/share');
    assert.equal(confirmations,1);
    assert.match(h.text(task.sessionId),/Share cancelled/);
    assert.equal(h.requests(),1);
  } finally {await h.dispose();}
});

test("bug reports use pi's local ZIP format and exclude transcript by default", async () => {
  const h=await harness([()=> 'Transcript must stay private marker'],{form:async params=>{
    if(params.message.startsWith('Report a bug')) return {action:'accept',content:{value:'Fixture reproduction steps'}};
    if(params.message.startsWith('Include conversation')) return {action:'accept',content:{value:'Diagnostics only'}};
    return {action:'accept',content:{value:'Keep local ZIP'}};
  }});
  try {
    const task=await h.newTask();
    await h.prompt(task.sessionId,'Fixture message');
    await h.prompt(task.sessionId,'/bug');
    const files=await readdir(join(h.cwd,'reports'));
    assert.equal(files.length,1);
    const archive=await readFile(join(h.cwd,'reports',files[0]!));
    assert.equal(archive.readUInt32LE(0),0x04034b50);
    const {execFile}=await import('node:child_process');
    const {promisify}=await import('node:util');
    const {stdout}=await promisify(execFile)('unzip',['-p',join(h.cwd,'reports',files[0]!)]);
    assert.match(stdout,/Fixture reproduction steps/);
    assert.doesNotMatch(stdout,/Transcript must stay private marker|fixture-never-sent/);
    assert.match(h.text(task.sessionId),/Report saved locally/);
    assert.equal(h.requests(),1);
  } finally {await h.dispose();}
});

test("Radius sharing and bug upload require confirmation and use pi payloads", async t => {
  let allow=false, confirmations=0;
  const uploads:{url:string;body:unknown}[]=[];
  t.mock.method(globalThis,'fetch',async (input: string|URL|Request, init?:RequestInit) => {
    const url=String(input);
    assert.ok(allow, 'No upload before confirmation');
    assert.ok(init?.signal, 'Uploads are cancellable and time bounded');
    uploads.push({url,body:init?.body});
    if(url.includes('/v1/artifacts')) {
      assert.equal(new Headers(init?.headers).get('authorization'),'Bearer radius-fixture-only');
      return Response.json({artifact:{canonical_url:'https://radius.example/artifacts/fixture'}});
    }
    assert.match(url,/\/v1\/bug-reports$/);
    assert.ok(init?.body instanceof FormData);
    return Response.json({ok:true,bug_report:{id:'report-fixture'}});
  });
  const h=await harness([],{
    setup:async cwd=>writeFile(join(cwd,'fixture-auth.json'),JSON.stringify({radius:{type:'api_key',key:'radius-fixture-only'}})),
    form:async params=>{
      if(params.message==='Share this conversation') return {action:'accept',content:{value:'Radius organization'}};
      if(params.message.startsWith('Report a bug')) return {action:'accept',content:{value:'Upload fixture'}};
      if(params.message.startsWith('Include conversation')) return {action:'accept',content:{value:'Diagnostics only'}};
      if(params.message.startsWith('Report prepared')) return {action:'accept',content:{value:'Upload to pi developers'}};
      confirmations++;
      return {action:allow?'accept':'cancel'};
    },
  });
  try {
    const task=await h.newTask();
    await h.prompt(task.sessionId,'/name Sharing fixture');
    await h.prompt(task.sessionId,'/share');
    await h.prompt(task.sessionId,'/bug');
    assert.equal(uploads.length,0);
    allow=true;
    await h.prompt(task.sessionId,'/share');
    await h.prompt(task.sessionId,'/bug');
    assert.equal(confirmations,4,h.text(task.sessionId));
    assert.equal(uploads.length,2);
    assert.equal(typeof uploads[0]!.body,'string');
    assert.match(String(uploads[0]!.body),/"type":"session"/);
    assert.match(h.text(task.sessionId),/https:\/\/radius.example\/artifacts\/fixture/);
    assert.match(h.text(task.sessionId),/Report ID: report-fixture/);
    assert.equal(h.requests(),0);
  } finally {await h.dispose();}
});

test('pi extension UI mirrors native drafts and keeps widgets and controls session-scoped', {timeout: 30_000}, async () => {
  const nativeStates = new Map<string, {instance: string; revision: number; text: string; toolsExpanded: boolean}>();
  const actions: {sessionId: string; action: string; data: Record<string, any>}[] = [];
  const h = await harness([], {
    setup: async cwd => {
      await mkdir(join(cwd, 'extensions'));
      await writeFile(join(cwd, 'extensions/native-ui.js'), `export default function(pi) {
        pi.registerCommand('ui-check', {description: 'Exercise native UI', handler: async (args, ctx) => {
          if (ctx.ui.getEditorText() !== args) throw new Error('Native draft mirror is stale');
          ctx.ui.setStatus('fixture', '\\x1b[34mChecking plugin UI\\x1b[0m');
          ctx.ui.setWidget('help', ['First line', 'Second line']);
          ctx.ui.setWidget('result', ['Below editor'], {placement: 'belowEditor'});
          ctx.ui.setWorkingMessage('Verifying fixture');
          ctx.ui.setWorkingIndicator({frames: ['·', '●'], intervalMs: 100});
          ctx.ui.setWorkingVisible(false);
          ctx.ui.setHiddenThinkingLabel('Reasoning');
          ctx.ui.setEditorText('From extension');
          if (ctx.ui.getEditorText() !== 'From extension') throw new Error('Synchronous setter failed');
          ctx.ui.pasteToEditor(' + pasted');
          ctx.ui.setToolsExpanded(true);
          if (!ctx.ui.getToolsExpanded()) throw new Error('Tool expansion failed');
        }});
        pi.registerCommand('ui-read', {description: 'Read native UI', handler: async (args, ctx) => {
          pi.sendMessage({customType:'fixture-ui', content:ctx.ui.getEditorText(), display:true});
        }});
        pi.registerCommand('ui-clear', {description: 'Clear native UI', handler: async (_, ctx) => {
          ctx.ui.setStatus('fixture', undefined); ctx.ui.setWidget('help', undefined); ctx.ui.setWidget('result', undefined);
          ctx.ui.setWorkingMessage(); ctx.ui.setWorkingIndicator(); ctx.ui.setWorkingVisible(true); ctx.ui.setHiddenThinkingLabel();
          ctx.ui.setToolsExpanded(false);
        }});
      }`);
    },
    form: async () => ({action:'cancel'}),
    native: async request => {
      actions.push(request);
      const state = nativeStates.get(request.sessionId)!;
      if (request.action === 'set_editor') {state.text = request.data.text as string; state.revision++;}
      if (request.action === 'paste_editor') {state.text += request.data.text; state.revision++;}
      if (request.action === 'expand_tools') state.toolsExpanded = request.data.expanded as boolean;
      return {handled:true, editor:{...state}};
    },
  });
  const sync = async (sessionId: string, text: string, revision: number) => {
    const state = {instance:sessionId, revision, text, toolsExpanded:false};
    nativeStates.set(sessionId, state);
    return h.connection.agent.request('_eido/ui/state', {sessionId, ...state});
  };
  try {
    const a = await h.newTask(), b = await h.newTask();
    await sync(a.sessionId, 'Draft A', 1);
    await sync(b.sessionId, 'Draft B', 1);
    await h.prompt(a.sessionId, '/ui-check Draft A');
    assert.equal(nativeStates.get(a.sessionId)?.text, 'From extension + pasted');
    assert.equal(nativeStates.get(b.sessionId)?.text, 'Draft B');
    const last = actions.findLast(x => x.action === 'extension_state' && x.sessionId === a.sessionId)!.data;
    assert.equal(last.statuses.fixture, 'Checking plugin UI');
    assert.equal(last.widgets.result.placement, 'belowEditor');
    assert.deepEqual(last.workingIndicator.frames, ['·', '●']);
    assert.equal(last.workingVisible, false);
    assert.equal(last.hiddenThinkingLabel, 'Reasoning');
    await h.prompt(a.sessionId, '/ui-read');
    assert.match(h.text(a.sessionId), /From extension \+ pasted/);
    await h.prompt(b.sessionId, '/ui-read');
    assert.match(h.text(b.sessionId), /Draft B/);
    await sync(a.sessionId, 'User edit after plugin', 20);
    await h.connection.agent.request('_eido/ui/state', {sessionId:a.sessionId, instance:a.sessionId, revision:2, text:'Stale notification'});
    await h.prompt(a.sessionId, '/ui-read');
    assert.match(h.text(a.sessionId), /User edit after plugin/);
    await h.prompt(a.sessionId, '/ui-clear');
    const cleared = actions.findLast(x => x.action === 'extension_state')!.data;
    assert.deepEqual(cleared.statuses, {}); assert.deepEqual(cleared.widgets, {});
    assert.equal(cleared.workingIndicator, null); assert.equal(cleared.workingVisible, true);
    assert.equal(cleared.workingMessage, null); assert.equal(cleared.hiddenThinkingLabel, null);
    await h.prompt(a.sessionId, '/ui-check User edit after plugin');
    await h.prompt(a.sessionId, '/reload');
    const reloaded = actions.findLast(x => x.action === 'extension_state')!.data;
    assert.deepEqual(reloaded.statuses, {}); assert.deepEqual(reloaded.widgets, {});
    assert.equal(nativeStates.get(a.sessionId)?.text, 'From extension + pasted');
    assert.equal(h.requests(), 0);
  } finally {await h.dispose();}
});
