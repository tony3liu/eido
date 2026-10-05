import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { methods, type AgentContext } from "@agentclientprotocol/sdk";
import { defineTool, type Extension, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { workspacePath } from "./workspace-path.ts";

const observationKey = "eido.dev/observeBuffer";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const text = (value: unknown) => ({ type: "text" as const, text: JSON.stringify(value, null, 2) });
const serverScript = fileURLToPath(new URL("../../../scripts/preview-server.mjs", import.meta.url));
type Input = { path: string; hash: string; differsFromDisk: boolean };
type Run = {
  runId: string; fingerprint: string; entry: string; files: Input[]; capturedAt: string;
  directory: string; terminalId?: string; url?: string; stopped?: boolean;
};

export function createPreview(cwd: string, storage: string, sessionId: string, client: AgentContext) {
  let active: Run | undefined;
  let stopping: Promise<void> | undefined;

  async function observe(path: string, signal?: AbortSignal) {
    const canonical = await workspacePath(cwd, path);
    const response = await client.request(methods.client.fs.readTextFile, {
      sessionId, path: canonical, _meta: { [observationKey]: true },
    }, { cancellationSignal: signal });
    if (response._meta?.[observationKey] !== true) {
      throw new Error("This client does not support preview buffer snapshots. Update Eido before using preview.");
    }
    signal?.throwIfAborted();
    return { canonical, content: response.content };
  }

  async function freshness(run: Run, signal?: AbortSignal) {
    const changed: string[] = [], unavailable: string[] = [];
    const deadline = AbortSignal.timeout(5000);
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
    for (const file of run.files) {
      signal?.throwIfAborted();
      if (bounded.aborted) { unavailable.push(file.path); continue; }
      try {
        const current = await observe(file.path, bounded);
        if (hash(current.content) !== file.hash) changed.push(file.path);
      } catch (error) {
        signal?.throwIfAborted();
        unavailable.push(file.path);
      }
    }
    return { state: unavailable.length ? "unknown" : changed.length ? "stale" : "current",
      checkedAt: new Date().toISOString(), changed, unavailable };
  }

  function description(run: Run) {
    return { runId: run.runId, fingerprint: run.fingerprint, url: run.url, capturedAt: run.capturedAt,
      files: run.files, includesUnsavedBuffers: true, scope: "Only listed static inputs; no build or external dependencies.",
      lifetime: "Until stopped, replaced, task cancelled/closed, or 30 minutes elapsed." };
  }

  async function stop() {
    if (stopping) return stopping;
    const run = active;
    if (!run || run.stopped) return;
    stopping = (async () => {
      if (run.terminalId) {
        await client.request(methods.client.terminal.release, { sessionId, terminalId: run.terminalId }, { cancellationSignal: AbortSignal.timeout(5000) });
      }
      run.stopped = true;
    })().finally(() => { stopping = undefined; });
    return stopping;
  }

  async function status(run: Run, signal?: AbortSignal) {
    let service = run.stopped ? "stopped" : "unknown";
    if (!run.stopped && run.terminalId) {
      try {
        const output = await client.request(methods.client.terminal.output, { sessionId, terminalId: run.terminalId }, { cancellationSignal: signal });
        service = output.exitStatus ? "exited" : "running";
      } catch { signal?.throwIfAborted(); }
    }
    return { ...description(run), service, freshness: await freshness(run, signal),
      acceptance: "Not assessed. Browser observations and explicit acceptance criteria are required." };
  }

  const tool = defineTool({
    name: "preview", label: "Development preview", executionMode: "sequential",
    description: "Start, inspect or stop a task-owned static HTML/CSS/JS preview using current editor buffers, including unsaved edits. Start requires an explicit list of existing workspace files (max 64, 4 MiB total) and an HTML entry within it. Paths are workspace relative. Only listed files are served; use relative asset URLs. No npm/build scripts or backend, no external network resources. Restart after editing. Status checks whether inputs still match; it is not an acceptance test. Use the bundled browser tools to observe and interact with the returned URL.",
    promptSnippet: "Start and inspect static previews of current editor buffers",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("start"), Type.Literal("status"), Type.Literal("stop")]),
      files: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 64 })),
      entry: Type.Optional(Type.String()),
    }),
    async execute(toolCallId, params, signal) {
      signal?.throwIfAborted();
      if (params.action === "stop") { await stop(); return { content: [text({ service: "stopped", runId: active?.runId })], details: {} }; }
      if (params.action === "status") {
        return { content: [text(active ? await status(active, signal) : { service: "not_started" })], details: {} };
      }
      if (!params.files?.length || !params.entry) throw new Error("Start requires files and entry.");
      const root = await realpath(cwd);
      const inputs = new Map<string, { content: string; differsFromDisk: boolean }>();
      let bytes = 0;
      for (const path of params.files) {
        const local = relative(root, await workspacePath(root, path)).split(sep).join("/");
        if (local.split("/").some(part => part.startsWith(".")) || ![".html", ".css", ".js", ".mjs", ".json", ".svg", ".txt"].includes(extname(local))) {
          throw new Error("Preview accepts non-hidden HTML, CSS, JS, MJS, JSON, SVG and TXT inputs only.");
        }
        if (inputs.has(local)) continue;
        const { canonical, content } = await observe(local, signal);
        const size = Buffer.byteLength(content);
        bytes += size;
        if (size > 1024 * 1024 || bytes > 4 * 1024 * 1024) throw new Error("Preview input limit exceeded (1 MiB per file, 4 MiB total).");
        inputs.set(local, { content, differsFromDisk: hash(await readFile(canonical)) !== hash(content) });
      }
      const entry = relative(root, await workspacePath(root, params.entry)).split(sep).join("/");
      if (!inputs.has(entry) || extname(entry) !== ".html") throw new Error("Entry must be an HTML file included in files.");
      const files = [...inputs].sort(([a], [b]) => a.localeCompare(b)).map(([path, file]) => ({ path, hash: hash(file.content), differsFromDisk: file.differsFromDisk }));
      const runId = randomUUID();
      const run: Run = { runId, entry, files, capturedAt: new Date().toISOString(),
        fingerprint: hash(JSON.stringify({ entry, files: files.map(({ path, hash }) => ({ path, hash })) })),
        directory: join(storage, hash(sessionId), runId) };
      await mkdir(run.directory, { recursive: true, mode: 0o700 });
      for (const [path, file] of inputs) {
        const target = join(run.directory, "files", path);
        await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
        await writeFile(target, file.content, { mode: 0o600 });
      }
      await writeFile(join(run.directory, "manifest.json"), JSON.stringify({ ...run, sessionId, piVersion: "1.0.2" }, null, 2), { mode: 0o600 });
      // Recheck after capture. Multi-file reads are sequential, not an atomic editor transaction.
      const captured = await freshness(run, signal);
      if (captured.state !== "current") throw new Error("Inputs changed during capture. Read the files and start a new preview.");
      await stop();
      active = run;
      try {
        signal?.throwIfAborted();
        // Keep ownership of a late create response so cancellation can release it.
        const terminal = await client.request(methods.client.terminal.create, {
          sessionId, command: process.execPath, args: [serverScript, run.directory, String(process.pid)],
          cwd: run.directory, outputByteLimit: 8192,
        });
        run.terminalId = terminal.terminalId;
        signal?.throwIfAborted();
        await client.notify(methods.client.session.update, { sessionId, update: {
          sessionUpdate: "tool_call_update", toolCallId,
          content: [{ type: "terminal", terminalId: terminal.terminalId }],
        } });
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const output = await client.request(methods.client.terminal.output, { sessionId, terminalId: terminal.terminalId }, { cancellationSignal: signal });
          const ready = output.output.match(/EIDO_PREVIEW_READY (\{[^\r\n]+\})/);
          if (ready) {
            const data = JSON.parse(ready[1]!);
            if (data.runId !== runId || !Number.isInteger(data.port) || data.port < 1 || data.port > 65535) throw new Error("Invalid preview startup response.");
            run.url = `http://127.0.0.1:${data.port}/${runId}/${entry.split("/").map(encodeURIComponent).join("/")}`;
            const result = await status(run, signal);
            await writeFile(join(run.directory, "started.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
            return { content: [text(result)], details: {} };
          }
          if (output.exitStatus) throw new Error(`Preview exited before becoming ready: ${output.output}`);
          await delay(100, undefined, { signal });
        }
        throw new Error("Preview did not become ready within 15 seconds.");
      } catch (error) { await stop(); throw error; }
    },
  });

  // Extend pi's existing event pipeline; evidence stays with the existing ACP tool call.
  async function browserEvidence(event: ToolResultEvent) {
    const run = active;
    if (!run?.url || !["mcp__eido_browser__browser_open", "mcp__eido_browser__browser_snapshot"].includes(event.toolName)) return;
    const observed = event.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    const observedUrl = observed.match(/^url: (.+)$/m)?.[1];
    if (!observedUrl) return;
    let matches = false;
    try {
      const url = new URL(observedUrl), target = new URL(run.url);
      matches = url.origin === target.origin && url.pathname.startsWith(`/${run.runId}/`);
    } catch { return; }
    if (!matches) return;
    const evidence = { ...description(run), toolCallId: event.toolCallId, toolName: event.toolName,
      observedUrl, toolSucceeded: !event.isError, freshness: await freshness(run),
      acceptance: "Observation only; not an automatic pass.", recordedAt: new Date().toISOString() };
    await appendFile(join(run.directory, "evidence.jsonl"), JSON.stringify({ ...evidence, observed }) + "\n", { mode: 0o600 });
    return { content: [...event.content, text({ previewEvidence: evidence })] };
  }
  const path = "<inline:eido-preview>";
  const extension: Extension = {
    path, resolvedPath: path, sourceInfo: { path, source: "inline", scope: "user", origin: "top-level" },
    handlers: new Map([
      ["session_shutdown", [async () => { await stop(); }]],
      ["tool_result", [async (event: unknown) => browserEvidence(event as ToolResultEvent)]],
    ]),
    tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(),
  };
  return { tool, extension, stop };
}
