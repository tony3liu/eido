import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, methods, type ClientConnection, type SessionNotification } from "@agentclientprotocol/sdk";
import { startEidoAgent } from "../src/server.ts";
import { SUBAGENT_RUN } from "../src/subagents.ts";
import { call, fixtureModel, lastToolText, type FixtureStep } from "./fixture-model.ts";

type Run = {childSessionId: string; parentSessionId: string; task: string; toolCallId: string};
async function harness(steps: FixtureStep[], runHooks: {beforeLoad?: () => Promise<void>; settled?: () => void} = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "eido-subagents-")));
  await writeFile(join(cwd, "settings.json"), JSON.stringify({defaultProvider: "eido-fixture", defaultModel: "scripted", compaction: {enabled: false}}));
  await writeFile(join(cwd, "source.ts"), "disk content");
  const fixture = await fixtureModel(cwd, steps);
  const toAgent = new TransformStream(), toClient = new TransformStream();
  const server = await startEidoAgent(cwd, join(cwd, "sessions"), {readable: toAgent.readable, writable: toClient.writable}, fixture.runtime);
  const updates: SessionNotification[] = [], runs: Run[] = [], readSessions: string[] = [];
  const attached = new Set<string>();
  let writes = 0;
  const runErrors: unknown[] = [];
  const connection: ClientConnection = client({name: "eido-subagent-test"})
    .onNotification(methods.client.session.update, ({params}) => {
      if (params.update.sessionUpdate === "agent_message_chunk" && runs.some(run => run.childSessionId === params.sessionId)) {
        assert.ok(attached.has(params.sessionId), "Child output arrived before native registration");
      }
      updates.push(params);
    })
    .onRequest(methods.client.session.requestPermission, () => ({outcome: {outcome: "selected", optionId: "allow_once"}}))
    .onRequest(methods.client.fs.readTextFile, ({params}) => {readSessions.push(params.sessionId); return {content: "current unsaved buffer"};})
    .onRequest(methods.client.fs.writeTextFile, () => {writes++; return {};})
    .onRequest(SUBAGENT_RUN, {parse: raw => raw as Run}, async ({params, signal}) => {
      runs.push(params);
      assert.ok(updates.some(({sessionId, update}) => sessionId === params.parentSessionId && update.sessionUpdate === "tool_call_update" && update._meta?.subagent_session_info));
      const work = (async () => {
        try {
          await runHooks.beforeLoad?.();
          attached.add(params.childSessionId);
          await connection.agent.request(methods.agent.session.load, {sessionId: params.childSessionId, cwd, mcpServers: []});
          return await connection.agent.request(methods.agent.session.prompt, {sessionId: params.childSessionId, prompt: [{type: "text", text: params.task}]});
        } catch (error) { runErrors.push(error); throw error; }
        finally { runHooks.settled?.(); }
      })();
      let cancel!: () => void;
      const cancelled = new Promise<{stopReason: "cancelled"}>(resolve => {
        cancel = () => resolve({stopReason: "cancelled"});
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, {once: true});
      });
      try { return await Promise.race([work, cancelled]); }
      finally { signal.removeEventListener("abort", cancel); }
    })
    .connect({readable: toClient.readable, writable: toAgent.writable});
  await connection.agent.request(methods.agent.initialize, {protocolVersion: 1, clientCapabilities: {_meta: {eidoSubagents: 1}}});
  const parent = await connection.agent.request(methods.agent.session.new, {cwd, mcpServers: []});
  return {cwd, server, connection, parent, updates, runs, readSessions, runErrors, requests: fixture.requests, writes: () => writes,
    prompt: (text: string) => connection.agent.request(methods.agent.session.prompt, {sessionId: parent.sessionId, prompt: [{type: "text", text}]}),
    dispose: async () => {await server.agent.dispose(); connection.close(); server.connection.close(); await rm(cwd, {recursive: true, force: true});},
  };
}

