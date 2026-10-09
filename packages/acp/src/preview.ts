import { createHash, randomUUID } from "node:crypto";
import { appendFile, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import {tmpdir} from "node:os";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { methods, type AgentContext } from "@agentclientprotocol/sdk";
import { defineTool, type Extension, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { captureDependencies, changedDependencies, type Dependencies } from "./preview-dependencies.ts";
import { workspacePath } from "./workspace-path.ts";

const observationKey = "eido.dev/observeBuffer";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const text = (value: unknown) => ({ type: "text" as const, text: JSON.stringify(value, null, 2) });
const projectScript = fileURLToPath(new URL("../helpers/preview/project.mjs", import.meta.url));
const commandSchema = Type.Object({
  command: Type.String({ minLength: 1, maxLength: 4096 }),
  args: Type.Optional(Type.Array(Type.String({ maxLength: 16384 }), { maxItems: 128 })),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
});
type Command = { command: string; args?: string[]; timeoutSeconds?: number };
type ProjectResult = { runId: string; stage: string; checks: unknown[]; url?: string; error?: string };
const serverScript = fileURLToPath(new URL("../helpers/preview/server.mjs", import.meta.url));
type Input = { path: string; hash: string; differsFromDisk: boolean };
type Run = {
  runId: string; cwd: string; toolCallId: string; fingerprint: string; entry?: string; files: Input[]; capturedAt: string;
  project: boolean; commands?: Command[]; server?: Command & { path?: string }; dependencies: Dependencies;
  directory: string; terminalId?: string; url?: string; stopped?: boolean; cleanup?: string;
};

export function createPreview(cwd: string, storage: string, sessionId: string, client: AgentContext, purpose: 'preview' | 'shell' = 'preview') {
  let active: Run | undefined;
  let stopping: Promise<void> | undefined;
  const temporaryInputs = new Map<string, Run>();

  async function releaseInputs() {
    for (const [path, run] of temporaryInputs) {
      // Failed captures never started a process. A live run must retain its inputs
      // if stopping failed so the user can retry cleanup.
      if (run.terminalId && !run.stopped) continue;
      await rm(path, {recursive: true, force: true});
      temporaryInputs.delete(path);
    }
  }

  async function observe(path: string, signal?: AbortSignal) {
    const canonical = await workspacePath(cwd, path, true);
    if (purpose === 'shell') {
      const response = await client.request<{content:string;disk:string|null;buffer:string|null}>("_eido/fs/snapshot", {sessionId,path:canonical}, {cancellationSignal:signal})
        .catch(error => {
          signal?.throwIfAborted();
          const detail = typeof error?.data === 'string' ? error.data : error instanceof Error ? error.message : 'Snapshot unavailable';
          throw new Error(`Cannot capture ${path}: ${detail}. Select the complete files needed by this command, use dependencies for installed assets, or files: [] for a command requiring no workspace inputs.`);
        });
      const content = Buffer.from(response.content, 'base64');
      if (content.toString('base64') !== response.content) throw new Error('Invalid native file snapshot.');
      signal?.throwIfAborted();
      return {canonical, content};
    }
    const response = await client.request(methods.client.fs.readTextFile, {
      sessionId, path: canonical, _meta: { [observationKey]: true },
    }, { cancellationSignal: signal });
    if (response._meta?.[observationKey] !== true) {
      throw new Error("This client does not support preview buffer snapshots. Update Eido before using preview.");
    }
    signal?.throwIfAborted();
    return { canonical, content: Buffer.from(response.content) };
  }

  async function freshness(run: Run, signal?: AbortSignal) {
    const checkedAt = new Date().toISOString();
    const changed: string[] = [], unavailable: string[] = [];
    const deadline = AbortSignal.timeout(run.project ? 15_000 : 5000);
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
    for (const file of run.files) {
      signal?.throwIfAborted();
      if (bounded.aborted) { unavailable.push(file.path); continue; }
      try {
        const current = await observe(file.path, bounded);
        if (hash(current.content) !== file.hash) changed.push(file.path);
        if (hash(await readFile(join(run.directory, "files", file.path), { signal: bounded })) !== file.hash) {
          changed.push(`snapshot:${file.path}`);
        }
      } catch (error) {
        signal?.throwIfAborted();
        unavailable.push(file.path);
      }
    }
    if (run.dependencies.entries.length) {
      for (const [base, snapshot] of [[cwd, false], [join(run.directory, "files"), true]] as const) {
        const result = await changedDependencies(base, run.dependencies.entries, bounded, snapshot);
        changed.push(...result.changed.map(path => snapshot ? `snapshot:${path}` : path));
        unavailable.push(...result.unavailable.map(path => snapshot ? `snapshot:${path}` : path));
      }
    }
    signal?.throwIfAborted();
    return { state: unavailable.length ? "unknown" : changed.length ? "stale" : "current",
      checkedAt, changed, unavailable };
  }

  function description(run: Run) {
    return { runId: run.runId, toolCallId: run.toolCallId, cwd: run.cwd, fingerprint: run.fingerprint, url: run.url, capturedAt: run.capturedAt,
      files: run.files, includesUnsavedBuffers: true,
      dependencies: { paths: run.dependencies.roots, entries: run.dependencies.entries.length, bytes: run.dependencies.bytes },
      commands: run.commands, server: run.server, processCleanup: run.cleanup,
      scope: run.project ? "Records listed editor inputs and copied installed dependencies; system tools and external resources are outside the fingerprint. Commands run locally in the captured directory, not an OS sandbox. Generated outputs are not copied back." : "Only listed static inputs; no build or external dependencies.",
      lifetime: run.project ? "Commands, servers and temporary inputs close when the turn ends or is cancelled; recorded evidence remains." : "Until stopped, replaced, task cancelled/closed, or 30 minutes elapsed." };
  }

  async function stop() {
    if (stopping) return stopping;
    const run = active;
    if (!run || run.stopped) return;
    stopping = (async () => {
      if (run.terminalId) {
        if (run.project) {
          // Let the supervisor reap its detached process groups before the native
          // terminal is released (a terminal may otherwise force-kill its leader).
          await writeFile(join(run.directory, "stop"), run.runId, {mode: 0o600});
          const deadline = Date.now() + 5000;
          let closed = false, exited = false;
          while (Date.now() < deadline) {
            try { closed = JSON.parse(await readFile(join(run.directory, "closed.json"), "utf8")).runId === run.runId; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
            if (closed) break;
            const output = await client.request(methods.client.terminal.output, {sessionId, terminalId: run.terminalId}, {cancellationSignal: AbortSignal.timeout(1000)});
            if (output.exitStatus) { exited = true; break; }
            await delay(50);
          }
          if (!closed && !exited) throw new Error("Project supervisor did not finish cleanup. Retry preview stop.");
          run.cleanup = closed ? "confirmed" : "Supervisor exited externally; command guards close their groups on disconnect. Cleanup acknowledgement unavailable.";
        }
        await client.request(methods.client.terminal.release, { sessionId, terminalId: run.terminalId }, { cancellationSignal: AbortSignal.timeout(5000) });
      }
      run.stopped = true;
    })().finally(() => { stopping = undefined; });
    return stopping;
  }

  async function projectResult(run: Run): Promise<ProjectResult | undefined> {
    try {
      const data = JSON.parse(await readFile(join(run.directory, "project-result.json"), "utf8"));
      if (data.runId !== run.runId || !["starting", "checking", "starting_server", "serving", "completed", "failed", "exited"].includes(data.stage) || !Array.isArray(data.checks)) {
        throw new Error("Invalid project verification result.");
      }
      return data;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  async function status(run: Run, signal?: AbortSignal) {
    let service = run.stopped ? "stopped" : "unknown";
    if (!run.stopped && run.terminalId) {
      try {
        const output = await client.request(methods.client.terminal.output, { sessionId, terminalId: run.terminalId }, { cancellationSignal: signal });
        service = output.exitStatus ? "exited" : "running";
      } catch { signal?.throwIfAborted(); }
    }
    return { ...description(run), service, ...(run.project ? { project: await projectResult(run) } : {}), freshness: await freshness(run, signal),
      acceptance: "Not assessed. Browser observations and explicit acceptance criteria are required." };
  }

  const details = (value: Record<string, unknown>) => ({[purpose === "shell" ? "eidoShell" : "eidoVerification"]: {version: 1, ...value}});

  const tool = defineTool({
    name: "preview", label: "Development preview", executionMode: "sequential",
    description: "Start, inspect or stop task-owned project verification from current editor buffers, including unsaved/new files. Always list explicit text files (max 512, 16 MiB total). For static HTML/CSS/JS use an HTML entry. For projects supply sequential commands (check/build) and/or server {command,args,path}; commands run without an implicit shell in a private copy, not an OS sandbox. Select installed dependency/asset directories with dependencies (copied, max 256 MiB); dependencies must not include source files. Nothing is installed or copied back automatically. Supply complete source/config/test inputs. Server must bind HOST/PORT from the environment or {port} in args; path starts with /. macOS/Linux process groups and lsof are required for server ownership. Timeout per check defaults to 60s, max 300s. Start returns command outcomes; zero exits and HTTP reachability are not functional acceptance. Use bundled browser tools to observe/interact, then status to check freshness. Restart after edits. Stop when finished.",
    promptSnippet: "Check, build and preview projects from current editor buffers",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("start"), Type.Literal("status"), Type.Literal("stop")]),
      files: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 512 })),
      entry: Type.Optional(Type.String()),
      dependencies: Type.Optional(Type.Array(Type.String(), { maxItems: 16 })),
      commands: Type.Optional(Type.Array(commandSchema, { minItems: 1, maxItems: 8 })),
      server: Type.Optional(Type.Object({
        command: Type.String({ minLength: 1, maxLength: 4096 }),
        args: Type.Optional(Type.Array(Type.String({ maxLength: 16384 }), { maxItems: 128 })),
        path: Type.Optional(Type.String({ maxLength: 4096 })),
      })),
    }),
    async execute(toolCallId, params, signal) {
      signal?.throwIfAborted();
      if (params.action === "stop") {
        await stop();
        const value = active ? await status(active, signal) : {service: "not_started"};
        return {content: [text(value)], details: active ? details(value) : {}};
      }
      if (params.action === "status") {
        const value = active ? await status(active, signal) : {service: "not_started"};
        return {content: [text(value)], details: active ? details(value) : {}};
      }
      const project = !!(params.commands?.length || params.server);
      if (!params.files || (!params.files.length && purpose !== 'shell') || (!project && !params.entry)) throw new Error("Start requires files and either an HTML entry, commands, or a server.");
      if (!project && params.dependencies?.length) throw new Error("Copied dependencies require a project command or server.");
      if (params.server?.path && (!params.server.path.startsWith("/") || params.server.path.startsWith("//") || /[\\\r\n#]/.test(params.server.path))) throw new Error("Server path must be a local URL path beginning with /.");
      for (const spec of [...params.commands ?? [], ...params.server ? [params.server] : []]) {
        if ([spec.command, ...spec.args ?? []].some(value => value.includes("\0"))) throw new Error("Commands and arguments must not contain NUL bytes.");
      }
      const root = await realpath(cwd);
      const inputs = new Map<string, { content: Buffer; differsFromDisk: boolean }>();
      let bytes = 0;
      for (const path of params.files) {
        const local = relative(root, await workspacePath(root, path, true)).split(sep).join("/");
        if ((purpose !== 'shell' && local.split("/").some(part => part.startsWith("."))) || (!project && ![".html", ".css", ".js", ".mjs", ".json", ".svg", ".txt"].includes(extname(local)))) {
          throw new Error(project ? "Project inputs must be non-hidden text files." : "Preview accepts non-hidden HTML, CSS, JS, MJS, JSON, SVG and TXT inputs only.");
        }
        if (inputs.has(local)) continue;
        const { canonical, content } = await observe(local, signal);
        const size = Buffer.byteLength(content);
        bytes += size;
        if ((purpose !== 'shell' && (content.includes(0) || !Buffer.from(content.toString('utf8')).equals(content))) || size > 1024 * 1024 || bytes > 16 * 1024 * 1024) throw new Error("Inputs exceed the supported type or size (1 MiB per file, 16 MiB total).");
        const disk = await readFile(canonical).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return undefined;
        });
        inputs.set(local, { content, differsFromDisk: disk === undefined || hash(disk) !== hash(content) });
      }
      const entry = params.entry ? relative(root, await workspacePath(root, params.entry, true)).split(sep).join("/") : undefined;
      if (!project && (!entry || !inputs.has(entry) || extname(entry) !== ".html")) throw new Error("Entry must be an HTML file included in files.");
      if (project && entry) throw new Error("Use server.path for a project server, or omit commands/server for a static HTML entry.");
      const files = [...inputs].sort(([a], [b]) => a.localeCompare(b)).map(([path, file]) => ({ path, hash: hash(file.content), differsFromDisk: file.differsFromDisk }));
      const runId = randomUUID();
      const run: Run = { runId, cwd: root, toolCallId, entry, files, capturedAt: new Date().toISOString(),
        project, commands: params.commands, server: params.server, dependencies: {roots: [], entries: [], bytes: 0}, fingerprint: "",
        directory: join(storage, hash(sessionId), runId) };
      await mkdir(run.directory, { recursive: true, mode: 0o700 });
      if (project) {
        // Keep package resolution away from ancestor workspace node_modules.
        // Evidence stays in private storage; execution inputs live outside the project.
        const temporary = await realpath(await mkdtemp(join(tmpdir(), "eido-project-")));
        temporaryInputs.set(temporary, run);
        await symlink(temporary, join(run.directory, "files"));
      }
      for (const [path, file] of inputs) {
        const target = join(run.directory, "files", path);
        await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
        await writeFile(target, file.content, { mode: 0o600 });
      }
      run.dependencies = await captureDependencies(root, params.dependencies ?? [], join(run.directory, "files"), files.map(file => file.path), signal);
      run.fingerprint = hash(JSON.stringify({ entry, files: files.map(({path, hash}) => ({path, hash})), dependencies: run.dependencies, commands: run.commands, server: run.server }));
      await writeFile(join(run.directory, "manifest.json"), JSON.stringify({ ...run, sessionId, piVersion: "1.1.0" }, null, 2), { mode: 0o600 });
      // Recheck after capture. Multi-file reads are sequential, not an atomic editor transaction.
      const captured = await freshness(run, signal);
      if (captured.state !== "current") throw new Error("Inputs changed during capture. Read the files and start a new preview.");
      await stop();
      active = run;
      await client.notify(methods.client.session.update, {sessionId, update: {
        sessionUpdate: "tool_call_update", toolCallId,
        rawOutput: details({...description(run), service: "starting", freshness: captured}),
      }});
      try {
        signal?.throwIfAborted();
        // Keep ownership of a late create response so cancellation can release it.
        const terminal = await client.request(methods.client.terminal.create, {
          sessionId, command: process.execPath, args: [project ? projectScript : serverScript, run.directory, String(process.pid)],
          cwd: run.directory, outputByteLimit: 8192,
        });
        run.terminalId = terminal.terminalId;
        signal?.throwIfAborted();
        await client.notify(methods.client.session.update, { sessionId, update: {
          sessionUpdate: "tool_call_update", toolCallId,
          content: [{ type: "terminal", terminalId: terminal.terminalId }],
        } });
        const timeout = project ? (params.commands ?? []).reduce((total, command) => total + (command.timeoutSeconds ?? 60) * 1000, 45_000) : 15_000;
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const output = await client.request(methods.client.terminal.output, { sessionId, terminalId: terminal.terminalId }, { cancellationSignal: signal });
          if (project) {
            // Read our atomically written result, never interpret command output as protocol.
            const result = await projectResult(run);
            if (result?.stage === "serving" || result?.stage === "completed" || result?.stage === "failed") {
              if (result.url) {
                const url = new URL(result.url);
                if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password) throw new Error("Invalid project server URL.");
                run.url = result.url;
              }
              if (result.stage !== "serving") await stop();
              const value = await status(run, signal);
              await writeFile(join(run.directory, "started.json"), JSON.stringify(value, null, 2), { mode: 0o600 });
              return { content: [text(value)], details: details(value), ...(result.stage === "failed" ? {isError: true} : {}) };
            }
          }
          const ready = !project && output.output.match(/EIDO_PREVIEW_READY (\{[^\r\n]+\})/);
          if (ready) {
            const data = JSON.parse(ready[1]!);
            if (data.runId !== runId || !Number.isInteger(data.port) || data.port < 1 || data.port > 65535) throw new Error("Invalid preview startup response.");
            run.url = `http://127.0.0.1:${data.port}/${runId}/${entry!.split("/").map(encodeURIComponent).join("/")}`;
            const result = await status(run, signal);
            await writeFile(join(run.directory, "started.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
            return { content: [text(result)], details: details(result) };
          }
          if (output.exitStatus) throw new Error(`Preview exited before becoming ready: ${output.output}`);
          await delay(100, undefined, { signal });
        }
        throw new Error(`Preview did not finish startup within ${timeout / 1000} seconds.`);
      } catch (error) {
        await stop();
        if (signal?.aborted) {
          const value = {...description(run), service: "stopped", cancelled: true,
            ...(run.project ? {project: await projectResult(run)} : {}),
            freshness: {...captured, state: "unknown"}};
          return {content: [text(value)], details: details(value), isError: true};
        }
        const value = {...await status(run), error: error instanceof Error ? error.message : String(error)};
        return {content: [text(value)], details: details(value), isError: true};
      }
    },
  });

  // Extend pi's existing event pipeline; evidence stays with the existing ACP tool call.
  async function browserEvidence(event: ToolResultEvent) {
    const run = active;
    if (!run?.url || run.stopped || !["mcp__eido_browser__browser_open", "mcp__eido_browser__browser_snapshot"].includes(event.toolName)) return;
    const observed = event.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    let observedUrl = observed.match(/^url: (.+)$/m)?.[1];
    if (!observedUrl) {
      try { observedUrl = JSON.parse(observed).url; } catch { /* legacy text snapshot */ }
    }
    if (!observedUrl) return;
    let matches = false;
    try {
      const url = new URL(observedUrl), target = new URL(run.url);
      matches = url.origin === target.origin && (run.project || url.pathname.startsWith(`/${run.runId}/`));
    } catch { return; }
    if (!matches) return;
    const evidence = { ...description(run), toolCallId: event.toolCallId, toolName: event.toolName,
      observedUrl, toolSucceeded: !event.isError, ...(run.project ? { project: await projectResult(run) } : {}), freshness: await freshness(run),
      acceptance: "Observation only; not an automatic pass.", recordedAt: new Date().toISOString() };
    await appendFile(join(run.directory, "evidence.jsonl"), JSON.stringify({ ...evidence, observed }) + "\n", { mode: 0o600 });
    return { content: [...event.content, text({ previewEvidence: evidence })],
      details: {...event.details as Record<string, unknown>, ...details({...evidence, observation: true})} };
  }
  const path = `<inline:eido-${purpose}>`;
  const extension: Extension = {
    path, resolvedPath: path, sourceInfo: { path, source: "inline", scope: "user", origin: "top-level" },
    handlers: new Map([
      ["session_shutdown", [async () => {
        try { await stop(); } finally { await releaseInputs(); }
      }]],
      ["tool_result", [async (event: unknown) => browserEvidence(event as ToolResultEvent)]],
    ]),
    tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(),
  };
  return { tool, extension, stop, snapshot: () => active, preserveInputs: async () => {
    const run = active;
    if (!run || !run.stopped) throw new Error('Stop the command before preserving its output.');
    const link = join(run.directory, 'files');
    const source = await realpath(link);
    const destination = join(run.directory, 'output-snapshot');
    if (source === destination) return destination;
    try { await rename(source, destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      await cp(source, destination, {recursive: true, verbatimSymlinks: true});
      await rm(source, {recursive: true, force: true});
    }
    temporaryInputs.delete(source);
    await rm(link);
    await symlink(destination, link);
    return destination;
  }, finishTurn: async (stopStatic = false) => {
    try { if (stopStatic || active?.project) await stop(); }
    finally { await releaseInputs(); }
  } };
}
