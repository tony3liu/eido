import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {once} from 'node:events';
import { client, methods, type AgentContext, type CreateElicitationRequest, type CreateElicitationResponse, type SessionUpdate } from "@agentclientprotocol/sdk";
import { startEidoAgent } from "../src/server.ts";
import { fixtureModel, type FixtureStep } from "./fixture-model.ts";
import { NATIVE_UI_ACTION } from "../src/native-ui.ts";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {createPiUIState} from '../src/pi-ui-state.ts';
import {setTimeout as delay} from 'node:timers/promises';

async function harness(steps: FixtureStep[] = [], options: {
  setup?: (cwd: string) => Promise<void>;
  configureRuntime?: (runtime: ModelRuntime) => void;
  form?: (params: CreateElicitationRequest, signal: AbortSignal) => Promise<CreateElicitationResponse>;
  native?: (params: {sessionId: string; action: string; data: Record<string, unknown>}) => Promise<Record<string, unknown>>;
  terminal?: (method:string, params:any) => Promise<any>;
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
    .onRequest(methods.client.terminal.create, ({params}) => options.terminal!(methods.client.terminal.create,params))
    .onRequest(methods.client.terminal.release, ({params}) => options.terminal!(methods.client.terminal.release,params))
    .onRequest(methods.client.terminal.waitForExit, ({params}) => options.terminal!(methods.client.terminal.waitForExit,params))
    .onRequest(NATIVE_UI_ACTION, {parse: raw => raw as {sessionId: string; action: string; data: Record<string, unknown>}},
      async ({params}) => ({result: await options.native?.(params) ?? {}}))
    .connect({readable: toClient.readable, writable: toAgent.writable});
  await connection.agent.request(methods.agent.initialize, {protocolVersion: 1, clientCapabilities: {
    ...(options.form ? {elicitation: {form: {}}} : {}), ...(options.native ? {_meta: {eidoNativeUi: 1}} : {}),
    ...(options.terminal ? {terminal:true} : {}),
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

test('plugin command history retains order, cancellation and identity without model messages or replayed execution', {timeout:30_000}, async () => {
  let ready!:()=>void, release!:()=>void;
  const began = new Promise<void>(resolve=>{ready=resolve;}), gate = new Promise<void>(resolve=>{release=resolve;});
  const h = await harness([context=>{
    assert.doesNotMatch(JSON.stringify(context.messages), /command-secret|history-echo|history-hold/);
    return 'Only the ordinary prompt reached the model.';
  }], {setup:async cwd=>{
    await mkdir(join(cwd,'extensions'));
    await writeFile(join(cwd,'extensions/history.js'), `export default pi => {
      let count = 0;
      pi.registerCommand('history-echo', {handler:async(args,ctx)=>{ctx.ui.notify('Echo '+(++count)+': '+args);}});
      pi.registerCommand('history-hold', {handler:async(_,ctx)=>{ctx.ui.notify('Hold entered');await ctx.ui.input('Hold gate');ctx.ui.notify('Hold settled');}});
    };`);
  }, form:async()=>{ready();await gate;return {action:'cancel'};}, native:async()=>({handled:true})});
  try {
    const task = await h.newTask();
    const echo = {sessionId:task.sessionId, prompt:[{type:'text' as const,text:'/history-echo command-secret  '}],_meta:{eidoDeliveryId:'history-echo-delivery'}};
    await h.connection.agent.request(methods.agent.session.prompt,echo);
    await h.connection.agent.request(methods.agent.session.prompt,echo);
    const hold = {...echo,prompt:[{type:'text' as const,text:'/history-hold'}],_meta:{eidoDeliveryId:'history-hold-delivery'}};
    const pending = h.connection.agent.request(methods.agent.session.prompt,hold);
    await began;
    await h.connection.agent.notify(methods.agent.session.cancel,{sessionId:task.sessionId});
    release();
    assert.equal((await pending as {stopReason:string}).stopReason,'cancelled');
    await h.prompt(task.sessionId,'/session');
    const before = await h.entries();
    assert.equal(before.filter(entry=>entry.type==='message').length,0,'local commands are never model messages');
    const inputs = before.filter(entry=>entry.customType==='eido.command.input.v1');
    assert.deepEqual(inputs.map(entry=>entry.data.command),['/history-echo command-secret  ','/history-hold']);
    assert.equal(before.find(entry=>entry.customType==='eido.command.result.v1'&&entry.data.commandId===inputs[1].id)?.data.status,'cancelled');
    await h.connection.agent.request(methods.agent.session.close,{sessionId:task.sessionId});
    h.updates.length=0;
    await h.connection.agent.request(methods.agent.session.load,{sessionId:task.sessionId,cwd:h.cwd,mcpServers:[]});
    const chunks = h.updates.map(({update})=>update).filter(update=>['user_message_chunk','agent_message_chunk'].includes(update.sessionUpdate));
    const users = chunks.filter(update=>update.sessionUpdate==='user_message_chunk');
    assert.deepEqual(users.map(update=>update.sessionUpdate==='user_message_chunk'&&update.content.type==='text'?update.content.text:''),['/history-echo command-secret  ','/history-hold','/session']);
    assert.equal(users[0]?.sessionUpdate==='user_message_chunk'&&users[0].messageId, inputs[0].id);
    const serialized = chunks.map(update=>JSON.stringify(update));
    const at=(value:string)=>serialized.findIndex(text=>text.includes(value));
    assert.ok(at('/history-echo')<at('Echo 1:'));
    assert.ok(at('Echo 1:')<at('/history-hold'));
    assert.ok(at('/history-hold')<at('Hold entered'));
    assert.equal(h.requests(),0);
    assert.equal((await h.entries()).filter(entry=>entry.customType==='eido.command.input.v1').length,2,'reload cannot execute commands');
    await h.connection.agent.request(methods.agent.session.prompt,echo);
    await assert.rejects(h.connection.agent.request(methods.agent.session.prompt,hold),/may already have run/);
    await h.prompt(task.sessionId,'Ordinary prompt');
    assert.equal(h.requests(),1);
  } finally {release();await h.dispose();}
});

test('pi argument callbacks and stacked autocomplete providers use the native completion RPC without sending a prompt', {timeout: 20_000}, async () => {
  const h = await harness([], {
    native: async () => ({handled: true}), form: async () => ({action: 'cancel'}),
    setup: async cwd => {
      await mkdir(join(cwd, 'extensions'));
      await writeFile(join(cwd, 'extensions/completions.js'), `export default function(pi) {
        pi.registerCommand('review', {
          description:'Review modes',
          async getArgumentCompletions(prefix) {
            return ['quick','thorough'].filter(value=>value.startsWith(prefix)).map(value=>({value,label:value,description:'Review '+value}));
          },
          handler:()=>{throw new Error('Selecting completion must not execute a command');}
        });
        pi.on('session_start',(_,ctx)=>{
          ctx.ui.addAutocompleteProvider(current=>({
            ...current,
            async getSuggestions(lines,row,col,options) {
              const before=lines[row].slice(0,col);
              if (before.endsWith('~pair')) return {items:[{value:'pair',label:'Pair template'}],prefix:'~pair'};
              if (before==='slow') {await new Promise(resolve=>setTimeout(resolve,200)); return {items:[{value:'old',label:'Old'}],prefix:'slow'};}
              if (before==='badedit') return {items:[{value:'badedit',label:'Bad edit'}],prefix:'badedit'};
              if (before==='bad') return {items:[{value:42,label:'Invalid'}],prefix:'bad'};
              return current.getSuggestions(lines,row,col,options);
            },
            applyCompletion(lines,row,col,item,prefix) {
              ctx.ui.notify('Applied '+item.value);
              if(item.value==='badedit')return {lines:['中文'],cursorLine:0,cursorCol:99};
              if(item.value!=='pair')return current.applyCompletion(lines,row,col,item,prefix);
              const next=[...lines];next[row]=lines[row].slice(0,col-prefix.length)+'pair()'+lines[row].slice(col);
              return {lines:next,cursorLine:row,cursorCol:col-prefix.length+5};
            }
          }));
          ctx.ui.addAutocompleteProvider(current=>({...current,async getSuggestions(...args){
            const result=await current.getSuggestions(...args);
            return result?{...result,items:result.items.map(item=>({...item,label:'Native '+item.label}))}:null;
          }}));
        });
      }`);
    },
  });
  type Candidate = {id: string; label: string};
  const complete = (sessionId: string, text: string, cursor = Buffer.byteLength(text)) => h.connection.agent.request('_eido/ui/complete', {sessionId, text, cursor}) as Promise<{handled: boolean; items: Candidate[]}>;
  const select = (sessionId: string, text: string, item: Candidate, cursor = Buffer.byteLength(text)) => h.connection.agent.request('_eido/ui/complete', {sessionId, text, cursor, selection:item.id}) as Promise<{handled:boolean; text?:string; cursor?:number}>;
  const first = async (sessionId:string, text:string, cursor = Buffer.byteLength(text)) => select(sessionId,text,(await complete(sessionId,text,cursor)).items[0]!,cursor);
  try {
    const a = await h.newTask(), b = await h.newTask();
    for (const task of [a,b]) await h.connection.agent.request('_eido/ui/state', {sessionId:task.sessionId, instance:task.sessionId, revision:1, text:''});
    const args = await complete(a.sessionId, '/review qu');
    assert.equal(args.handled, true); assert.equal(args.items[0]?.label, 'Native quick');
    assert.doesNotMatch(h.text(a.sessionId), /Applied/);
    assert.equal('text' in args.items[0]!, false);
    const applied = await select(a.sessionId, '/review qu', args.items[0]!);
    assert.equal(applied.text, '/review quick');
    assert.equal(applied.cursor, Buffer.byteLength('/review quick'));
    assert.equal((await select(a.sessionId, '/review qu', args.items[0]!)).handled, false);
    assert.equal((h.text(a.sessionId).match(/Applied quick/g)??[]).length, 1);
    const unicode = await first(a.sessionId, '中文\n~pair suffix', Buffer.byteLength('中文\n~pair'));
    assert.equal(unicode.text, '中文\npair() suffix');
    assert.equal(unicode.cursor, Buffer.byteLength('中文\npair('));
    assert.equal((await first(a.sessionId, '/think')).text, '/thinking ');
    assert.equal((await first(a.sessionId, '/thinking of')).text, '/thinking off');
    const stale = await complete(a.sessionId,'/review qu');
    assert.equal((await select(b.sessionId,'/review qu',stale.items[0]!)).handled,false);
    assert.equal((await select(a.sessionId,'changed',stale.items[0]!)).handled,false);
    assert.equal((await select(a.sessionId,'/review qu',stale.items[0]!)).handled,false);
    assert.equal((await first(a.sessionId,'badedit')).handled,false);
    assert.match(h.text(a.sessionId),/Invalid autocomplete edit/);
    const slow = complete(a.sessionId, 'slow');
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok((await first(a.sessionId, '/review th')).text?.includes('thorough'));
    assert.deepEqual(await slow, {handled:false,items:[]});
    assert.deepEqual(await complete(a.sessionId, 'bad'), {handled:false,items:[]});
    assert.match(h.text(a.sessionId), /Invalid autocomplete item/);
    await assert.rejects(complete(a.sessionId, '中文', 1));
    await assert.rejects(complete(a.sessionId, 'x'.repeat(70_000)));
    const beforeReload = await complete(a.sessionId,'~pair');
    await writeFile(join(h.cwd,'extensions/completions.js'), 'export default function() {}');
    await h.prompt(a.sessionId, '/reload');
    assert.deepEqual(await complete(a.sessionId, '~pair'), {handled:false,items:[]});
    assert.equal((await select(a.sessionId,'~pair',beforeReload.items[0]!)).handled,false);
    assert.equal((await first(b.sessionId, '~pair')).text, 'pair()');
    assert.equal(h.requests(), 0);
  } finally {await h.dispose();}
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
    assert.equal((await pending as {stopReason:string}).stopReason,'cancelled');
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

test('explicit resume focuses a foreign workspace owner without loading into the wrong project', async () => {
  const actions: {sessionId:string;action:string;data:Record<string,unknown>}[]=[];
  let focused=true;
  const h=await harness([], {
    setup:async cwd=>{
      await mkdir(join(cwd,'extensions'));
      await writeFile(join(cwd,'extensions/cancel-switch.js'),`export default pi => pi.on('session_before_switch', event => event.targetSessionFile?.includes('never-match') ? {cancel:true} : undefined);`);
    },
    native:async request=>{actions.push(request);return {focused};},
  });
  try {
    const other=join(h.cwd,'other');await mkdir(other);
    const a=await h.newTask();
    const b=await h.connection.agent.request(methods.agent.session.new,{cwd:other,mcpServers:[]});
    await h.prompt(b.sessionId,'/name Foreign workspace');
    await h.prompt(a.sessionId,`/resume ${b.sessionId}`);
    assert.deepEqual(actions.at(-1),{sessionId:a.sessionId,action:'focus_session',data:{id:b.sessionId}});
    assert.match(h.text(a.sessionId),/Switched to task Foreign workspace/);
    focused=false;
    await h.prompt(a.sessionId,`/resume ${b.sessionId}`);
    assert.match(h.text(a.sessionId),/Open this task's workspace/);
    assert.ok(actions.every(action=>action.action!=='open_session'));
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

test("tree summaries retain abandoned context, use custom instructions and honor reload skip settings", async () => {
  const actions: {action:string;data:Record<string,unknown>}[]=[];
  const forms:string[]=[];
  const h=await harness([
    ()=> 'First branch response.',
    ()=> 'Abandoned branch evidence.',
    context=>{
      assert.match(JSON.stringify(context),/Abandoned branch evidence/);
      assert.match(JSON.stringify(context),/Preserve the reproduction steps/);
      return 'Branch summary: preserved abandoned evidence.';
    },
    context=>{
      assert.match(JSON.stringify(context),/Branch summary: preserved abandoned evidence/);
      return 'Continued with branch summary.';
    },
  ],{
    form:async params=>{
      forms.push(params.message);
      return {action:'accept',content:{value:params.message.startsWith('Summarize the branch')?'Summarize with instructions':'Preserve the reproduction steps'}};
    },
    native:async request=>{actions.push(request);return {handled:true};},
  });
  try {
    const task=await h.newTask();
    await h.prompt(task.sessionId,'First question');
    await h.prompt(task.sessionId,'Abandoned branch question');
    const entries=await h.entries();
    const earlier=entries.find(entry=>entry.type==='message' && entry.message?.role==='assistant' && JSON.stringify(entry.message.content).includes('First branch response'));
    const later=entries.find(entry=>entry.type==='message' && entry.message?.role==='assistant' && JSON.stringify(entry.message.content).includes('Abandoned branch evidence'));
    await h.prompt(task.sessionId,`/tree ${earlier.id}`);
    assert.equal(h.requests(),3);
    assert.match(JSON.stringify(actions.at(-1)?.data),/Branch summary: preserved abandoned evidence/);
    assert.ok((await h.entries()).some(entry=>entry.type==='branch_summary'));
    assert.equal(forms.length,2);
    await h.prompt(task.sessionId,'Continue with the summary');
    assert.equal(h.requests(),4);
    await h.connection.agent.request(methods.agent.session.close,{sessionId:task.sessionId});
    h.updates.length=0;
    await h.connection.agent.request(methods.agent.session.load,{sessionId:task.sessionId,cwd:h.cwd,mcpServers:[]});
    assert.equal(h.text(task.sessionId).split('Branch summary: preserved abandoned evidence.').length-1,1);
    assert.match(h.text(task.sessionId),/Continued with branch summary/);
    assert.equal(h.requests(),4,'Reopening only replays the journal');
    await writeFile(join(h.cwd,'settings.json'),JSON.stringify({...JSON.parse(h.settings),branchSummary:{skipPrompt:true,reserveTokens:4096}}));
    await h.prompt(task.sessionId,'/reload');
    await h.prompt(task.sessionId,`/tree ${later.id}`);
    assert.equal(forms.length,2,'Skip summary prompt must not open another form');
    assert.equal(h.requests(),4,'Skip prompt switches without generating a summary');
    assert.equal(actions.at(-1)?.action,'replace_transcript');
    assert.match(JSON.stringify(actions.at(-1)?.data),/Abandoned branch evidence/);
    assert.doesNotMatch(JSON.stringify(actions.at(-1)?.data),/Continued with branch summary/);
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

test('pi custom component commands use the same ACP session and return to native conversation', {timeout:30_000}, async()=>{
  let child:ChildProcessWithoutNullStreams|undefined, exited:Promise<unknown>|undefined;
  let owner='',released=0;
  const h=await harness([],{
    setup:async cwd=>{
      await mkdir(join(cwd,'extensions'));
      await writeFile(join(cwd,'extensions/component.js'),`export default function(pi) {
        pi.registerCommand('component', {description:'Native component fixture',handler:async(_,ctx)=>{
          if (!ctx.ui.setTheme('light').success || ctx.ui.theme.name !== 'light') throw new Error('Missing pi theme');
          const value=await ctx.ui.custom((tui,theme,keys,done)=>({
            render:()=>[theme.fg('accent','ACP COMPONENT READY')],invalidate(){},handleInput(data){if(data==='x')done('selected');}
          }));
          ctx.ui.notify('Component result: '+value);
        }});
        pi.registerCommand('theme-check',{description:'Theme isolation fixture',handler:async(_,ctx)=>{
          ctx.ui.notify('Pi theme: '+ctx.ui.theme.name);
        }});
        pi.registerCommand('component-error',{description:'Failure fixture',handler:async()=>{throw new Error('Fixture extension failure');}});
      }`);
    },
    form:async()=>({action:'cancel'}),native:async()=>({handled:true}),
    terminal:async(method,params)=>{
      if(method===methods.client.terminal.create){
        owner=params.sessionId;
        child=spawn(params.command,params.args,{stdio:'pipe'});exited=once(child,'exit');
        let output='',sent=false;
        child.stdout.on('data',data=>{output+=data;if(!sent&&output.includes('ACP COMPONENT READY')){sent=true;child!.stdin.write('x');}});
        return {terminalId:'fixture-component'};
      }
      if(method===methods.client.terminal.waitForExit){await exited;return {exitCode:0};}
      assert.equal(params.sessionId,owner);released++;child?.kill();await exited;return {};
    },
  });
  try {
    const a=await h.newTask(),b=await h.newTask();
    await h.prompt(a.sessionId,'/component');
    assert.equal(owner,a.sessionId,h.text(a.sessionId)); assert.equal(released,1);
    assert.match(h.text(a.sessionId),/Component result: selected/);
    await h.prompt(b.sessionId,'/theme-check');assert.match(h.text(b.sessionId),/Pi theme: dark/);
    await h.prompt(a.sessionId,'/theme-check');assert.match(h.text(a.sessionId),/Pi theme: light/);
    await h.prompt(a.sessionId,'/component-error');assert.match(h.text(a.sessionId),/command:component-error.*Fixture extension failure/);
    await h.prompt(a.sessionId,'/reload');
    await h.prompt(a.sessionId,'/theme-check');assert.match(h.text(a.sessionId),/Pi theme: dark/);
    assert.equal(h.requests(),0);
  } finally {child?.kill();await h.dispose();}
});

test('native passive components rerender with width and status, and dispose on replace and reload', {timeout:30_000}, async()=>{
  const actions:{sessionId:string;action:string;data:Record<string,any>}[]=[];
  const h=await harness([],{
    setup:async cwd=>{
      await mkdir(join(cwd,'extensions'));
      await writeFile(join(cwd,'extensions/decorations.js'),`export default function(pi) {
        let disposed=0, revision=0, request;
        pi.registerCommand('decorate',{description:'Passive component fixture',handler:async(_,ctx)=>{
          ctx.ui.setStatus('phase','Ready');
          ctx.ui.setWidget('live',(tui,theme)=>{
            request=()=>tui.requestRender();
            return {render:width=>[theme.fg('accent','Widget width '+width+' revision '+revision)],invalidate(){},dispose(){disposed++;}};
          });
          ctx.ui.setHeader((tui,theme)=>({render:()=>['Header '+theme.name],invalidate(){},dispose(){disposed++;}}));
          ctx.ui.setFooter((tui,theme,data)=>({render:()=>['Footer '+data.getExtensionStatuses().get('phase')+' providers '+data.getAvailableProviderCount()],invalidate(){},dispose(){disposed++;}}));
        }});
        pi.registerCommand('redraw',{description:'Update component',handler:async(_,ctx)=>{revision++;ctx.ui.setStatus('phase','Done');request();}});
        pi.registerCommand('retheme',{description:'Rebuild components for theme',handler:async(_,ctx)=>{ctx.ui.setTheme('light');ctx.ui.notify('Disposed '+disposed);}});
        pi.registerCommand('undecorate',{description:'Remove components',handler:async(_,ctx)=>{
          ctx.ui.setWidget('live',['Plain replacement']);ctx.ui.setHeader(undefined);ctx.ui.setFooter(undefined);
          ctx.ui.notify('Disposed '+disposed);
        }});
      }`);
    },
    form:async()=>({action:'cancel'}),native:async request=>{actions.push(request);return{handled:true};},
  });
  const latest=(sessionId:string)=>actions.findLast(a=>a.sessionId===sessionId&&a.action==='extension_state')?.data;
  const wait=async(predicate:()=>boolean)=>{
    for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}
    assert.fail('Native component state did not update');
  };
  try{
    const a=await h.newTask(),b=await h.newTask();
    await h.connection.agent.request('_eido/ui/state',{sessionId:a.sessionId,instance:'first',revision:1,text:'',columns:61});
    await h.connection.agent.request('_eido/ui/state',{sessionId:b.sessionId,instance:'second',revision:1,text:'',columns:40});
    await h.prompt(a.sessionId,'/decorate');
    assert.match(latest(a.sessionId)!.widgets.live.lines[0],/\x1b\[.*Widget width 61 revision 0/);
    assert.equal(latest(a.sessionId)!.widgets.live.component,true);
    assert.deepEqual(latest(a.sessionId)!.header,['Header dark']);
    assert.deepEqual(latest(a.sessionId)!.footer,['Footer Ready providers 1']);
    assert.deepEqual(latest(b.sessionId)!.widgets,{});
    await h.connection.agent.request('_eido/ui/state',{sessionId:a.sessionId,instance:'first',revision:2,text:'',columns:35});
    await wait(()=>latest(a.sessionId)!.widgets.live.lines[0].includes('width 35'));
    await h.prompt(a.sessionId,'/redraw');
    await wait(()=>latest(a.sessionId)!.footer[0].includes('Footer Done'));
    assert.match(latest(a.sessionId)!.widgets.live.lines[0],/revision 1/);
    await h.connection.agent.request('_eido/ui/state',{sessionId:a.sessionId,instance:'first',revision:3,text:'',appearance:'light'});
    await wait(()=>latest(a.sessionId)!.header[0]==='Header light');
    await h.connection.agent.request('_eido/ui/state',{sessionId:a.sessionId,instance:'first',revision:4,text:'',appearance:'dark'});
    await wait(()=>latest(a.sessionId)!.header[0]==='Header dark');
    await h.prompt(a.sessionId,'/retheme');
    assert.deepEqual(latest(a.sessionId)!.header,['Header light']);
    assert.match(h.text(a.sessionId),/Disposed 9/);
    for(const appearance of ['light','dark']) await h.connection.agent.request('_eido/ui/state',{sessionId:a.sessionId,instance:'first',revision:5,text:'',appearance});
    assert.deepEqual(latest(a.sessionId)!.header,['Header light'],'explicit extension theme survives native appearance changes');
    await h.prompt(a.sessionId,'/undecorate');
    assert.deepEqual(latest(a.sessionId)!.widgets.live.lines,['Plain replacement']);
    assert.equal(latest(a.sessionId)!.header,null);assert.equal(latest(a.sessionId)!.footer,null);
    assert.match(h.text(a.sessionId),/Disposed 12/);
    await h.prompt(a.sessionId,'/decorate');await h.prompt(a.sessionId,'/reload');
    assert.deepEqual(latest(a.sessionId)!.widgets,{});
    assert.equal(latest(a.sessionId)!.header,null);assert.equal(latest(a.sessionId)!.footer,null);
    await h.prompt(a.sessionId,'/decorate');
    assert.deepEqual(latest(a.sessionId)!.header,['Header dark'],'reload restores native appearance fallback');
    assert.equal(h.requests(),0);
  }finally{await h.dispose();}
});

test('slow native rendering coalesces plugin frames while preserving the last state', {timeout:5000}, async()=>{
  let began!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{began=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const frames:Record<string,any>[]=[];
  const client={request:async(_method:string,params:any)=>{
    frames.push(params.data);
    if(frames.length===1){began();await gate;}
    return {result:{handled:true}};
  }} as unknown as AgentContext;
  const state=createPiUIState({sessionId:'coalesced'} as AgentSession,client,message=>assert.fail(message),()=>undefined);
  state.receive({instance:'native',revision:0,text:''});
  await started;
  for(let i=0;i<1000;i++)state.controls.setStatus('frame',String(i));
  release();await state.flush();
  assert.equal(frames.length,2);
  assert.deepEqual(frames[1]!.statuses,{frame:'999'});
  state.close();
});

test('durable deliveries deduplicate across reload, reject changed payloads, and isolate sessions', {timeout:30_000}, async()=>{
  let h:Awaited<ReturnType<typeof harness>>;
  h=await harness([async context=>{
    assert.doesNotMatch(JSON.stringify(context), /eido.delivery.v1|delivery-once/);
    assert.ok((await h.entries()).some(e=>e.customType==='eido.delivery.v1'&&e.data.id==='delivery-once'&&e.data.state==='accepted'));
    return 'Executed once.';
  }]);
  const send=(sessionId:string,text:string,id='delivery-once')=>h.connection.agent.request(methods.agent.session.prompt,
    {sessionId,prompt:[{type:'text',text}],_meta:{eidoDeliveryId:id}});
  const status=(sessionId:string)=>h.connection.agent.request('_eido/delivery/status',{sessionId,ids:['delivery-once']});
  try {
    const a=await h.newTask();
    const first=await send(a.sessionId,'Do this once.');
    assert.deepEqual(await send(a.sessionId,'Do this once.'),first);assert.equal(h.requests(),1);
    await assert.rejects(send(a.sessionId,'Changed message.'),/different message/);
    assert.deepEqual(await status(a.sessionId),{deliveries:[{id:'delivery-once',state:'completed'}]});
    await h.connection.agent.request(methods.agent.session.close,{sessionId:a.sessionId});
    await h.connection.agent.request(methods.agent.session.load,{sessionId:a.sessionId,cwd:h.cwd,mcpServers:[]});
    await send(a.sessionId,'Do this once.');assert.equal(h.requests(),1);
    const b=await h.newTask();
    assert.deepEqual(await status(b.sessionId),{deliveries:[{id:'delivery-once',state:'unknown'}]});
    await send(b.sessionId,'Another session.');assert.equal(h.requests(),2);
  }finally{await h.dispose();}
});

test('in-flight and cancelled deliveries cannot be blindly retried after reload', {timeout:30_000},async()=>{
  let started!:()=>void;
  const began=new Promise<void>(resolve=>{started=resolve;});
  const h=await harness([async(_context,signal)=>{
    started();
    await new Promise((_,reject)=>{signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true});});
    return 'Unreachable';
  }]);
  try{
    const a=await h.newTask();
    const params={sessionId:a.sessionId,prompt:[{type:'text' as const,text:'Wait for cancellation.'}],_meta:{eidoDeliveryId:'cancelled-delivery'}};
    const first=h.connection.agent.request(methods.agent.session.prompt,params);
    await began;
    assert.deepEqual(await h.connection.agent.request('_eido/delivery/status',{sessionId:a.sessionId,ids:['cancelled-delivery']}),
      {deliveries:[{id:'cancelled-delivery',state:'running'}]});
    await assert.rejects(h.connection.agent.request(methods.agent.session.prompt,params),/may already have run/);
    await h.connection.agent.notify(methods.agent.session.cancel,{sessionId:a.sessionId});await first;
    await h.connection.agent.request(methods.agent.session.close,{sessionId:a.sessionId});
    await h.connection.agent.request(methods.agent.session.load,{sessionId:a.sessionId,cwd:h.cwd,mcpServers:[]});
    assert.deepEqual(await h.connection.agent.request('_eido/delivery/status',{sessionId:a.sessionId,ids:['cancelled-delivery']}),
      {deliveries:[{id:'cancelled-delivery',state:'interrupted'}]});
    await assert.rejects(h.connection.agent.request(methods.agent.session.prompt,params),/may already have run/);
    assert.equal(h.requests(),1);
  }finally{await h.dispose();}
});

test('boundary deliveries acknowledge the transformed pi message after persistence without replaying', {timeout:30_000},async()=>{
  let ready!:()=>void,release!:()=>void;
  const began=new Promise<void>(resolve=>{ready=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const actions:{action:string;data:Record<string,unknown>}[]=[];
  const h=await harness([async()=>{ready();await gate;return 'Initial response';},context=>{
    assert.match(JSON.stringify(context),/transformed boundary input/);
    assert.doesNotMatch(JSON.stringify(context),/boundary-id|eido.delivery/);
    return 'Boundary response';
  }],{setup:async cwd=>{
    await mkdir(join(cwd,'extensions'));
    await writeFile(join(cwd,'extensions/input.js'),`export default function(pi){pi.on('input',async event=>event.text==='boundary input'?{action:'transform',text:'transformed boundary input'}:{action:'continue'});}`);
  },native:async params=>{actions.push(params);return{handled:true};}});
  try{
    const a=await h.newTask();const turn=h.prompt(a.sessionId,'Initial input');await began;
    const params={sessionId:a.sessionId,prompt:[{type:'text',text:'boundary input'}],_meta:{eidoDeliveryId:'boundary-id'}};
    assert.deepEqual(await h.connection.agent.request('_session/steering',params),{outcome:'injected'});
    assert.deepEqual(await h.connection.agent.request('_session/steering',params),{outcome:'injected'});
    assert.deepEqual(await h.connection.agent.request('_eido/delivery/status',{sessionId:a.sessionId,ids:['boundary-id']}),{deliveries:[{id:'boundary-id',state:'running'}]});
    release();await turn;
    assert.equal(h.requests(),2);
    assert.deepEqual(await h.connection.agent.request('_eido/delivery/status',{sessionId:a.sessionId,ids:['boundary-id']}),{deliveries:[{id:'boundary-id',state:'completed'}]});
    const entries=await h.entries();
    const messageIndex=entries.findIndex(e=>e.type==='message'&&e.message.role==='user'&&JSON.stringify(e.message.content).includes('transformed boundary input'));
    const receiptIndex=entries.findIndex(e=>e.customType==='eido.delivery.v1'&&e.data.id==='boundary-id'&&e.data.state==='completed');
    assert.ok(messageIndex>=0&&receiptIndex>messageIndex,'Receipt must follow the persisted message');
    assert.ok(actions.some(a=>a.action==='delivery_state'&&a.data.id==='boundary-id'&&a.data.state==='completed'));
    const liveInputs=h.updates.filter(({sessionId,update})=>sessionId===a.sessionId&&update.sessionUpdate==='user_message_chunk');
    assert.equal(liveInputs.length,1);
    assert.equal((liveInputs[0]!.update as any).content.text,'transformed boundary input');
    assert.equal((liveInputs[0]!.update as any).messageId,entries[messageIndex].id);
    h.updates.length=0;
    await h.connection.agent.request(methods.agent.session.close,{sessionId:a.sessionId});
    await h.connection.agent.request(methods.agent.session.load,{sessionId:a.sessionId,cwd:h.cwd,mcpServers:[]});
    assert.deepEqual(await h.connection.agent.request('_session/steering',params),{outcome:'injected'});
    assert.equal(h.requests(),2);
    const replayInputs=h.updates.filter(({update})=>update.sessionUpdate==='user_message_chunk');
    assert.equal(replayInputs.length,2);
    assert.notEqual((replayInputs[0]!.update as any).messageId,(replayInputs[1]!.update as any).messageId);
  }finally{release();await h.dispose();}
});

test('cancelled boundary inputs stay reviewable while an idle request can fall back exactly once', {timeout:30_000},async()=>{
  let ready!:()=>void;
  const began=new Promise<void>(resolve=>{ready=resolve;});
  const h=await harness([async(_context,signal)=>{ready();await new Promise((_,reject)=>signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true}));return '';}]);
  try{
    const a=await h.newTask();const turn=h.prompt(a.sessionId,'Wait');await began;
    const params={sessionId:a.sessionId,prompt:[{type:'text' as const,text:'Not consumed'}],_meta:{eidoDeliveryId:'cancel-boundary'}};
    await h.connection.agent.request('_session/steering',params);
    await h.connection.agent.notify(methods.agent.session.cancel,{sessionId:a.sessionId});await turn;
    assert.deepEqual(await h.connection.agent.request('_eido/delivery/status',{sessionId:a.sessionId,ids:['cancel-boundary']}),{deliveries:[{id:'cancel-boundary',state:'interrupted'}]});
    await assert.rejects(h.connection.agent.request('_session/steering',params),/may already have run/);
    const idle={...params,prompt:[{type:'text' as const,text:'Idle fallback'}],_meta:{eidoDeliveryId:'idle-boundary'}};
    assert.deepEqual(await h.connection.agent.request('_session/steering',idle),{outcome:'promptRequired',reason:'noRunningTurn'});
    await h.connection.agent.request(methods.agent.session.prompt,idle);
    await h.connection.agent.request(methods.agent.session.prompt,idle);
    assert.equal(h.requests(),2);
  }finally{await h.dispose();}
});

test('local command settlement releases unconsumed steering and input handlers acknowledge once', {timeout:30_000},async()=>{
  let ready!:()=>void,release!:()=>void;
  const began=new Promise<void>(resolve=>{ready=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const h=await harness([],{setup:async cwd=>{
    await mkdir(join(cwd,'extensions'));
    await writeFile(join(cwd,'extensions/local.js'),`export default function(pi){
      pi.registerCommand('local-hold',{description:'Wait without model',handler:async(_,ctx)=>{await ctx.ui.input('Gate');}});
      pi.on('input',async(event,ctx)=>{if(event.text==='handled'){ctx.ui.notify('Input handled once');return {action:'handled'};}return {action:'continue'};});
    }`);
  },form:async()=>{ready();await gate;return{action:'cancel'};},native:async()=>({handled:true})});
  try{
    const a=await h.newTask();const turn=h.prompt(a.sessionId,'/local-hold');await began;
    const params={sessionId:a.sessionId,prompt:[{type:'text',text:'handled'}],_meta:{eidoDeliveryId:'handled-input'}};
    await h.connection.agent.request('_session/steering',params);await h.connection.agent.request('_session/steering',params);
    const pending={...params,prompt:[{type:'text',text:'unconsumed input'}],_meta:{eidoDeliveryId:'unconsumed-input'}};
    await h.connection.agent.request('_session/steering',pending);
    release();await turn;
    assert.deepEqual(await h.connection.agent.request('_eido/delivery/status',{sessionId:a.sessionId,ids:['handled-input','unconsumed-input']}),
      {deliveries:[{id:'handled-input',state:'completed'},{id:'unconsumed-input',state:'interrupted'}]});
    assert.equal(h.text(a.sessionId).split('Input handled once').length-1,1);
    assert.equal(h.requests(),0);
  }finally{release();await h.dispose();}
});


test('slash commands cannot enter steering as model text or claim a delivery ID', {timeout:30_000},async()=>{
  const h=await harness([]);
  try {
    const a=await h.newTask();
    const params={sessionId:a.sessionId,prompt:[{type:'text' as const,text:'/session'}],_meta:{eidoDeliveryId:'command-delivery'}};
    await assert.rejects(h.connection.agent.request('_session/steering',params),/command queue/);
    assert.deepEqual(await h.connection.agent.request('_eido/delivery/status',{sessionId:a.sessionId,ids:['command-delivery']}),{deliveries:[{id:'command-delivery',state:'unknown'}]});
    await h.connection.agent.request(methods.agent.session.prompt,params);
    await h.connection.agent.request(methods.agent.session.prompt,params);
    assert.match(h.text(a.sessionId),/Messages:/);
    assert.equal(h.requests(),0);
  }finally{await h.dispose();}
});

test('pi extension shortcuts use native drafts and reject stale, repeated and cross-task invocations',{timeout:20_000},async()=>{
  const states=new Map<string,Record<string,unknown>>(),writes:string[]=[];
  const h=await harness([],{
    setup:async cwd=>{
      await mkdir(join(cwd,'extensions'));
      await writeFile(join(cwd,'extensions','shortcut.js'),`export default pi=>pi.registerShortcut('ctrl+alt+9',{description:'Use the current native draft',async handler(ctx){await new Promise(resolve=>setTimeout(resolve,30));ctx.ui.setEditorText(ctx.ui.getEditorText()+' · shortcut');}});`);
    },
    form:async()=>({action:'cancel'}),
    native:async params=>{if(params.action==='extension_state')states.set(params.sessionId,params.data);if(params.action==='set_editor')writes.push(params.data.text as string);return {};},
  });
  try {
    const first=await h.newTask();
    const sync=async(sessionId:string)=>{
      await h.connection.agent.request('_eido/ui/state',{sessionId,instance:sessionId,revision:1,text:'中文 draft'});
      await h.prompt(sessionId,'/name Shortcut fixture');
    };
    await sync(first.sessionId);
    const [shortcut]=states.get(first.sessionId)!.shortcuts as {key:string;generation:string;binding:string}[];
    assert.equal(shortcut!.binding,'ctrl-alt-9');
    const invoke=(sessionId=first.sessionId,generation=shortcut!.generation)=>h.connection.agent.request('_eido/ui/shortcut',{sessionId,key:shortcut!.key,generation});
    await Promise.all([invoke(),invoke()]);
    await h.prompt(first.sessionId,'/name After shortcut');
    assert.deepEqual(writes,['中文 draft · shortcut']);
    const second=await h.newTask();await sync(second.sessionId);
    assert.deepEqual(await invoke(second.sessionId),{handled:false});
    await rm(join(h.cwd,'extensions','shortcut.js'));
    await h.prompt(first.sessionId,'/reload');
    assert.deepEqual(states.get(first.sessionId)!.shortcuts,[]);
    assert.deepEqual(await invoke(),{handled:false});
    assert.equal(writes.length,1);assert.equal(h.requests(),0);
  }finally{await h.dispose();}
});

test('custom pi editors share native drafts, filter raw input, submit once and clean up on reload',{timeout:30_000},async()=>{
  const terminals=new Map<string,{child:ChildProcessWithoutNullStreams;exited:Promise<unknown>;output:string}>();
  const actions:{action:string;data:Record<string,any>}[]=[];
  let revision=1,text='中文 draft',generation='',mounted:string|undefined,released=0;
  const h=await harness([],{
    setup:async cwd=>{
      await mkdir(join(cwd,'extensions'));
      await writeFile(join(cwd,'extensions/editor.js'),`export default pi=>{
        let factory,unsubscribe;
        pi.registerCommand('editorqa',{description:'Custom editor fixture',handler:async(_,ctx)=>{
          factory=(tui,theme,keys)=>{
            let text='';
            return {getText:()=>text,setText(value){text=value;tui.requestRender();},invalidate(){},
              render:()=>[theme.borderColor('EDITOR READY'),text],dispose(){},
              handleInput(data){
                if(data==='\\r'){this.onSubmit?.(text);text='';this.onChange?.(text);return;}
                if(data.startsWith('\\x1b[200~'))data=data.slice(6,-6);
                text+=data;this.onChange?.(text);tui.requestRender();
              }};
          };
          ctx.ui.setEditorComponent(factory);
          if(ctx.ui.getEditorComponent()!==factory)throw new Error('Factory identity lost');
          unsubscribe=ctx.ui.onTerminalInput(data=>data==='!'?{consume:true}:data==='x'?{data:'y'}:undefined);
        }});
        pi.registerCommand('draftqa',{description:'Set editor content',handler:async(_,ctx)=>{
          ctx.ui.setEditorText('Changed by plugin');ctx.ui.pasteToEditor(' + paste');
        }});
        pi.registerCommand('nativeqa',{description:'Restore native editor',handler:async(_,ctx)=>{
          unsubscribe?.();ctx.ui.setEditorComponent(undefined);
          if(ctx.ui.getEditorComponent()!==undefined)throw new Error('Factory not cleared');
        }});
        pi.registerCommand('rawqa',{description:'Raw hooks with pi default editor',handler:async(_,ctx)=>{
          ctx.ui.onTerminalInput(data=>data==='!'?{consume:true}:undefined);
        }});
      };`);
    },
    form:async()=>({action:"cancel"}),
    native:async request=>{
      actions.push(request);
      if(request.action==='mount_editor'){generation=String(request.data.generation);mounted=String(request.data.terminalId);}
      if(request.action==='unmount_editor'&&request.data.generation===generation)mounted=undefined;
      if(request.action==='set_editor'){text=String(request.data.text);revision++;}
      if(request.action==='submit_editor'){
        assert.equal(request.data.generation,generation);assert.equal(request.data.text,text);
        text='';revision++;
      }
      return {handled:true,editor:{instance:'native',revision,text}};
    },
    terminal:async(method,params)=>{
      if(method===methods.client.terminal.create){
        const id=`terminal-${terminals.size}`;
        const child=spawn(params.command,params.args,{stdio:'pipe'});
        const state={child,exited:once(child,'exit'),output:''};terminals.set(id,state);
        child.stdout.on('data',data=>{state.output+=data;});
        return {terminalId:id};
      }
      const terminal=terminals.get(params.terminalId)!;
      if(method===methods.client.terminal.waitForExit){await terminal.exited;return {exitCode:0};}
      released++;terminal.child.kill();await terminal.exited;return {};
    },
  });
  const wait=async(check:()=>boolean)=>{for(let i=0;i<400;i++){if(check())return;await delay(10);}assert.fail('Editor state did not settle: '+JSON.stringify(actions.slice(-5)));};
  try{
    const a=await h.newTask();
    await h.connection.agent.request('_eido/ui/state',{sessionId:a.sessionId,instance:'native',revision,text});
    await h.prompt(a.sessionId,'/editorqa');
    await wait(()=>!!mounted&&terminals.get(mounted)!.output.includes('EDITOR READY'));
    let terminal=terminals.get(mounted!)!;
    assert.match(terminal.output,/中文 draft/);
    terminal.child.stdin.write('x!');
    await wait(()=>text==='中文 drafty');
    await h.prompt(a.sessionId,'/draftqa');
    await wait(()=>text==='Changed by plugin + paste');
    await wait(()=>terminal.output.includes('+ paste'));
    terminal.child.stdin.write('\r');
    await wait(()=>actions.some(action=>action.action==='submit_editor'));
    assert.equal(actions.filter(action=>action.action==='submit_editor').length,1);
    assert.equal(actions.find(action=>action.action==='submit_editor')!.data.text,'Changed by plugin + paste');
    await wait(()=>text==='');
    terminal.child.stdin.write('tail');await wait(()=>text==='tail');
    await h.prompt(a.sessionId,'/nativeqa');await wait(()=>released===1&&!mounted);
    assert.equal(text,'tail');
    await h.prompt(a.sessionId,'/editorqa');
    await wait(()=>!!mounted&&terminals.get(mounted)!.output.includes('EDITOR READY'));
    terminal=terminals.get(mounted!)!;terminal.child.stdin.write('x');await wait(()=>text==='taily');
    await h.prompt(a.sessionId,'/reload');await wait(()=>released===2&&!mounted);
    assert.equal(text,'taily');
    await h.prompt(a.sessionId,'/rawqa');
    await wait(()=>!!mounted&&terminals.get(mounted)!.output.includes('taily'));
    terminal=terminals.get(mounted!)!;
    terminal.child.stdin.write('!');terminal.child.stdin.write('\r');
    await wait(()=>actions.filter(action=>action.action==='submit_editor').length===2);
    assert.equal(actions.filter(action=>action.action==='submit_editor').at(-1)!.data.text,'taily');
    await wait(()=>text==='');
    terminal.child.stdin.write('keep');await wait(()=>text==='keep');
    terminal.child.stdin.write('\x03');await wait(()=>released===3&&!mounted);
    assert.equal(text,'keep');assert.equal(h.requests(),0);
    assert.equal(h.updates.some(({update})=>update.sessionUpdate==='tool_call'&&update.title==='Extension interface'),false);
  }finally{for(const {child} of terminals.values())child.kill();await h.dispose();}
});
