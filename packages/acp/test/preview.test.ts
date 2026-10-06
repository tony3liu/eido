import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, readdir, symlink, cp, readlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { client, methods, type CreateTerminalRequest } from "@agentclientprotocol/sdk";
import { startEidoAgent } from "../src/server.ts";
import { call, fixtureModel, lastToolText, type FixtureStep } from "./fixture-model.ts";
import {EDITOR_QUERY} from '../src/editor-query.ts';

const name = (action: string) => `mcp__eido_browser__browser_${action}`;
const start = () => call("preview", { action: "start", files: ["index.html"], entry: "index.html" });
const source = (increment: number) => `<!doctype html><title>Preview repair fixture</title><p id="count">Count: 0</p><button onclick="document.querySelector('#count').textContent='Count: ${increment}'">Increment</button>`;

test("new unsaved files can be captured and verified in a browser without saving the workspace", {timeout:90_000}, async () => {
  let preview: any;
  const h = await harness([
    () => call("write",{path:"new/index.html",content:source(1)}),
    context => {lastToolText(context,"write");return call("preview",{action:"start",files:["new/index.html"],entry:"new/index.html"});},
    context => {preview=JSON.parse(lastToolText(context,"preview"));assert.equal(preview.files[0].differsFromDisk,true);return call(name("open"),{url:preview.url});},
    context => {assert.match(lastToolText(context,name("open")),/Count: 0/);return call(name("snapshot"));},
    context => {
      const text=lastToolText(context,name("snapshot"));assert.match(text,/Count: 0/);
      const element=text.match(/\[(\d+)\].*Increment/);assert.ok(element);
      return call(name("act"),{action:"click",element:Number(element[1])});
    },
    () => call(name("snapshot")),
    context => {assert.match(lastToolText(context,name("snapshot")),/Count: 1/);return "New page verified.";},
  ],{browser:true});
  try {
    const session=await h.newTask();await h.prompt(session.sessionId);
    assert.equal(h.requests(),7);
    await assert.rejects(readFile(join(h.cwd,"new/index.html")));
    assert.match(await (await fetch(preview.url)).text(),/Increment/);
    await h.close(session.sessionId);
    await assert.rejects(fetch(preview.url));
  } finally {await h.dispose();}
});

