import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { client, methods, type SessionUpdate } from "@agentclientprotocol/sdk";
import { startEidoAgent } from "../src/server.ts";
import { fixtureModel, type FixtureStep } from "./fixture-model.ts";

async function harness(steps: FixtureStep[] = []) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "eido-commands-")));
  const settings = JSON.stringify({defaultProvider: "eido-fixture", defaultModel: "scripted", defaultThinkingLevel: "off", compaction: {enabled: false, keepRecentTokens: 100, reserveTokens: 1000}});
  await writeFile(join(cwd, "settings.json"), settings);
  const fixture = await fixtureModel(cwd, steps);
  const toAgent = new TransformStream(), toClient = new TransformStream();
  const server = await startEidoAgent(cwd, join(cwd, "sessions"), {readable: toAgent.readable, writable: toClient.writable}, fixture.runtime);
  const updates: {sessionId: string; update: SessionUpdate}[] = [];
  const connection = client({name: "eido-command-test"})
    .onNotification(methods.client.session.update, ({params}) => { updates.push(params); })
    .connect({readable: toClient.readable, writable: toAgent.writable});
  await connection.agent.request(methods.agent.initialize, {protocolVersion: 1, clientCapabilities: {}});
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
    assert.deepEqual(discovered.availableCommands.map(command => command.name), ["session", "name", "model", "thinking", "compact"]);
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

test("invalid, unimplemented and attached commands never reach the model or mutate configuration", {timeout: 30_000}, async () => {
  const h = await harness();
  try {
    const a = await h.newTask();
    for (const command of ["/session extra", "/model missing/model", "/thinking impossible", "/name first\nsecond", "/reload", "/share", "/unknown", "/"]) {
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
