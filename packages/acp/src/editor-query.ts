import type {AgentContext} from "@agentclientprotocol/sdk";
import {execFile} from "node:child_process";
import {readdir} from "node:fs/promises";
import {basename, matchesGlob} from "node:path";
import {createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, defineTool} from "@earendil-works/pi-coding-agent";
import type {sessionFileResources} from "./editor-tools.ts";
import {buildArtifactPath, findBuildReferences, listBuildArtifacts, readToolText, workspacePath} from "./workspace-path.ts";

export const EDITOR_QUERY = "_eido/fs/query";
type Query = {path?: string; pattern?: string; glob?: string; limit?: number; context?: number; ignoreCase?: boolean; literal?: boolean};

async function grepBuildFile(cwd: string, path: string, args: Query, signal?: AbortSignal) {
  const canonical = await buildArtifactPath(cwd, path, "read");
  if (!canonical) {
    if (await buildArtifactPath(cwd, path, "find")) {
      throw new Error("For read-only upstream references, use find to locate Rust source or Cargo.toml files, then grep or read one file at a time.");
    }
    return;
  }
  if (!args.pattern || /[\r\n\0]/.test(args.pattern)) throw new Error("Provide a single-line search pattern.");
  const name = basename(canonical);
  const empty = {output: "No matches found", truncated: false};
  if (args.glob && !matchesGlob(name, args.glob.replace(/^(?:\.\/)+/, ""))) return empty;
  const data = await readToolText(canonical, signal);
  // Pass bounded file content over stdin instead of giving grep a directory
  // or a protected path. The built-in OS grep supports fixed strings and EREs.
  const limit = Math.min(args.limit ?? 100, 1000);
  const matches = await new Promise<string>((resolve, reject) => {
    const child = execFile("/usr/bin/grep", ["-n", "-m", String(limit + 1), args.literal ? "-F" : "-E",
      ...(args.ignoreCase ? ["-i"] : []), "-e", args.pattern!],
      {signal, timeout: 3000, maxBuffer: 5 * 1024 * 1024}, (error, stdout, stderr) => {
        if (error && error.code !== 1) reject(new Error(stderr.trim() || error.message));
        else resolve(stdout);
      });
    child.stdin?.on("error", () => {}); // grep may finish before consuming its input.
    child.stdin?.end(data);
  });
  if (!matches) return empty;
  const numbers = matches.trimEnd().split("\n").map(line => Number(line.split(":", 1)[0]));
  const rows = new Set(numbers.slice(0, limit));
  const context = Math.min(args.context ?? 0, 100);
  const source = data.toString("utf8").split("\n");
  const output: string[] = [];
  let truncated = numbers.length > limit;
  let bytes = 0;
  let previous = 0;
  outer: for (const row of rows) {
    for (let i = Math.max(previous + 1, 1, row - context); i <= Math.min(source.length, row + context); i++) {
      const sep = rows.has(i) ? ":" : "-";
      const line = `${name}${sep}${i}${sep} ${source[i - 1]!.slice(0, 500)}`;
      bytes += Buffer.byteLength(line) + 1;
      if (bytes > 50 * 1024) { truncated = true; break outer; }
      output.push(line);
      previous = i;
    }
  }
  return {output: output.join("\n") + (truncated ? "\n\n[Results truncated. Narrow the pattern or context.]" : ""), truncated};
}

/** Keep pi's public tool schemas and query current native project buffers. */
export function editorQueryTools(cwd: string, sessionId: string, client: Pick<AgentContext, "request">,
  resourcePath?: ReturnType<typeof sessionFileResources>) {
  const execute = (operation: "find" | "grep" | "ls") => async (_id: string, args: Query, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    for (const key of ["limit", "context"] as const) {
      const value = args[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < (key === "limit" ? 1 : 0))) {
        throw new Error(`${key} must be ${key === "limit" ? "a positive" : "a non-negative"} integer.`);
      }
    }
    signal?.throwIfAborted();
    const base = args.path ?? ".";
    const build = operation === "ls" ? await listBuildArtifacts(cwd, base, args.limit ?? 500)
      : operation === "find" && args.pattern ? await findBuildReferences(cwd, base, args.pattern, Math.min(args.limit ?? 500, 1000), signal)
      : operation === "grep" ? await grepBuildFile(cwd, base, args, signal) : undefined;
    const resource = !build && operation === "ls" ? await resourcePath?.(base, "ls") : undefined;
    const listing = resource ? await listResource(resource, Math.min(args.limit ?? 500, 500), signal) : undefined;
    const result = build ?? listing ?? await client.request<{output: string; truncated: boolean}>(EDITOR_QUERY,
      {sessionId, operation, ...args, path: await workspacePath(cwd, args.path ?? ".", true)}, {cancellationSignal: signal});
    signal?.throwIfAborted();
    return {content: [{type: "text" as const, text: result.output}], details: {
      source: build ? "build-artifacts" : listing ? "session-resource" : "editor", truncated: result.truncated,
      resultLimitReached: operation === "find" && result.truncated ? args.limit ?? 500 : undefined,
      matchLimitReached: operation === "grep" && result.truncated ? args.limit ?? 100 : undefined,
      entryLimitReached: operation === "ls" && result.truncated ? args.limit ?? 500 : undefined,
    }};
  };
  return [
    defineTool({...createFindToolDefinition(cwd), execute: execute("find"),
      description: "Find workspace files by glob. Explicit .local/upstream/zed/crates paths can find Rust and Cargo reference sources."}),
    defineTool({...createGrepToolDefinition(cwd), execute: execute("grep"),
      description: "Search editor contents, including unsaved changes, using a regex or literal pattern. Respects project exclusions. For approved .local files, search one explicit file at a time with a literal or POSIX extended regex. Use find for upstream reference directories. Results are bounded; read a file before editing."}),
    defineTool({...createLsToolDefinition(cwd), execute: execute("ls"),
      description: "List files and directories in the project, this session's scratchpad or a skill directory. An explicit .local path shows only approved build outputs; private runtime state stays hidden."}),
  ];
}

async function listResource(path: string, limit: number, signal?: AbortSignal) {
  const entries = (await readdir(path, {withFileTypes: true}))
    .filter(entry => !entry.name.startsWith(".") && entry.name.toLowerCase() !== "node_modules"
      && (entry.isFile() || entry.isDirectory()))
    .map(entry => entry.name + (entry.isDirectory() ? "/" : "")).sort();
  signal?.throwIfAborted();
  const output: string[] = [];
  let bytes = 0;
  for (const entry of entries.slice(0, limit)) {
    bytes += Buffer.byteLength(entry) + 1;
    if (bytes > 50 * 1024) break;
    output.push(entry);
  }
  const truncated = output.length < entries.length;
  return {output: (output.join("\n") || "(empty directory)")
    + (truncated ? "\n\n[Directory listing truncated. Use a more specific path.]" : ""), truncated};
}