async function harness(steps: FixtureStep[], options: {
  browser?: boolean;
  beforeRead?: (observation: boolean) => Promise<void>;
  create?: (params: CreateTerminalRequest, launch: () => Promise<{terminalId: string}>) => Promise<{terminalId: string}>;
} = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "eido-preview-")));
  const buffers = new Map([[join(cwd, "index.html"), source(2)]]);
  await writeFile(join(cwd, "index.html"), source(7));
  await writeFile(join(cwd, "settings.json"), JSON.stringify({ defaultProvider: "eido-fixture", defaultModel: "scripted", defaultThinkingLevel: "off" }));
  const fixture = await fixtureModel(cwd, steps);
  const terminals = new Map<string, { child: ChildProcess; output: string; exited: boolean; released: boolean }>();
  const release = async (id: string) => {
    const terminal = terminals.get(id)!;
    if (!terminal.exited) {
      const closed = once(terminal.child, "close");
      terminal.child.kill("SIGTERM");
      await closed;
    }
    terminal.released = true;
    return {};
  };
  const toAgent = new TransformStream(), toClient = new TransformStream();
  const server = await startEidoAgent(cwd, join(cwd, "sessions"), { readable: toAgent.readable, writable: toClient.writable }, fixture.runtime);
  const updates: unknown[] = [];
  const connection = client({ name: "eido-preview-test" })
    .onRequest(methods.client.fs.readTextFile, async ({ params }) => {
      await options.beforeRead?.(params._meta?.["eido.dev/observeBuffer"] === true);
      return { content: buffers.get(params.path) ?? await readFile(params.path, "utf8"), _meta: {...params._meta,'eido.dev/conditionalWrite':true} };
    })
    .onRequest(methods.client.fs.writeTextFile, async ({ params }) => {
      const expected=params._meta?.['eido.dev/expectedBuffer'];
      if(typeof expected==='string' && expected!==(buffers.get(params.path)??await readFile(params.path,'utf8'))) throw new Error('File changed while command was running.');
      buffers.set(params.path, params.content); return {};
    })
    .onRequest(EDITOR_QUERY,{parse:raw=>raw},()=>({output:[...buffers.keys()].map(path=>path.slice(cwd.length+1)).join('\n'),truncated:false}))
    .onRequest(methods.client.session.requestPermission, () => ({ outcome: { outcome: "selected", optionId: "allow_once" } }))
    .onRequest(methods.client.terminal.create, async ({ params }) => {
      const launch = async () => {
        const id = crypto.randomUUID();
        const child = spawn(params.command, params.args ?? [], { cwd: params.cwd ?? undefined, stdio: ["ignore", "pipe", "pipe"] });
        const terminal = { child, output: "", exited: false, released: false };
        terminals.set(id, terminal);
        child.stdout!.on("data", data => { terminal.output += data.toString(); });
        child.stderr!.on("data", data => { terminal.output += data.toString(); });
        child.on("exit", () => { terminal.exited = true; });
        await once(child, "spawn");
        return { terminalId: id };
      };
      return options.create ? options.create(params, launch) : launch();
    })
    .onRequest(methods.client.terminal.output, ({ params }) => {
      const terminal = terminals.get(params.terminalId)!;
      return { output: terminal.output, truncated: false, ...(terminal.exited ? { exitStatus: { exitCode: terminal.child.exitCode ?? 1 } } : {}) };
    })
    .onRequest(methods.client.terminal.release, ({ params }) => release(params.terminalId))
    .onNotification(methods.client.session.update, ({ params }) => { updates.push(params.update); })
    .connect({ readable: toClient.readable, writable: toAgent.writable });
  await connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } });
  const newTask = () => connection.agent.request(methods.agent.session.new, { cwd, mcpServers: options.browser ? [{ name: "eido_browser", command: process.execPath,
    args: [fileURLToPath(new URL("../../runtime/bin/browser-server.mjs", import.meta.url))], env: [{ name: "JEV_BROWSER_HEADED", value: "0" }],
  }] : [] });
  return { cwd, buffers, terminals, updates, newTask, requests: fixture.requests,
    prompt: (sessionId: string) => connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "Run the preview verification fixture." }] }),
    cancel: (sessionId: string) => connection.agent.notify(methods.agent.session.cancel, { sessionId }),
    close: (sessionId: string) => connection.agent.request(methods.agent.session.close, { sessionId }),
    dispose: async () => {
      await server.agent.dispose(); connection.close(); server.connection.close();
      for (const [id, terminal] of terminals) if (!terminal.exited) await release(id);
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

test("pi starts a preview, discovers failure, edits buffers and rechecks a new code snapshot in Chromium", { timeout: 90_000 }, async () => {
  let first: any, repaired: any, independent: any;
  const click = (context: Parameters<FixtureStep>[0], tool: string) => {
    const result = lastToolText(context, name(tool));
    const element = result.match(/\[(\d+)\].*Increment/);
    assert.ok(element);
    return call(name("act"), { action: "click", element: Number(element[1]) });
  };
  const h = await harness([
    start,
    context => { first = JSON.parse(lastToolText(context, "preview")); assert.equal(first.files[0].differsFromDisk, true); return call(name("open"), { url: first.url }); },
    context => { assert.match(lastToolText(context, name("open")), /Count: 0/); return call(name("snapshot")); },
    context => click(context, "snapshot"),
    () => call(name("snapshot")),
    context => { assert.match(lastToolText(context, name("snapshot")), /Count: 2/); return call("read", { path: "index.html" }); },
    context => { assert.match(lastToolText(context, "read"), /Count: 2/); return call("edit", { path: "index.html", edits: [{ oldText: "Count: 2", newText: "Count: 1" }] }); },
    context => { lastToolText(context, "edit"); return call("preview", { action: "status" }); },
    context => { assert.equal(JSON.parse(lastToolText(context, "preview")).freshness.state, "stale"); return start(); },
    context => { repaired = JSON.parse(lastToolText(context, "preview")); assert.notEqual(first.fingerprint, repaired.fingerprint); return call(name("open"), { url: repaired.url }); },
    context => { assert.match(lastToolText(context, name("open")), /Count: 0/); return call(name("snapshot")); },
    context => click(context, "snapshot"),
    () => call(name("snapshot")),
    context => { const result = lastToolText(context, name("snapshot")); assert.match(result, /Count: 1/); assert.match(result, /"previewEvidence"/); assert.match(result, /"state": "current"/); return "Increment now produces Count: 1 in the repaired snapshot."; },
    // The completed turn closes its browser. Reopen the same immutable snapshot
    // after a user edit; evidence must still detect that it is stale.
    () => call(name("open"), { url: repaired.url }),
    () => call(name("snapshot")),
    context => { assert.match(lastToolText(context, name("snapshot")), /"state": "stale"/); return "The earlier check no longer verifies current buffers."; },
    start,
    context => { independent = JSON.parse(lastToolText(context, "preview")); assert.notEqual(independent.runId, repaired.runId); return "Independent preview is running."; },
  ], { browser: true });
  try {
    const a = await h.newTask();
    assert.equal((await h.prompt(a.sessionId)).stopReason, "end_turn");
    assert.equal(h.requests(), 14);
    assert.match(h.buffers.get(join(h.cwd, "index.html"))!, /Count: 1/);
    assert.equal(await readFile(join(h.cwd, "index.html"), "utf8"), source(7));
    await assert.rejects(fetch(first.url), "replaced preview must stop listening");
    const response = await fetch(repaired.url);
    assert.equal(response.headers.get("x-eido-snapshot"), repaired.fingerprint);
    assert.match(await response.text(), /Count: 1/);
    assert.equal((await fetch(new URL("../settings.json", repaired.url))).status, 404);
    assert.ok(h.updates.some(update => JSON.stringify(update).includes('"type":"terminal"')));
    const verification = (h.updates as any[]).filter(update => update.rawOutput?.eidoVerification)
      .map(update => update.rawOutput.eidoVerification);
    assert.ok(verification.some(value => value.runId === first.runId && value.freshness.state === 'stale'));
    assert.ok(verification.some(value => value.runId === repaired.runId && value.observation === true && value.toolSucceeded === true));
    assert.ok(verification.every(value => value.version === 1 && value.cwd === h.cwd));
    // The same structured records survive pi's JSONL and ACP replay; no UI-only store.
    const persisted = (await readdir(join(h.cwd, 'sessions'), {recursive:true})).filter(path => path.endsWith('.jsonl'));
    const messages = (await Promise.all(persisted.map(path => readFile(join(h.cwd, 'sessions', path), 'utf8'))))
      .flatMap(text => text.trim().split('\n').map(line => JSON.parse(line)))
      .filter(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.details?.eidoVerification);
    assert.ok(messages.some(entry => entry.message.details.eidoVerification.runId === repaired.runId));
    const {replayEntry} = await import('../adapter/src/replay.js');
    assert.ok(messages.flatMap(entry => replayEntry(entry)).some(update =>
      update.sessionUpdate === "tool_call_update" && (update.rawOutput as {eidoVerification?: {runId?: string}})?.eidoVerification?.runId === repaired.runId));
    h.buffers.set(join(h.cwd, "index.html"), source(3));
    assert.equal((await h.prompt(a.sessionId)).stopReason, "end_turn");
    const b = await h.newTask();
    assert.equal((await h.prompt(b.sessionId)).stopReason, "end_turn");
    await h.close(a.sessionId);
    await assert.rejects(fetch(repaired.url));
    assert.equal((await fetch(independent.url)).status, 200);
    await h.close(b.sessionId);
    await assert.rejects(fetch(independent.url));
    assert.ok([...h.terminals.values()].every(t => t.exited && t.released));
    const evidenceFiles = (await readdir(join(h.cwd, "previews"), { recursive: true })).filter(p => p.endsWith("evidence.jsonl"));
    assert.equal(evidenceFiles.length, 2);
    const evidence = (await Promise.all(evidenceFiles.map(p => readFile(join(h.cwd, "previews", p), "utf8")))).join("\n");
    assert.match(evidence, /"state":"stale"/);
    assert.match(evidence, /"toolCallId":"fixture-/);
    assert.match(evidence, /Count: 2/);
    assert.match(evidence, /Count: 1/);
  } catch (error) {
    console.error("Preview fixture diagnostic", h.requests(), error instanceof Error && "data" in error ? error.data : error);
    throw error;
  } finally { await h.dispose(); }
});

test("preview cancellation releases a terminal returned after cancellation", { timeout: 30_000 }, async () => {
  let finish!: () => void, began!: () => void;
  const held = new Promise<void>(r => { finish = r; }), started = new Promise<void>(r => { began = r; });
  const h = await harness([start, () => "Another task is usable."], {
    create: async (_params, launch) => { const result = await launch(); began(); await held; return result; },
  });
  try {
    const a = await h.newTask(), b = await h.newTask();
    const pending = h.prompt(a.sessionId);
    await started;
    await h.cancel(a.sessionId);
    finish();
    assert.equal((await pending).stopReason, "cancelled");
    const cancelled = (h.updates as any[]).findLast(update => update.rawOutput?.eidoVerification?.cancelled);
    assert.ok(cancelled, 'Cancellation must retain a structured result for native history');
    assert.equal(cancelled.rawOutput.eidoVerification.freshness.state, 'unknown');
    const journals = (await readdir(join(h.cwd, 'sessions'), {recursive:true})).filter(path => path.endsWith('.jsonl'));
    assert.match((await Promise.all(journals.map(path => readFile(join(h.cwd, 'sessions', path), 'utf8')))).join('\n'), /"cancelled":true/);
    assert.ok([...h.terminals.values()].every(t => t.exited && t.released));
    assert.equal((await h.prompt(b.sessionId)).stopReason, "end_turn");
  } finally { finish(); await h.dispose(); }
});

test("preview refuses private/escaping inputs and reports startup failure", { timeout: 30_000 }, async () => {
  const failed = (context: Parameters<FixtureStep>[0]) => {
    const result = context.messages.findLast(m => m.role === "toolResult" && m.toolName === "preview");
    assert.ok(result?.role === "toolResult" && result.isError);
  };
  const h = await harness([
    () => call("preview", { action: "start", files: [".pi/secret.html"], entry: ".pi/secret.html" }),
    context => { failed(context); return call("preview", { action: "start", files: ["escape.html"], entry: "escape.html" }); },
    context => { failed(context); return start(); },
    context => { failed(context); return "Preview could not start; no acceptance was performed."; },
  ], { create: async () => { throw new Error("Terminal unavailable"); } });
  const outside = await mkdtemp(join(tmpdir(), "eido-preview-outside-"));
  try {
    await mkdir(join(h.cwd, ".pi")); await writeFile(join(h.cwd, ".pi/secret.html"), "private");
    await writeFile(join(outside, "outside.html"), "outside");
    await symlink(join(outside, "outside.html"), join(h.cwd, "escape.html"));
    const task = await h.newTask();
    assert.equal((await h.prompt(task.sessionId)).stopReason, "end_turn");
    assert.equal(h.requests(), 4);
    assert.equal(h.terminals.size, 0);
  } finally { await h.dispose(); await rm(outside, { recursive: true, force: true }); }
});

test("cancelling a later turn stops the task's existing preview", { timeout: 30_000 }, async () => {
  let began!: () => void, finish!: () => void;
  const started = new Promise<void>(r => { began = r; }), held = new Promise<void>(r => { finish = r; });
  let url = "";
  const h = await harness([
    start,
    context => { url = JSON.parse(lastToolText(context, "preview")).url; return "Preview is ready."; },
    () => call("read", { path: "index.html" }),
  ], { beforeRead: async observation => { if (!observation) { began(); await held; } } });
  try {
    const task = await h.newTask();
    await h.prompt(task.sessionId);
    assert.equal((await fetch(url)).status, 200);
    const pending = h.prompt(task.sessionId);
    await started;
    await h.cancel(task.sessionId);
    assert.equal((await pending).stopReason, "cancelled");
    await assert.rejects(fetch(url));
    assert.ok([...h.terminals.values()].every(t => t.exited && t.released));
  } finally { finish(); await h.dispose(); }
});


const projectSource = (increment: number) => `export const html: string = ${JSON.stringify(source(increment))};`;
const projectServer = `import {createServer} from 'node:http';
import {createRequire} from 'node:module';
const {html} = createRequire(import.meta.url)('./dist/page.js');
createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(html)}).listen(Number(process.env.PORT), process.env.HOST);`;
const projectStart = () => call("preview", {
  action: "start", files: ["page.ts", "server.mjs"], dependencies: ["node_modules/typescript", `node_modules/@typescript/typescript-${process.platform}-${process.arch}`],
  commands: [{command:"node",args:["--check","server.mjs"]}, {command:"node",args:["node_modules/typescript/bin/tsc","page.ts","--outDir","dist","--module","commonjs","--target","es2020","--skipLibCheck"]}],
  server: {command:"node",args:["server.mjs"]},
});

async function assertProjectInputsReleased(cwd: string) {
  const previews = join(cwd, "previews");
  const links = (await readdir(previews, {recursive: true})).filter(path => path.endsWith("/files"));
  assert.ok(links.length > 0);
  for (const path of links) {
    const target = await readlink(join(previews, path));
    await assert.rejects(stat(target), {code: "ENOENT"}, "temporary inputs must be removed before the ACP session is closed");
  }
}

test("pi builds unsaved TypeScript with installed dependencies, repairs browser behavior and rechecks a fresh project", {timeout:120_000}, async () => {
  let first:any, repaired:any;
  const click=(context:Parameters<FixtureStep>[0])=>{
    const result=lastToolText(context,name("snapshot"));
    const element=result.match(/\[(\d+)\].*Increment/);assert.ok(element);
    return call(name("act"),{action:"click",element:Number(element[1])});
  };
  const h=await harness([
    projectStart,
    context=>{
      first=JSON.parse(lastToolText(context,"preview"));
      assert.equal(first.project.stage,"serving");assert.equal(first.project.checks.length,2);
      assert.ok(first.project.checks.every((check:any)=>check.exitCode===0));
      assert.equal(first.freshness.state,"current");assert.ok(first.dependencies.entries>10);
      return call(name("open"),{url:first.url});
    },
    ()=>call(name("snapshot")),click,()=>call(name("snapshot")),
    context=>{assert.match(lastToolText(context,name("snapshot")),/Count: 2/);return call("read",{path:"page.ts"});},
    ()=>call("edit",{path:"page.ts",edits:[{oldText:"Count: 2",newText:"Count: 1"}]}),
    ()=>call("preview",{action:"status"}),
    context=>{assert.equal(JSON.parse(lastToolText(context,"preview")).freshness.state,"stale");return projectStart();},
    context=>{
      repaired=JSON.parse(lastToolText(context,"preview"));assert.notEqual(repaired.fingerprint,first.fingerprint);
      assert.equal(repaired.freshness.state,"current");assert.equal(repaired.project.stage,"serving");
      return call(name("open"),{url:repaired.url});
    },
    ()=>call(name("snapshot")),click,()=>call(name("snapshot")),
    context=>{
      const result=lastToolText(context,name("snapshot"));assert.match(result,/Count: 1/);
      assert.match(result, /"previewEvidence"/);assert.match(result,/"state": "current"/);
      return call("preview",{action:"stop"});
    },
    ()=>"The captured TypeScript project was rebuilt and the increment behavior verified.",
  ],{browser:true});
  try {
    await mkdir(join(h.cwd,"node_modules"));
    await cp(fileURLToPath(new URL("../../../node_modules/typescript",import.meta.url)),join(h.cwd,"node_modules/typescript"),{recursive:true});
    await cp(fileURLToPath(new URL(`../../../node_modules/@typescript/typescript-${process.platform}-${process.arch}`,import.meta.url)),join(h.cwd,`node_modules/@typescript/typescript-${process.platform}-${process.arch}`),{recursive:true});
    await writeFile(join(h.cwd,"page.ts"),projectSource(7));await writeFile(join(h.cwd,"server.mjs"),projectServer);
    h.buffers.set(join(h.cwd,"page.ts"),projectSource(2));
    const task=await h.newTask();await h.prompt(task.sessionId);
    assert.equal(h.requests(),15);
    assert.equal(await readFile(join(h.cwd,"page.ts"),"utf8"),projectSource(7));
    assert.equal(h.buffers.get(join(h.cwd,"page.ts")),projectSource(1));
    await assert.rejects(readFile(join(h.cwd,"dist/page.js")));
    await assert.rejects(fetch(first.url));await assert.rejects(fetch(repaired.url));
    assert.ok([...h.terminals.values()].every(terminal=>terminal.exited&&terminal.released));
    const files=(await readdir(join(h.cwd,"previews"),{recursive:true})).filter(path=>path.endsWith("evidence.jsonl"));
    assert.equal(files.length,2);
    const evidence=(await Promise.all(files.map(path=>readFile(join(h.cwd,"previews",path),"utf8")))).join("\n");
    assert.match(evidence,/"command":"node"/);assert.match(evidence,/Count: 1/);
    await assertProjectInputsReleased(h.cwd);
  } finally {await h.dispose();}
});

test("project command failure, timeout and snapshot mutation never claim a current successful verification",{timeout:30_000},async()=>{
  let failed:any, timed:any, mutated:any;
  const errorResult=(context:Parameters<FixtureStep>[0])=>{
    const result=context.messages.findLast(m=>m.role==="toolResult"&&m.toolName==="preview");
    assert.ok(result?.role==="toolResult"&&result.isError);
    return JSON.parse(result.content.filter(p=>p.type==="text").map(p=>p.text).join("\n"));
  };
  const run=(code:string,timeoutSeconds=5)=>call("preview",{action:"start",files:["index.html"],commands:[{command:"node",args:["-e",code],timeoutSeconds}]});
  const h=await harness([
    ()=>run(`console.log('EIDO_PROJECT_RESULT {"stage":"completed"}');process.exit(9)`),
    context=>{failed=errorResult(context);assert.equal(failed.project.checks[0].exitCode,9);return run("setInterval(()=>{},1000)",1);},
    context=>{timed=errorResult(context);assert.equal(timed.project.checks[0].timedOut,true);return run("require('fs').writeFileSync('index.html','rewritten by check')");},
    context=>{mutated=JSON.parse(lastToolText(context,"preview"));assert.equal(mutated.project.stage,"completed");assert.equal(mutated.freshness.state,"stale");assert.deepEqual(mutated.freshness.changed,["snapshot:index.html"]);return "Check evidence reviewed.";},
  ]);
  try {
    const task=await h.newTask();await h.prompt(task.sessionId);assert.equal(h.requests(),4);
    assert.equal(failed.service,"stopped");assert.equal(timed.service,"stopped");
    assert.equal(await readFile(join(h.cwd,"index.html"),"utf8"),source(7));
    assert.ok([...h.terminals.values()].every(t=>t.exited&&t.released));
    await assertProjectInputsReleased(h.cwd);
  } finally {await h.dispose();}
});

test("cancelling project startup cleans a stubborn descendant and a terminal returned late",{timeout:30_000},async()=>{
  let finish!:()=>void, began!:()=>void, pid=0;
  const held=new Promise<void>(r=>finish=r),started=new Promise<void>(r=>began=r);
  const code=`const {spawn}=require('child_process');const fs=require('fs');const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync('child.pid',String(child.pid));setInterval(()=>{},1000);`;
  const h=await harness([()=>call("preview",{action:"start",files:["index.html"],commands:[{command:"node",args:["-e",code]}]})],{
    create:async(params,launch)=>{
      const result=await launch();
      const until=Date.now()+5000;
      while(Date.now()<until){try {pid=Number(await readFile(join(params.cwd!,"files/child.pid"),"utf8"));break;}catch{await new Promise(r=>setTimeout(r,30));}}
      assert.ok(pid);began();await held;return result;
    },
  });
  try {
    const task=await h.newTask(),pending=h.prompt(task.sessionId);await started;
    await h.cancel(task.sessionId);finish();assert.equal((await pending).stopReason,"cancelled");
    assert.throws(()=>process.kill(pid,0));assert.ok([...h.terminals.values()].every(t=>t.exited&&t.released));
    await assertProjectInputsReleased(h.cwd);
  }finally{finish();await h.dispose();}
});

const simpleServer = `const http=require('http');http.createServer((_req,res)=>res.end('owned server')).listen(Number(process.env.PORT),process.env.HOST);`;
const simpleProject = () => call("preview",{action:"start",files:["index.html"],server:{command:"node",args:["-e",simpleServer]}});

for(const ending of ["complete","model error","force-killed terminal"] as const){
  test(`project server cleans up after ${ending} without an explicit stop tool call`,{timeout:20_000},async()=>{
    let url="",group=0;
    const h=await harness([
      simpleProject,
      async context=>{
        const result=JSON.parse(lastToolText(context,"preview"));url=result.url;group=result.project.serverPid;
        assert.equal((await fetch(url)).status,200);
        if(ending==="model error")throw new Error("Fixture model error after server startup");
        if(ending==="force-killed terminal"){
          const terminal=[...h.terminals.values()][0]!;terminal.child.kill("SIGKILL");
          const deadline=Date.now()+5000;
          while(Date.now()<deadline){try{await fetch(url);}catch{break;}await new Promise(r=>setTimeout(r,40));}
          await assert.rejects(fetch(url));
        }
        return "Verification turn finished.";
      },
    ]);
    try{
      const task=await h.newTask();
      if(ending==="model error")await assert.rejects(h.prompt(task.sessionId));else await h.prompt(task.sessionId);
      assert.equal(h.requests(),2);await assert.rejects(fetch(url));
      assert.throws(()=>process.kill(group,0));
      assert.ok([...h.terminals.values()].every(t=>t.exited&&t.released));
      await assertProjectInputsReleased(h.cwd);
    }finally{await h.dispose();}
  });
}

test("project commands cannot silently resolve uncaptured workspace packages through ancestor directories",{timeout:15_000},async()=>{
  let result:any;
  const h=await harness([
    ()=>call("preview",{action:"start",files:["index.html"],commands:[{command:"node",args:["-e","console.log(process.cwd());require('eido-uncaptured-fixture')"]}]}),
    context=>{
      const message=context.messages.findLast(m=>m.role==="toolResult"&&m.toolName==="preview");
      assert.ok(message?.role==="toolResult"&&message.isError);
      result=JSON.parse(message.content.filter(p=>p.type==="text").map(p=>p.text).join("\n"));
      assert.equal(result.project.stage,"failed");
      assert.match(result.project.checks[0].output,/MODULE_NOT_FOUND/);
      assert.ok(!result.project.checks[0].output.includes(h.cwd));
      return "Missing dependency was reported without using workspace packages.";
    },
  ]);
  try{
    await mkdir(join(h.cwd,"node_modules/eido-uncaptured-fixture"),{recursive:true});
    await writeFile(join(h.cwd,"node_modules/eido-uncaptured-fixture/index.js"),"module.exports = 'must not resolve';");
    const task=await h.newTask();await h.prompt(task.sessionId);assert.equal(h.requests(),2);
  }finally{await h.dispose();}
});

test('shell pipes read unsaved buffers and merge changed/new text into review without saving', {timeout:30_000}, async()=>{
  let result:any;
  const h=await harness([
    ()=>call('bash',{command:"cat index.html | sed 's/Count: 2/Count: 9/g' > next.html; cp next.html index.html"}),
    context=>{result=JSON.parse(lastToolText(context,'bash'));assert.equal(result.checks[0].exitCode,0);return call('read',{path:'next.html'});},
    context=>{assert.match(lastToolText(context,'read'),/Count: 9/);return 'Shell changes are ready for review.';},
  ]);
  try {
    const task=await h.newTask();await h.prompt(task.sessionId);
    assert.equal(h.requests(),3);
    assert.equal(result.changes.length,2);assert.ok(result.changes.every((c:any)=>c.status==='applied'));
    assert.match(h.buffers.get(join(h.cwd,'index.html'))!,/Count: 9/);
    assert.match(h.buffers.get(join(h.cwd,'next.html'))!,/Count: 9/);
    assert.equal(await readFile(join(h.cwd,'index.html'),'utf8'),source(7));
    await assert.rejects(stat(join(h.cwd,'next.html')));
    assert.ok([...h.terminals.values()].every(t=>t.exited&&t.released));
  } finally {await h.dispose();}
});

test('shell conflict, deletion and binary outputs remain recoverable without overwriting manual edits', {timeout:30_000}, async()=>{
  let result:any;
  const h=await harness([
    ()=>call('bash',{command:"cp index.html changed.html; printf 'command edit' > index.html; printf '\\000' > binary.bin; rm doomed.txt",files:['index.html','doomed.txt']}),
    context=>{result=shellResult(context);return 'Unmerged output is preserved.';},
  ],{create:async(_params,launch)=>{const terminal=await launch();h.buffers.set(join(h.cwd,'index.html'),'Manual edit while command runs');return terminal;}});
  try {
    h.buffers.set(join(h.cwd,'doomed.txt'),'Unsaved content to retain');
    const task=await h.newTask();await h.prompt(task.sessionId);
    assert.equal(h.requests(),2);
    assert.equal(h.buffers.get(join(h.cwd,'index.html')),'Manual edit while command runs');
    assert.equal(h.buffers.get(join(h.cwd,'doomed.txt')),'Unsaved content to retain');
    assert.equal(await readFile(join(result.recovery,'index.html'),'utf8'),'command edit');
    assert.deepEqual(await readFile(join(result.recovery,'binary.bin')),Buffer.from([0]));
    assert.ok(result.changes.some((c:any)=>c.kind==='deleted'&&c.status==='preserved'));
    assert.ok(result.changes.some((c:any)=>c.path==='index.html'&&c.status==='preserved'));
    assert.equal(await readFile(join(h.cwd,'index.html'),'utf8'),source(7));
  } finally {await h.dispose();}
});

test('failed shell commands retain results and terminate background descendants', {timeout:30_000}, async()=>{
  let result:any;
  const h=await harness([
    ()=>call('bash',{command:'sleep 60 & printf "%s" "$!" > child.pid; printf partial > result.txt; exit 7',files:[]}),
    context=>{result=shellResult(context);return 'Command failure inspected.';},
  ]);
  try {
    const task=await h.newTask();await h.prompt(task.sessionId);
    assert.equal(h.requests(),2);assert.equal(result.checks[0].exitCode,7);
    assert.equal(h.buffers.get(join(h.cwd,'result.txt')),'partial');
    const pid=Number(h.buffers.get(join(h.cwd,'child.pid')));
    assert.ok(pid>0);assert.throws(()=>process.kill(pid,0));
    assert.ok([...h.terminals.values()].every(t=>t.exited&&t.released));
  } finally {await h.dispose();}
});

function shellResult(context:Parameters<FixtureStep>[0]) {
  const result=context.messages.findLast(message=>message.role==='toolResult'&&message.toolName==='bash');
  assert.ok(result?.role==='toolResult');
  return JSON.parse(result.content.filter(item=>item.type==='text').map(item=>item.text).join('\n'));
}

test('shell cancellation releases its terminal and preserves unmerged output', {timeout:30_000},async()=>{
  let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
  const h=await harness([()=>call('bash',{command:'printf started > result.txt; sleep 60',files:[]})],{create:async(_params,launch)=>{const result=await launch();started();return result;}});
  try {
    const task=await h.newTask();const running=h.prompt(task.sessionId);await ready;
    await h.cancel(task.sessionId);assert.equal((await running).stopReason,'cancelled');
    assert.ok([...h.terminals.values()].every(t=>t.exited&&t.released));
    assert.equal(h.buffers.get(join(h.cwd,'result.txt')),undefined);
    await assert.rejects(stat(join(h.cwd,'result.txt')));
  } finally {await h.dispose();}
});
