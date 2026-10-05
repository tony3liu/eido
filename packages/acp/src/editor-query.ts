import type {AgentContext} from "@agentclientprotocol/sdk";
import {createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, defineTool} from "@earendil-works/pi-coding-agent";
import {workspacePath} from "./workspace-path.ts";

export const EDITOR_QUERY = "_eido/fs/query";
type Query = {path?: string; pattern?: string; glob?: string; limit?: number; context?: number; ignoreCase?: boolean; literal?: boolean};

/** Keep pi's public tool schemas; all queries run against the native project. */
export function editorQueryTools(cwd: string, sessionId: string, client: Pick<AgentContext, "request">) {
  const execute = (operation: "find" | "grep" | "ls") => async (_id: string, args: Query, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const path = await workspacePath(cwd, args.path ?? ".");
    for (const key of ["limit", "context"] as const) {
      const value = args[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < (key === "limit" ? 1 : 0))) {
        throw new Error(`${key} must be ${key === "limit" ? "a positive" : "a non-negative"} integer.`);
      }
    }
    signal?.throwIfAborted();
    const result = await client.request<{output: string; truncated: boolean}>(EDITOR_QUERY,
      {sessionId, operation, ...args, path}, {cancellationSignal: signal});
    return {content: [{type: "text" as const, text: result.output}], details: {
      source: "editor", truncated: result.truncated,
      resultLimitReached: operation === "find" && result.truncated ? args.limit ?? 500 : undefined,
      matchLimitReached: operation === "grep" && result.truncated ? args.limit ?? 100 : undefined,
      entryLimitReached: operation === "ls" && result.truncated ? args.limit ?? 500 : undefined,
    }};
  };
  return [
    defineTool({...createFindToolDefinition(cwd), execute: execute("find")}),
    defineTool({...createGrepToolDefinition(cwd), execute: execute("grep"),
      description: "Search current editor contents, including unsaved changes, using a regex or literal pattern. Returns file paths, line numbers and optional context. Respects project exclusions. Read a file before editing it. Results are bounded; narrow the path or pattern when truncated."}),
    defineTool({...createLsToolDefinition(cwd), execute: execute("ls")}),
  ];
}
