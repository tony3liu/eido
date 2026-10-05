import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { RequestError, type AgentContext, type McpServer, type SessionUpdate, type SessionConfigOption, type ContentBlock } from "@agentclientprotocol/sdk";
import { defineTool, type AgentSession, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { runAcp } from "@automatalabs/pi-acp";
import { discoverAgentRoles, type AgentRole } from "./agent-roles.ts";

export const SUBAGENT_RECORD = "eido.subagent.v1";
export const SUBAGENT_EVENT = "eido.agents.event.v1";
export const SUBAGENT_RUN = "_eido/subagent/run";
const HOST = Symbol.for("eido.pi.host");
type Server = Awaited<ReturnType<typeof runAcp>>;
interface Host {
  enqueue(update: SessionUpdate): void;
  drain(): Promise<void>;
  replay(entries: readonly SessionEntry[]): Promise<void>;
  configOptions(): SessionConfigOption[];
  readonly busy: boolean;
}
interface Relation {
  parentSessionId: string; childSessionId: string; toolCallId: string; title: string; runId: string;
  rootSessionId?: string; groupId?: string; depth?: number; role?: AgentRole; attempt?: number;
}
interface Session { pi: AgentSession; host?: Host }
type State = "Queued" | "Running" | "Stopping" | "Completed" | "Failed" | "Cancelled" | "Blocked";
interface Job {title?: string; task: string; agent?: string}
interface Row {job: Job; role: AgentRole; id: string; state: State; output?: string; relation?: Relation; started?: number; duration?: number; model?: string; tokens?: number; cost?: number; inputs?: string[]}
const roleName = () => Type.Optional(Type.String({description: "Existing global role name: scout, worker, reviewer, verifier, or a configured /agents role. Use title for the instance name."}));
const instanceTitle = () => Type.Optional(Type.String({minLength: 1, maxLength: 120, description: "Display name of this instance, such as Alpha. This does not create a role."}));
const describeInput = (content: ContentBlock[]) => content.map(block => block.type === "text" ? block.text
  : block.type === "image" ? "[Image attachment]" : block.type === "resource_link" ? `[Resource: ${block.uri}]` : "[Attached resource]").join("\n");
const report = (row: Row) => `${row.inputs?.length ? `User instructions received during this run:\n${row.inputs.map(text=>JSON.stringify(text)).join("\n")}\n\nAgent result:\n` : ""}${row.output ?? "No result."}`;
const jobSchema = Type.Object({agent: roleName(), title: instanceTitle(), task: Type.String({minLength: 1})});
const textContent = (text: string) => [{type: "content" as const, content: {type: "text" as const, text}}];

/** Reuse pi sessions and the ACP turn boundary for every child, including retries. */
export function createSubagents(agentDir: string, sessionDir: string) {
  const sessions = new Map<string, Session>(), relations = new Map<string, Relation>();
  const awaitingPrompts = new Set<string>(), running = new Map<string, Row>();
  const activeCounts = new Map<string, number>();
  const completions = new Map<string, Promise<void>>();
  const mcpServers = new Map<string, McpServer[]>();
  const opening = new AsyncLocalStorage<Relation>();
  let server: Server, enabled = false;
  const reserve = (rootId: string) => {
    const count = activeCounts.get(rootId) ?? 0;
    if (count >= 16) throw new Error("This main task already has 16 active agents. Wait for results before delegating more.");
    activeCounts.set(rootId, count + 1);
    return () => {
      const count = activeCounts.get(rootId)! - 1;
      if (count) activeCounts.set(rootId, count); else activeCounts.delete(rootId);
    };
  };
  const context = <T>(params: T, client: AgentContext, signal = new AbortController().signal) => ({params, client, signal, requestId: randomUUID()});
  const publish = (parent: Session, update: SessionUpdate) => {
    parent.pi.sessionManager.appendCustomEntry(SUBAGENT_EVENT, {update});
    parent.host?.enqueue(update);
  };
  const updateRow = (parent: Session, row: Row) => {
    const r = row.relation;
    const label = `${row.job.title || row.role.name}`;
    const detail = [row.role.name, row.model, row.state, row.duration === undefined ? undefined : `${(row.duration / 1000).toFixed(1)}s`, row.tokens === undefined ? undefined : `${row.tokens} tokens`, row.cost === undefined ? undefined : `$${row.cost.toFixed(4)}`].filter(Boolean).join(" · ");
    publish(parent, {sessionUpdate: "tool_call_update", toolCallId: row.id, title: label,
      status: row.state === "Completed" ? "completed" : ["Failed", "Cancelled", "Blocked"].includes(row.state) ? "failed" : row.state === "Queued" ? "pending" : "in_progress",
      content: row.output ? textContent(row.output) : [], rawInput: {eidoAgent: {detail, state: row.state, runId: r?.runId, role: row.role.name, model: row.model}},
      ...(r ? {_meta: {subagent_session_info: {session_id: r.childSessionId, message_start_index: 0}}} : {}),
    });
  };
  const stopChildren = (parentId: string, client: AgentContext) => {
    for (const relation of relations.values()) if (relation.parentSessionId === parentId) server.agent.cancel(context({sessionId: relation.childSessionId}, client));
  };
  const restore = async (id: string, client: AgentContext) => {
    if (sessions.get(id)?.host) return;
    const relation = relations.get(id);
    if (!relation) throw new Error("Unknown delegated session.");
    const parent = sessions.get(relation.parentSessionId);
    if (!parent) throw new Error("Open the main task before continuing this agent.");
    await server.agent.loadSession(context({sessionId: id, cwd: parent.pi.sessionManager.getCwd(), mcpServers: mcpServers.get(relation.parentSessionId) ?? []}, client));
  };

  return {
    setEnabled(value: boolean) { enabled = value; },
    get enabled() { return enabled; },
    consumedInput(id: string, message: Parameters<AgentSession['sessionManager']['appendMessage']>[0], entryId: string) {
      if (message.role !== "user") return;
      const session = sessions.get(id);
      const content = typeof message.content === "string" ? [{type: "text" as const, text: message.content}] : message.content;
      for (const block of content) session?.host?.enqueue({sessionUpdate: "user_message_chunk", messageId: entryId, content: block});
      const row = running.get(id);
      if (row) (row.inputs ??= []).push(content.map(block=>block.type === "text" ? block.text : "[Image attachment]").join("\n"));
    },
    register(pi: AgentSession) {
      const saved = pi.sessionManager.getEntries().findLast(entry => entry.type === "custom" && entry.customType === SUBAGENT_RECORD && (entry.data as {kind?: string})?.kind === "child");
      const relation = opening.getStore() ?? (saved?.type === "custom" ? saved.data as Relation : undefined);
      if (relation) {
        relation.childSessionId = pi.sessionId;
        relations.set(pi.sessionId, relation);
        if (opening.getStore()) pi.sessionManager.appendCustomEntry(SUBAGENT_RECORD, {...relation, kind: "child"});
      }
      const session: Session = {pi};
      sessions.set(pi.sessionId, session);
      Object.defineProperty(pi, HOST, {value: {attach(host: Host) {session.host = host;}}});
      return relation;
    },
    tool(parentId: string, client: AgentContext) {
      return defineTool({
        name: "subagent", label: "Delegate to agents",
        description: "Delegate to independent pi agents. Use title/task/agent for one agent, tasks for parallel agents (up to 4 simultaneously), or chain for sequential agents. In chain tasks, {previous} is replaced with the preceding result. Default role is scout (read only); worker can edit native buffers and delegate; reviewer reads; verifier uses preview/browser. Use /agents to manage global roles. Children inherit model/thinking unless their role specifies them. Every child appears in the workbench with its own permissions, edits, results and stop control. Failures block dependent steps; independent parallel tasks continue. Context is independent; include all required instructions. Nesting is bounded to 3 levels and 16 active children per main task.",
        parameters: Type.Object({title: instanceTitle(), task: Type.Optional(Type.String({minLength: 1})), agent: roleName(),
          tasks: Type.Optional(Type.Array(jobSchema, {minItems: 1, maxItems: 8})), chain: Type.Optional(Type.Array(jobSchema, {minItems: 1, maxItems: 8}))}),
        async execute(toolCallId, args, signal) {
          if (!enabled) throw new Error("This client does not support native subagents.");
          const parent = sessions.get(parentId);
          if (!parent?.host) throw new Error("Parent session is not ready.");
          const modes = [!!args.task, !!args.tasks, !!args.chain].filter(Boolean).length;
          if (modes !== 1) throw new Error("Choose exactly one delegation form: task, tasks, or chain.");
          const ancestry = relations.get(parentId), depth = (ancestry?.depth ?? 0) + 1;
          if (depth > 3) throw new Error("Maximum delegation depth reached. Complete this work in the current agent.");
          const rootId = ancestry?.rootSessionId ?? parentId;
          const catalogue = await discoverAgentRoles(agentDir);
          const jobs: Job[] = args.tasks ?? args.chain ?? [{title: args.title, task: args.task!, agent: args.agent}];
          const single = !args.tasks && !args.chain, mode = args.chain ? "Chain" : "Parallel";
          const groupId = randomUUID();
          const rows: Row[] = jobs.map((job, i) => {
            const role = catalogue.roles.find(role => role.name === (job.agent ?? "scout"));
            if (!role) throw new Error(`Unknown global agent: ${job.agent}. Available: ${catalogue.roles.map(r => r.name).join(", ")}. ${catalogue.errors.join("; ")}`);
            return {job, role, id: single ? toolCallId : `${toolCallId}/${i + 1}`, state: "Queued"};
          });
          const summary = () => {
            if (single) return;
            const counts = rows.reduce<Record<string, number>>((all, row) => ({...all, [row.state]: (all[row.state] ?? 0) + 1}), {});
            publish(parent, {sessionUpdate: "tool_call_update", toolCallId, title: `${mode} · ${rows.length} agents · ${Object.entries(counts).map(([s,n]) => `${n} ${s.toLowerCase()}`).join(" · ")}`,
              status: rows.some(r => ["Queued", "Running", "Stopping"].includes(r.state)) ? "in_progress" : rows.every(r => r.state === "Completed") ? "completed" : "failed",
              content: textContent(rows.map((r,i) => `${i + 1}. **${r.job.title || r.role.name}** — ${r.state}${args.chain && i > 0 ? ` (after step ${i})` : ""}`).join("\n"))});
          };
          for (const row of rows) {
            if (!single) publish(parent, {sessionUpdate: "tool_call", toolCallId: row.id, title: row.job.title || row.role.name, kind: "other", status: "pending"});
            updateRow(parent, row);
          }
          summary();
          const run = async (row: Row, previous?: string) => {
            let childId: string | undefined;
            let release: (() => void) | undefined, settled: (() => void) | undefined;
            const cancel = () => {if (childId) server.agent.cancel(context({sessionId: childId}, client));};
            signal?.addEventListener("abort", cancel, {once: true});
            try {
              signal?.throwIfAborted();
              release = reserve(rootId);
              row.state = "Running"; row.started = Date.now();
              const relation: Relation = {parentSessionId: parentId, childSessionId: "", toolCallId: row.id, title: row.job.title || row.role.name,
                runId: randomUUID(), rootSessionId: rootId, groupId, depth, role: row.role, attempt: 1};
              const created = await opening.run(relation, () => server.agent.newSession(context({cwd: parent.pi.sessionManager.getCwd(), mcpServers: mcpServers.get(parentId) ?? [],
                _meta: {systemPrompt: {append: `${row.role.systemPrompt}\nYou are a delegated ${row.role.name} agent in Eido. Work only on the assigned task. Use native tools; never claim verification without evidence. Your result returns to the parent. Parent session: ${parentId}.`}}}, client, signal)));
              childId = created.sessionId;
              completions.set(childId, new Promise<void>(resolve => {settled = resolve;}));
              row.relation = relation; running.set(childId, row);
              const child = sessions.get(childId);
              if (!child?.host) throw new Error("Child session is not ready.");
              let model = parent.pi.model;
              if (row.role.model) {
                const matches = (await child.pi.modelRuntime.getAvailable()).filter(m => `${m.provider}/${m.id}` === row.role.model || m.id === row.role.model);
                if (matches.length !== 1) throw new Error(`Agent model is unavailable or ambiguous: ${row.role.model}. Configure it in pi Models & Credentials.`);
                model = matches[0];
              }
              if (model) await child.pi.setModel(model);
              child.pi.setThinkingLevel(row.role.thinking ?? parent.pi.thinkingLevel);
              child.pi.setSessionName(relation.title);
              row.model = model?.name || model?.id;
              parent.pi.sessionManager.appendCustomEntry(SUBAGENT_RECORD, {...relation, kind: "parent"});
              updateRow(parent, row); summary(); await parent.host!.drain();
              signal?.throwIfAborted(); awaitingPrompts.add(childId);
              const task = previous === undefined ? row.job.task : row.job.task.includes("{previous}") ? row.job.task.replaceAll("{previous}", previous) : `${row.job.task}\n\nPrevious agent result:\n${previous}`;
              const response = await client.request<{stopReason: string}>(SUBAGENT_RUN, {...relation, task}, {cancellationSignal: signal});
              signal?.throwIfAborted();
              const last = child.pi.messages.findLast(message => message.role === "assistant");
              if (response.stopReason !== "end_turn" || last?.role !== "assistant" || ["error", "aborted"].includes(last.stopReason)) throw new Error(response.stopReason === "cancelled" ? "Subagent stopped." : last?.role === "assistant" && last.errorMessage ? last.errorMessage : "Subagent did not complete successfully.");
              row.output = last.content.filter(part => part.type === "text").map(part => part.text).join("\n") || "Agent completed without a text report.";
              const stats = child.pi.getSessionStats(); row.tokens = stats.tokens.total; row.cost = stats.cost;
              row.state = "Completed";
            } catch (error) {
              row.state = signal?.aborted || String(error).includes("Subagent stopped") ? "Cancelled" : "Failed";
              row.output = error instanceof Error ? error.message : String(error);
            } finally {
              signal?.removeEventListener("abort", cancel);
              if (signal?.aborted) cancel();
              if (childId) {
                awaitingPrompts.delete(childId);
                // Keep the same idle pi session for native queued follow-ups.
                // Each turn releases browser/preview resources in server.ts.
                running.delete(childId);
              }
              row.duration = row.started === undefined ? 0 : Date.now() - row.started;
              updateRow(parent, row); summary();
              release?.();
              if (childId) completions.delete(childId);
              settled?.();
            }
          };
          if (args.chain) {
            let previous: string | undefined;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i]!;
              if (i > 0 && rows[i - 1]!.state !== "Completed") {row.state = "Blocked"; row.output = `Blocked by step ${i}: ${rows[i - 1]!.state}.`; updateRow(parent, row); continue;}
              await run(row, previous); previous = report(row);
            }
            summary();
          } else {
            let next = 0;
            await Promise.all(Array.from({length: Math.min(4, rows.length)}, async () => {while (next < rows.length) await run(rows[next++]!);}));
          }
          await parent.host.drain();
          return {content: [{type: "text", text: rows.map((r,i) => `${single ? "" : `Step ${i+1} · `}${r.job.title || r.role.name} [${r.state}]\n${report(r)}`).join("\n\n")}],
            isError: rows.some(r => r.state !== "Completed"), details: {groupId, mode: single ? "single" : mode.toLowerCase(), agents: rows.map(r => ({...r.relation, state: r.state, tokens: r.tokens, cost: r.cost}))}};
        },
      });
    },
    async connect(value: Server) {
      server = value;
      for (const name of await readdir(sessionDir).catch(() => [] as string[])) {
        if (!name.endsWith(".jsonl")) continue;
        const source = await readFile(join(sessionDir, name), "utf8");
        for (const line of source.split("\n")) try {
          const entry = JSON.parse(line);
          if (entry.type === "custom" && entry.customType === SUBAGENT_RECORD && entry.data?.kind === "child") relations.set(entry.data.childSessionId, entry.data);
        } catch { /* A truncated final journal line is not a relation. */ }
      }
      const create = server.agent.newSession.bind(server.agent);
      server.agent.newSession = async ctx => {const result = await create(ctx); mcpServers.set(result.sessionId, ctx.params.mcpServers); return result;};
      const load = server.agent.loadSession.bind(server.agent);
      server.agent.loadSession = async ctx => {
        const live = sessions.get(ctx.params.sessionId), relation = relations.get(ctx.params.sessionId);
        let result;
        if (live?.host && relation) {
          if (live.pi.sessionManager.getCwd() !== ctx.params.cwd) throw new Error("Child workspace does not match.");
          if (live.host.busy) throw new Error("Child session is already running.");
          await live.host.replay(live.pi.sessionManager.getBranch());
          result = {configOptions: live.host.configOptions(), modes: null};
        } else result = await load(relation?.role ? {...ctx, params: {...ctx.params,
          _meta: {...ctx.params._meta, systemPrompt: {append: relation.role.systemPrompt}},
        }} : ctx);
        mcpServers.set(ctx.params.sessionId, ctx.params.mcpServers);
        const restored = sessions.get(ctx.params.sessionId);
        const restoredTitle = restored?.pi.sessionManager.getSessionName() || relation?.title;
        if (restored?.host && restoredTitle) {
          restored.host.enqueue({sessionUpdate: "session_info_update", title: restoredTitle});
          await restored.host.drain();
        }
        return result;
      };
      const prompt = server.agent.prompt.bind(server.agent);
      server.agent.prompt = async ctx => {
        const relation = relations.get(ctx.params.sessionId);
        if (relation && !awaitingPrompts.delete(ctx.params.sessionId)) {
          if (ctx.params._meta?.eidoUserMessage !== true) throw new RequestError(-32602, "This delegated run is no longer awaiting a prompt.");
          await completions.get(ctx.params.sessionId);
          ctx.signal.throwIfAborted();
          await restore(ctx.params.sessionId, ctx.client);
          const session = sessions.get(ctx.params.sessionId)!;
          if (session.host?.busy) throw new RequestError(-32602, "This agent is running. Use Send next or Queue.");
          const release = reserve(relation.rootSessionId ?? relation.parentSessionId);
          relation.runId = randomUUID(); relation.attempt = (relation.attempt ?? 1) + 1;
          const row: Row = {job: {task: "User follow-up", title: relation.title}, role: relation.role ?? (await discoverAgentRoles(agentDir)).roles[0]!, id: relation.toolCallId, state: "Running", relation, started: Date.now(), model: session.pi.model?.name || session.pi.model?.id};
          running.set(ctx.params.sessionId, row);
          const parent = sessions.get(relation.parentSessionId);
          session.pi.sessionManager.appendCustomEntry(SUBAGENT_RECORD, {...relation, kind: "child"});
          parent?.pi.sessionManager.appendCustomEntry(SUBAGENT_RECORD, {...relation, kind: "parent"});
          if (parent) updateRow(parent, row);
          const previousEntries = new Set(session.pi.sessionManager.getEntries().map(entry => entry.id));
          const command = describeInput(ctx.params.prompt).trimStart().startsWith("/");
          try {
            const result = await prompt(ctx);
            const entry = session.pi.sessionManager.getBranch().findLast(entry =>
              !previousEntries.has(entry.id) && entry.type === "message" && entry.message.role === "assistant");
            const last = entry?.type === "message" && entry.message.role === "assistant" ? entry.message : undefined;
            row.state = result.stopReason === "cancelled" || last?.stopReason === "aborted" ? "Cancelled"
              : result.stopReason === "end_turn" && (last ? last.stopReason !== "error" : command) ? "Completed" : "Failed";
            row.output = last?.errorMessage || (last ? last.content.filter(p => p.type === "text").map(p => p.text).join("\n")
              : row.state === "Completed" && command ? "Command completed." : "No text result.");
            const stats = session.pi.getSessionStats(); row.tokens = stats.tokens.total; row.cost = stats.cost;
            if (parent) await parent.pi.sendCustomMessage({customType: "eido.agent.followup", content: `\n\nFollow-up from ${relation.title} [${row.state}]\nUser request: ${JSON.stringify(describeInput(ctx.params.prompt))}\n${report(row)}\n\n`, display: true}, {triggerTurn: false});
            return result;
          } catch (error) {row.state = "Failed"; row.output = String(error); throw error;}
          finally {release(); running.delete(ctx.params.sessionId); row.duration = Date.now() - row.started!; if (parent) {updateRow(parent, row); await parent.host?.drain();}}
        }
        return prompt(ctx);
      };
      const list = server.agent.listSessions.bind(server.agent);
      server.agent.listSessions = async ctx => {const result = await list(ctx); return {...result, sessions: result.sessions.filter(session => !relations.has(session.sessionId))};};
      const cancel = server.agent.cancel.bind(server.agent);
      server.agent.cancel = ctx => {
        awaitingPrompts.delete(ctx.params.sessionId);
        const row = running.get(ctx.params.sessionId), parent = row?.relation && sessions.get(row.relation.parentSessionId);
        if (row && parent) {row.state = "Stopping"; updateRow(parent, row);}
        stopChildren(ctx.params.sessionId, ctx.client); cancel(ctx);
      };
      const close = server.agent.closeSession.bind(server.agent);
      server.agent.closeSession = async ctx => {
        awaitingPrompts.delete(ctx.params.sessionId);
        stopChildren(ctx.params.sessionId, ctx.client);
        for (const relation of relations.values()) if (relation.parentSessionId === ctx.params.sessionId) {
          await server.agent.closeSession(context({sessionId: relation.childSessionId}, ctx.client));
        }
        const result = await close(ctx);
        sessions.delete(ctx.params.sessionId);
        mcpServers.delete(ctx.params.sessionId);
        return result;
      };
    },
  };
}