test("delegation registers an independent pi child, reads native buffers and replays its ownership", {timeout: 30_000}, async () => {
  const h = await harness([
    () => call("subagent", {title: "Inspect current buffer", task: "Read source.ts and report its state."}),
    context => {assert.doesNotMatch(JSON.stringify(context.messages), /parent-only-secret/); return call("read", {path: "source.ts"});},
    context => {assert.match(lastToolText(context, "read"), /current unsaved buffer/); return "The current buffer contains unsaved content.";},
    context => {assert.match(lastToolText(context, "subagent"), /unsaved content/); return "Inspection received.";},
  ]);
  try {
    assert.equal((await h.prompt("parent-only-secret. Delegate an inspection.")).stopReason, "end_turn");
    assert.equal(h.runs.length, 1);
    const child = h.runs[0]!.childSessionId;
    assert.notEqual(child, h.parent.sessionId);
    assert.deepEqual(h.readSessions, [child]);
    assert.equal(h.writes(), 0);
    assert.equal(await readFile(join(h.cwd, "source.ts"), "utf8"), "disk content");
    const list = await h.connection.agent.request(methods.agent.session.list, {cwd: h.cwd});
    assert.deepEqual(list.sessions.map(session => session.sessionId), [h.parent.sessionId]);
    await h.connection.agent.request(methods.agent.session.close, {sessionId: h.parent.sessionId});
    h.updates.length = 0;
    await h.connection.agent.request(methods.agent.session.load, {sessionId: h.parent.sessionId, cwd: h.cwd, mcpServers: []});
    assert.ok(h.updates.some(({update}) => update.sessionUpdate === "tool_call_update" && update._meta?.subagent_session_info));
    await h.connection.agent.request(methods.agent.session.load, {sessionId: child, cwd: h.cwd, mcpServers: []});
    assert.ok(h.updates.some(({sessionId, update}) => sessionId === child && update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" && update.content.text.includes("unsaved content")));
    assert.equal(h.runs.length, 1, "Loading history must never rerun a delegation");

    await h.server.agent.dispose(); h.connection.close(); h.server.connection.close();
    const freshModel = await fixtureModel(h.cwd, []);
    const toAgent = new TransformStream(), toClient = new TransformStream();
    const restarted = await startEidoAgent(h.cwd, join(h.cwd, "sessions"), {readable: toAgent.readable, writable: toClient.writable}, freshModel.runtime);
    const replay: SessionNotification[] = [];
    const connection = client({name: "eido-restarted-test"})
      .onNotification(methods.client.session.update, ({params}) => {replay.push(params);})
      .connect({readable: toClient.readable, writable: toAgent.writable});
    try {
      await connection.agent.request(methods.agent.initialize, {protocolVersion: 1, clientCapabilities: {_meta: {eidoSubagents: 1}}});
      const restoredList = await connection.agent.request(methods.agent.session.list, {cwd: h.cwd});
      assert.deepEqual(restoredList.sessions.map(session => session.sessionId), [h.parent.sessionId]);
      await connection.agent.request(methods.agent.session.load, {sessionId: child, cwd: h.cwd, mcpServers: []});
      assert.ok(replay.some(({update}) => update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" && update.content.text.includes("unsaved content")));
      assert.ok(replay.some(({update}) => update.sessionUpdate === "session_info_update" && update.title === "Inspect current buffer"));
      await assert.rejects(connection.agent.request(methods.agent.session.prompt, {sessionId: child, prompt: [{type: "text", text: "Duplicate launch"}]}), /no longer awaiting a prompt/);
      assert.equal(freshModel.requests(), 0, "Restart must replay without inference");
    } finally {await restarted.agent.dispose(); connection.close(); restarted.connection.close();}
  } finally {await h.dispose();}
});

test("cancelling before native registration rejects the late child prompt without inference", {timeout: 30_000}, async () => {
  let ready!: () => void, release!: () => void, settled!: () => void;
  const loading = new Promise<void>(resolve => {ready = resolve;});
  const gate = new Promise<void>(resolve => {release = resolve;});
  const done = new Promise<void>(resolve => {settled = resolve;});
  const h = await harness([
    () => call("subagent", {title: "Delayed inspector", task: "Inspect after native loading."}),
    () => "Parent is still usable.",
  ], {beforeLoad: async () => {ready(); await gate;}, settled});
  try {
    const running = h.prompt("Delegate an inspection.");
    await loading;
    await h.connection.agent.notify(methods.agent.session.cancel, {sessionId: h.parent.sessionId});
    assert.equal((await running).stopReason, "cancelled");
    release();
    await done;
    assert.equal(h.runErrors.length, 1);
    assert.match(String(h.runErrors[0]), /no longer awaiting a prompt/);
    assert.equal(h.requests(), 1, "A cancelled child must not start a model request");
    assert.equal((await h.prompt("Continue after cancellation.")).stopReason, "end_turn");
    assert.equal(h.requests(), 2);
  } finally {release(); await h.dispose();}
});

test("stopping the parent cancels its running child and releases the next turn", {timeout: 30_000}, async () => {
  let started!: () => void;
  const childStarted = new Promise<void>(resolve => {started = resolve;});
  let childAborted = false;
  const h = await harness([
    () => call("subagent", {title: "Held inspector", task: "Inspect without finishing yet."}),
    async (_context, signal) => {
      started();
      await new Promise<void>(resolve => {
        if (signal?.aborted) {childAborted = true; resolve();}
        else signal?.addEventListener("abort", () => {childAborted = true; resolve();}, {once: true});
      });
      throw new Error("Cancelled fixture child");
    },
    () => "Parent remains usable.",
  ]);
  try {
    const running = h.prompt("Delegate an inspection.");
    await childStarted;
    await h.connection.agent.notify(methods.agent.session.cancel, {sessionId: h.parent.sessionId});
    assert.equal((await running).stopReason, "cancelled");
    assert.equal(childAborted, true);
    assert.equal((await h.prompt("Continue after cancellation.")).stopReason, "end_turn");
  } finally {await h.dispose();}
});

test("stopping only the child reports failure to the parent without cancelling the main task", {timeout: 30_000}, async () => {
  let started!: () => void;
  const childStarted = new Promise<void>(resolve => {started = resolve;});
  let reportReceived = false;
  const h = await harness([
    () => call("subagent", {title: "Stoppable inspector", task: "Inspect this task."}),
    async (_context, signal) => {
      started();
      await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), {once: true}));
      throw new Error("Stopped child");
    },
    context => {
      const result = context.messages.findLast(message => message.role === "toolResult" && message.toolName === "subagent");
      assert.ok(result?.role === "toolResult" && result.isError);
      reportReceived = true;
      return "The inspection was stopped; the main task is still available.";
    },
  ]);
  try {
    const running = h.prompt("Delegate an inspection.");
    await childStarted;
    await h.connection.agent.notify(methods.agent.session.cancel, {sessionId: h.runs[0]!.childSessionId});
    assert.equal((await running).stopReason, "end_turn");
    assert.equal(reportReceived, true);
  } finally {await h.dispose();}
});

test("parallel agents actually overlap and preserve independent results and replay", {timeout: 30_000}, async () => {
  let count = 0, release!: () => void;
  const both = new Promise<void>(resolve => {release = resolve;});
  const child: FixtureStep = async context => {
    const own = context.messages.findLast(m => m.role === "user");
    const text = JSON.stringify(own);
    assert.ok(text.includes("Inspect A") || text.includes("Inspect B"));
    if (++count === 2) release();
    await both;
    return text.includes("Inspect A") ? "Result A" : "Result B";
  };
  const h = await harness([
    () => call("subagent", {tasks: [{title: "A", task: "Inspect A"}, {title: "B", task: "Inspect B"}]}), child, child,
    context => {const result = lastToolText(context, "subagent"); assert.match(result, /Result A/); assert.match(result, /Result B/); return "Both inspected.";},
  ]);
  try {
    assert.equal((await h.prompt("Run parallel inspection.")).stopReason, "end_turn");
    assert.equal(count, 2);
    assert.equal(new Set(h.runs.map(r => r.childSessionId)).size, 2);
    assert.equal(new Set(h.runs.map(r => r.toolCallId)).size, 2);
    const requests = h.requests();
    await h.connection.agent.request(methods.agent.session.close, {sessionId: h.parent.sessionId});
    h.updates.length = 0;
    await h.connection.agent.request(methods.agent.session.load, {sessionId: h.parent.sessionId, cwd: h.cwd, mcpServers: []});
    for (const run of h.runs) assert.ok(h.updates.some(({update}) => update.sessionUpdate === "tool_call_update" && update.toolCallId === run.toolCallId && update.status === "completed"));
    assert.equal(h.requests(), requests);
  } finally {release(); await h.dispose();}
});

test("a failed parallel agent does not cancel its independent sibling", {timeout: 30_000}, async () => {
  const inspect: FixtureStep = context => {
    if (JSON.stringify(context.messages).includes("Fail this inspection")) throw new Error("Fixture inspection failed");
    return "Independent result survives.";
  };
  const h = await harness([
    () => call("subagent", {tasks: [{title: "Fail", task: "Fail this inspection"}, {title: "Survive", task: "Complete independently"}]}), inspect, inspect,
    context => {
      const result = context.messages.findLast(m => m.role === "toolResult" && m.toolName === "subagent");
      assert.ok(result?.role === "toolResult" && result.isError);
      assert.match(JSON.stringify(result.content), /Independent result survives/);
      return "Partial failure reported.";
    },
  ]);
  try {assert.equal((await h.prompt("Run both inspections.")).stopReason, "end_turn"); assert.equal(h.runs.length, 2);}
  finally {await h.dispose();}
});

test("chain passes verified output forward and blocks later steps after failure", {timeout: 30_000}, async () => {
  const h = await harness([
    () => call("subagent", {chain: [{task: "Inspect first"}, {task: "Review {previous}"}, {task: "Must never run"}]}),
    () => "first verified result",
    context => {assert.match(JSON.stringify(context.messages), /Review first verified result/); throw new Error("Second step failed");},
    context => {
      const result = context.messages.findLast(m => m.role === "toolResult" && m.toolName === "subagent");
      assert.ok(result?.role === "toolResult" && result.isError);
      assert.match(JSON.stringify(result.content), /Blocked/);
      return "Chain failure reported.";
    },
  ]);
  try {
    assert.equal((await h.prompt("Run the chain.")).stopReason, "end_turn");
    assert.equal(h.runs.length, 2);
    assert.ok(h.updates.some(({update}) => update.sessionUpdate === "tool_call_update" && JSON.stringify(update.content).includes("Blocked by step 2")));
  } finally {await h.dispose();}
});

test("worker delegates a nested review while read-only roles cannot write", {timeout: 30_000}, async () => {
  const h = await harness([
    () => call("subagent", {agent: "worker", task: "Delegate review"}),
    () => call("subagent", {agent: "reviewer", task: "Try a forbidden write"}),
    () => call("write", {path: "source.ts", content: "should not be written"}),
    context => {assert.match(JSON.stringify(context.messages), /not (enabled|found|available)|Unknown tool/i); return "No write performed.";},
    context => {assert.match(lastToolText(context, "subagent"), /No write performed/); return "Review collected.";},
    context => {assert.match(lastToolText(context, "subagent"), /Review collected/); return "Nested review done.";},
  ]);
  try {
    assert.equal((await h.prompt("Delegate implementation review.")).stopReason, "end_turn");
    assert.equal(h.runs.length, 2);
    assert.equal(h.runs[1]?.parentSessionId, h.runs[0]?.childSessionId);
    assert.equal(h.writes(), 0);
  } finally {await h.dispose();}
});

test("an explicit user follow-up continues the same child and records its result in the parent", {timeout: 30_000}, async () => {
  const h = await harness([
    () => call("subagent", {title: "Reviewer", task: "Inspect initial state"}),
    () => "Initial review.", () => "Review collected.",
    context => {assert.match(JSON.stringify(context.messages), /Initial review/); return "Updated review after user correction.";},
  ]);
  try {
    await h.prompt("Delegate review.");
    const id = h.runs[0]!.childSessionId;
    const response = await h.connection.agent.request(methods.agent.session.prompt, {sessionId: id, prompt: [{type: "text", text: "Check this correction"}], _meta: {eidoUserMessage: true}});
    assert.equal(response.stopReason, "end_turn");
    assert.ok(h.updates.some(({sessionId, update}) => sessionId === h.parent.sessionId && update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" && update.content.text.includes("Updated review")));
    assert.equal(h.runs.length, 1);
  } finally {await h.dispose();}
});
