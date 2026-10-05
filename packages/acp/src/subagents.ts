import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { RequestError, type AgentContext, type SessionUpdate, type SessionConfigOption } from "@agentclientprotocol/sdk";
import { defineTool, type AgentSession, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { runAcp } from "@automatalabs/pi-acp";

export const SUBAGENT_RECORD = "eido.subagent.v1";
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
  parentSessionId: string;
  childSessionId: string;
  toolCallId: string;
  title: string;
  runId: string;
}
interface Session { pi: AgentSession; host?: Host }

/** Child sessions use the same ACP adapter, native buffers and pi lifecycle. */
export function createSubagents(sessionDir: string) {
  const sessions = new Map<string, Session>();
  const relations = new Map<string, Relation>();
  const awaitingPrompts = new Set<string>();
  const opening = new AsyncLocalStorage<Relation>();
  let server: Server;
  let enabled = false;

  const context = <T>(params: T, client: AgentContext, signal = new AbortController().signal) => ({params, client, signal, requestId: randomUUID()});
  const meta = (relation: Relation) => ({subagent_session_info: {session_id: relation.childSessionId, message_start_index: 0}});
  const stopChildren = (parentSessionId: string, client: AgentContext) => {
    for (const relation of relations.values()) if (relation.parentSessionId === parentSessionId) {
      server.agent.cancel(context({sessionId: relation.childSessionId}, client));
    }
  };

  return {
    setEnabled(value: boolean) { enabled = value; },
    get enabled() { return enabled; },
    register(pi: AgentSession) {
      const saved = pi.sessionManager.getEntries().find(entry =>
        entry.type === "custom" && entry.customType === SUBAGENT_RECORD && (entry.data as {kind?: string})?.kind === "child"
      );
      const relation = opening.getStore() ?? (saved?.type === "custom" ? saved.data as Relation : undefined);
      if (relation) {
        relation.childSessionId = pi.sessionId;
        relations.set(pi.sessionId, relation);
        // A first-stage inspector can only read native buffers. Do not silently
        // allow disk writers from arbitrary extension tools in a child session.
        pi.setActiveToolsByName(["read"]);
        if (opening.getStore()) pi.sessionManager.appendCustomEntry(SUBAGENT_RECORD, {...relation, kind: "child"});
      }
      const session: Session = {pi};
      sessions.set(pi.sessionId, session);
      Object.defineProperty(pi, HOST, {value: {attach(host: Host) {session.host = host;}}});
      return relation;
    },
    tool(parentId: string, client: AgentContext) {
      return defineTool({
        name: "subagent", label: "Delegate inspection",
        description: "Delegate a focused code inspection or review to an independent pi subagent. It can read current editor buffers, including unsaved edits. It cannot modify files or spawn further agents. Its activity appears in the workbench. The main agent receives its final report. Use a concise title and a self-contained task; the child does not inherit conversation history.",
        parameters: Type.Object({title: Type.String({minLength: 1, maxLength: 120}), task: Type.String({minLength: 1})}),
        async execute(toolCallId, args, signal) {
          if (!enabled) throw new Error("This client does not support native subagents.");
          if (relations.has(parentId)) throw new Error("Nested delegation is not available in this iteration.");
          const parent = sessions.get(parentId);
          if (!parent?.host) throw new Error("Parent session is not ready.");
          const relation: Relation = {parentSessionId: parentId, childSessionId: "", toolCallId, title: args.title, runId: randomUUID()};
          let childId: string | undefined;
          const cancel = () => { if (childId) server.agent.cancel(context({sessionId: childId}, client)); };
          signal?.addEventListener("abort", cancel, {once: true});
          try {
            signal?.throwIfAborted();
            const created = await opening.run(relation, () => server.agent.newSession(context({
              cwd: parent.pi.sessionManager.getCwd(), mcpServers: [],
              _meta: {systemPrompt: {append: "You are a delegated code inspector in Eido. Read current buffers using the read tool. Do not modify files. Complete only the assigned inspection and return concise findings with file references. Distinguish verified facts from suggestions."}},
            }, client, signal)));
            childId = created.sessionId;
            const child = sessions.get(childId);
            if (!child?.host) throw new Error("Child session is not ready.");
            if (parent.pi.model) await child.pi.setModel(parent.pi.model);
            child.pi.setThinkingLevel(parent.pi.thinkingLevel);
            child.pi.setSessionName(args.title);
            parent.pi.sessionManager.appendCustomEntry(SUBAGENT_RECORD, {...relation, kind: "parent"});
            parent.host.enqueue({sessionUpdate: "tool_call_update", toolCallId, title: args.title, status: "in_progress", _meta: meta(relation)});
            await parent.host.drain();
            signal?.throwIfAborted();
            awaitingPrompts.add(childId);
            // The native client first loads/registers the child, then sends its
            // normal ACP prompt. No child tokens can precede that registration.
            const response = await client.request<{stopReason: string}>(SUBAGENT_RUN, {
              ...relation, task: args.task,
            }, {cancellationSignal: signal});
            signal?.throwIfAborted();
            const last = child.pi.messages.findLast(message => message.role === "assistant");
            const output = last?.role === "assistant" ? last.content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
            if (response.stopReason !== "end_turn" || last?.role !== "assistant" || last.stopReason === "error" || last.stopReason === "aborted") {
              throw new Error(response.stopReason === "cancelled" ? "Subagent stopped." : "Subagent did not complete successfully.");
            }
            return {content: [{type: "text", text: output || "Inspection completed without a text report."}], details: {subagent: relation}};
          } finally {
            signal?.removeEventListener("abort", cancel);
            if (signal?.aborted) cancel();
            // Closing releases pi/ACP resources while retaining the journal and
            // native transcript. A later session/load can replay it normally.
            if (childId) {
              awaitingPrompts.delete(childId);
              await server.agent.closeSession(context({sessionId: childId}, client));
              sessions.delete(childId);
            }
          }
        },
      });
    },
    async connect(value: Server) {
      server = value;
      // Reload ownership from pi's append-only journals, including interrupted
      // children. It is state metadata, never a second conversation store.
      for (const name of await readdir(sessionDir).catch(() => [] as string[])) {
        if (!name.endsWith(".jsonl")) continue;
        const source = await readFile(join(sessionDir, name), "utf8");
        for (const line of source.split("\n")) {
          try {
            const entry = JSON.parse(line);
            if (entry.type === "custom" && entry.customType === SUBAGENT_RECORD && entry.data?.kind === "child") {
              relations.set(entry.data.childSessionId, entry.data);
              break;
            }
          } catch { /* An interrupted final journal line is not a relation. */ }
        }
      }
      const load = server.agent.loadSession.bind(server.agent);
      server.agent.loadSession = async ctx => {
        const live = sessions.get(ctx.params.sessionId);
        const relation = relations.get(ctx.params.sessionId);
        let result;
        if (live?.host && relation) {
          if (live.pi.sessionManager.getCwd() !== ctx.params.cwd) throw new Error("Child workspace does not match.");
          if (live.host.busy) throw new Error("Child session is already running.");
          await live.host.replay(live.pi.sessionManager.getBranch());
          result = {configOptions: live.host.configOptions(), modes: null};
        } else result = await load(ctx);
        // Session-info entries are not message chunks. Restore the title after
        // replay so opening a historical child does not show "New Agent Thread".
        const restored = sessions.get(ctx.params.sessionId);
        if (relation && restored?.host) {
          restored.host.enqueue({sessionUpdate: "session_info_update", title: restored.pi.sessionManager.getSessionName() || relation.title});
          await restored.host.drain();
        }
        return result;
      };
      const prompt = server.agent.prompt.bind(server.agent);
      server.agent.prompt = ctx => {
        // A delayed native load must not restart a cancelled/completed run.
        // Consume the one launch granted by the live parent tool invocation.
        if (relations.has(ctx.params.sessionId) && !awaitingPrompts.delete(ctx.params.sessionId)) {
          throw new RequestError(-32602, "This delegated run is no longer awaiting a prompt.");
        }
        return prompt(ctx);
      };
      const list = server.agent.listSessions.bind(server.agent);
      server.agent.listSessions = async ctx => {
        const result = await list(ctx);
        return {...result, sessions: result.sessions.filter(session => !relations.has(session.sessionId))};
      };
      const cancel = server.agent.cancel.bind(server.agent);
      server.agent.cancel = ctx => {
        awaitingPrompts.delete(ctx.params.sessionId);
        stopChildren(ctx.params.sessionId, ctx.client);
        cancel(ctx);
      };
      const close = server.agent.closeSession.bind(server.agent);
      server.agent.closeSession = async ctx => {
        awaitingPrompts.delete(ctx.params.sessionId);
        stopChildren(ctx.params.sessionId, ctx.client);
        const result = await close(ctx);
        sessions.delete(ctx.params.sessionId);
        return result;
      };
    },
  };
}
