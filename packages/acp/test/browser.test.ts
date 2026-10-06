import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { client, methods, type McpServer } from "@agentclientprotocol/sdk";
import { startEidoAgent } from "../src/server.ts";
import { fixtureModel, call, lastToolText } from "./fixture-model.ts";

const name = (tool: string) => `mcp__eido_browser__browser_${tool}`;

test("pi ACP browser verifies real interaction, errors, isolation, images and cancellation", { timeout: 90_000 }, async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "eido-browser-acp-")));
  let holdStarted!: () => void;
  const started = new Promise<void>(r => { holdStarted = r; });
  let holdClosed!: () => void;
  const closed = new Promise<void>(r => { holdClosed = r; });
  const website = createServer((req, res) => {
    if (req.url === "/hold") {
      res.on("close", holdClosed);
      holdStarted();
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><title>Eido verification fixture</title></head>
      <body><h1>Eido browser verification</h1><p id="value">Count: 0</p>
      <button onclick="document.querySelector('#value').textContent='Count: 1'">Increment</button></body></html>`);
  });
  await new Promise<void>(r => website.listen(0, "127.0.0.1", r));
  const address = website.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const evidence: Record<string, unknown> = { inference: false, target: "local fixture", checks: [] };
  let png: Buffer | undefined;
  await writeFile(join(cwd, "settings.json"), JSON.stringify({ defaultProvider: "eido-fixture", defaultModel: "scripted", defaultThinkingLevel: "off" }));
  const fixture = await fixtureModel(cwd, [
    () => call(name("open"), { url }),
    context => { assert.match(lastToolText(context, name("open")), /Count: 0/); return call(name("snapshot")); },
    context => {
      const snapshot = lastToolText(context, name("snapshot"));
      assert.match(snapshot, /Count: 0/);
      const element = snapshot.match(/\[(\d+)\].*Increment/);
      assert.ok(element, "interact using the observed element identity");
      return call(name("act"), { action: "click", element: Number(element[1]) });
    },
    context => { lastToolText(context, name("act")); return call(name("snapshot")); },
    context => { assert.match(lastToolText(context, name("snapshot")), /Count: 1/); return call(name("act"), { action: "click", element: 999999 }); },
    context => {
      const failure = context.messages.findLast(m => m.role === "toolResult" && m.toolName === name("act"));
      assert.ok(failure?.role === "toolResult" && failure.isError, "failed browser action must remain an error");
      return call(name("snapshot"));
    },
    context => { assert.match(lastToolText(context, name("snapshot")), /Count: 1/); return call(name("screenshot")); },
    context => {
      const result = context.messages.findLast(m => m.role === "toolResult" && m.toolName === name("screenshot"));
      assert.ok(result?.role === "toolResult" && !result.isError);
      const image = result.content.find(p => p.type === "image");
      assert.ok(image?.type === "image");
      png = Buffer.from(image.data, "base64");
      assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.ok(png.length > 1000);
      return "Observed Count: 1 after clicking Increment. Captured the actual page.";
    },
    // A second task owns a separate browser, even with the same target URL.
    () => call(name("open"), { url }),
    context => { assert.match(lastToolText(context, name("open")), /Count: 0/); return "Second task starts at Count: 0."; },
    // A stalled navigation must not prevent cancellation or disposing its browser.
    () => call(name("open"), { url: `${url}/hold` }),
    () => call(name("open"), { url }),
    () => call(name("snapshot")),
    context => { assert.match(lastToolText(context, name("snapshot")), /Count: 0/); return call(name("close")); },
    context => { assert.match(lastToolText(context, name("close")), /"closed":\s*true/); return "Second task remains usable and closes its browser."; },
  ]);
  const toAgent = new TransformStream(); const toClient = new TransformStream();
  const updates: unknown[] = [];
  const server = await startEidoAgent(cwd, join(cwd, "sessions"), { readable: toAgent.readable, writable: toClient.writable }, fixture.runtime);
  const connection = client({ name: "eido-browser-fixture" })
    .onRequest(methods.client.session.requestPermission, () => ({ outcome: { outcome: "selected", optionId: "allow_once" } }))
    .onNotification(methods.client.session.update, ({ params }) => { updates.push(params.update); })
    .connect({ readable: toClient.readable, writable: toAgent.writable });
  const mcpServers: McpServer[] = [{ name: "eido_browser", command: process.execPath,
    args: [fileURLToPath(new URL("../../runtime/bin/browser-server.mjs", import.meta.url))],
    env: [{ name: "JEV_BROWSER_HEADED", value: "0" }],
  }];
  const prompt = (sessionId: string, text: string) => connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
  try {
    await connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
    const a = await connection.agent.request(methods.agent.session.new, { cwd, mcpServers });
    const b = await connection.agent.request(methods.agent.session.new, { cwd, mcpServers });
    assert.equal((await prompt(a.sessionId, "Open the local fixture and verify its counter by interacting with the browser.")).stopReason, "end_turn");
    assert.equal((await prompt(b.sessionId, "Check an independent browser session.")).stopReason, "end_turn");
    const pending = prompt(a.sessionId, "Navigate to a held response for the cancellation test.");
    await started;
    await connection.agent.notify(methods.agent.session.cancel, { sessionId: a.sessionId });
    assert.equal((await pending).stopReason, "cancelled");
    await connection.agent.request(methods.agent.session.close, { sessionId: a.sessionId });
    await Promise.race([closed, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Browser connection did not close with its ACP session")), 8000); timer.unref(); })]);
    assert.equal((await prompt(b.sessionId, "Re-observe after the other task was cancelled, then close this browser.")).stopReason, "end_turn");
    assert.equal(fixture.requests(), 15);
    assert.match(JSON.stringify(updates), /"status":"failed"/, "native ACP receives the failed tool status");
    assert.match(JSON.stringify(updates), /"type":"image"/, "native ACP receives screenshot content");
    evidence.checks = ["observed initial state", "clicked observed element", "observed changed state", "failed action reported", "PNG returned through ACP", "independent task browser", "cancelled pending navigation", "browser disconnected on session close", "other task still usable"];
    if (process.env.EIDO_BROWSER_TEST_OUTPUT && png) {
      const output = resolve(process.env.EIDO_BROWSER_TEST_OUTPUT);
      await mkdir(output, { recursive: true, mode: 0o700 });
      await writeFile(join(output, "browser.png"), png);
      await writeFile(join(output, "verification.json"), JSON.stringify(evidence, null, 2));
    }
  } catch (error) {
    console.error("Browser ACP diagnostic", error instanceof Error && "data" in error ? error.data : error);
    throw error;
  } finally {
    await server.agent.dispose(); connection.close(); server.connection.close();
    website.closeAllConnections();
    await new Promise<void>(r => website.close(() => r()));
    await rm(cwd, { recursive: true, force: true });
  }
});

test("test browsers close automatically on completion, model failure and cancellation without closing another live task", { timeout: 90_000 }, async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "eido-browser-lifetime-")));
  const live = new Set<string>();
  let holdStarted!: () => void;
  const navigationStarted = new Promise<void>(resolve => { holdStarted = resolve; });
  const website = createServer((req, res) => {
    const path = new URL(req.url!, "http://localhost").pathname;
    if (path.startsWith("/alive/") || path === "/hold") {
      live.add(path);
      res.on("close", () => { live.delete(path); });
      if (path === "/hold") holdStarted();
      else { res.setHeader("Content-Type", "text/event-stream"); res.write("data: alive\n\n"); }
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(`<title>Browser lifetime fixture</title><p>${path}</p><script>new EventSource('/alive${path}')</script>`);
  });
  await new Promise<void>(resolve => website.listen(0, "127.0.0.1", resolve));
  const address = website.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 8000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, `Unexpected live browser connections: ${[...live]}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  let releaseRead!: (value: { content: string }) => void, readStarted!: () => void;
  const readPending = new Promise<{content:string}>(resolve => { releaseRead = resolve; });
  const reading = new Promise<void>(resolve => { readStarted = resolve; });
  await writeFile(join(cwd, "hold.txt"), "fixture");
  await writeFile(join(cwd, "settings.json"), JSON.stringify({ defaultProvider: "eido-fixture", defaultModel: "scripted", defaultThinkingLevel: "off", retry: { enabled: false } }));
  const fixture = await fixtureModel(cwd, [
    () => call(name("open"), { url: `${url}/completed` }),
    context => { lastToolText(context, name("open")); assert.ok(live.has("/alive/completed")); return "Complete without an explicit browser_close call."; },
    () => call(name("open"), { url: `${url}/failed` }),
    context => { lastToolText(context, name("open")); assert.ok(live.has("/alive/failed")); throw new Error("Intentional provider failure after opening the browser"); },
    () => call(name("open"), { url: `${url}/other` }),
    context => { lastToolText(context, name("open")); return call("read", { path: "hold.txt" }); },
    () => call(name("open"), { url: `${url}/hold` }),
    () => "The independent task is finished.",
  ]);
  const toAgent = new TransformStream(), toClient = new TransformStream();
  const server = await startEidoAgent(cwd, join(cwd, "sessions"), { readable: toAgent.readable, writable: toClient.writable }, fixture.runtime);
  const connection = client({ name: "eido-lifetime-test" })
    .onRequest(methods.client.fs.readTextFile, () => { readStarted(); return readPending; })
    .onRequest(methods.client.session.requestPermission, () => ({ outcome: { outcome: "selected", optionId: "allow_once" } }))
    .onNotification(methods.client.session.update, () => {})
    .connect({ readable: toClient.readable, writable: toAgent.writable });
  const newTask = () => connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [{ name: "eido_browser", command: process.execPath,
    args: [fileURLToPath(new URL("../../runtime/bin/browser-server.mjs", import.meta.url))], env: [{ name: "JEV_BROWSER_HEADED", value: "0" }],
  }] });
  const prompt = (sessionId: string) => connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "Verify the local browser lifecycle fixture." }] });
  try {
    await connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true } } });
    const a = await newTask(), b = await newTask();
    assert.equal((await prompt(a.sessionId)).stopReason, "end_turn");
    await until(() => live.size === 0);
    await assert.rejects(prompt(a.sessionId));
    await until(() => live.size === 0);
    const other = prompt(b.sessionId);
    await reading;
    assert.ok(live.has("/alive/other"));
    const cancelled = prompt(a.sessionId);
    await navigationStarted;
    await connection.agent.notify(methods.agent.session.cancel, { sessionId: a.sessionId });
    assert.equal((await cancelled).stopReason, "cancelled");
    await until(() => !live.has("/hold"));
    assert.deepEqual([...live], ["/alive/other"], "another active task must keep its browser connection");
    releaseRead({ content: "fixture" });
    assert.equal((await other).stopReason, "end_turn");
    await until(() => live.size === 0);
    assert.equal(fixture.requests(), 8);
  } finally {
    releaseRead({ content: "fixture" });
    await server.agent.dispose(); connection.close(); server.connection.close();
    website.closeAllConnections(); await new Promise<void>(resolve => website.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  }
});
