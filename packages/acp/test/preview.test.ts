import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { client, methods, type CreateTerminalRequest } from "@agentclientprotocol/sdk";
import { startEidoAgent } from "../src/server.ts";
import { call, fixtureModel, lastToolText, type FixtureStep } from "./fixture-model.ts";

const name = (action: string) => `mcp__eido_browser__browser_${action}`;
const start = () => call("preview", { action: "start", files: ["index.html"], entry: "index.html" });
const source = (increment: number) => `<!doctype html><title>Preview repair fixture</title><p id="count">Count: 0</p><button onclick="document.querySelector('#count').textContent='Count: ${increment}'">Increment</button>`;

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
      return { content: buffers.get(params.path) ?? "", _meta: params._meta };
    })
    .onRequest(methods.client.fs.writeTextFile, ({ params }) => { buffers.set(params.path, params.content); return {}; })
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
    args: [fileURLToPath(new URL("../../../scripts/browser-server.mjs", import.meta.url))], env: [{ name: "JEV_BROWSER_HEADED", value: "0" }],
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
