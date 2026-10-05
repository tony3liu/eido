import { AsyncLocalStorage } from "node:async_hooks";
import { workspacePath } from "./workspace-path.ts";
import { methods, type AgentContext } from "@agentclientprotocol/sdk";
import {
  createReadToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  defineTool,
} from "@earendil-works/pi-coding-agent";

export function editorTools(cwd: string, sessionId: string, client: Pick<AgentContext, "request">) {
  const readPaths = new Set<string>();
  const signals = new AsyncLocalStorage<AbortSignal | undefined>();
  const checkPath = (path: string) => workspacePath(cwd, path);
  const readFile = async (path: string) => {
    const canonical = await checkPath(path);
    const response = await client.request(methods.client.fs.readTextFile, { sessionId, path: canonical }, { cancellationSignal: signals.getStore() });
    readPaths.add(canonical);
    return Buffer.from(response.content, "utf8");
  };
  const writeFile = async (path: string, content: string) => {
    const canonical = await checkPath(path);
    if (!readPaths.has(canonical)) throw new Error("Read the file in this session before replacing its contents.");
    await client.request(methods.client.fs.writeTextFile, { sessionId, path: canonical, content }, { cancellationSignal: signals.getStore() });
  };
  const access = async (path: string) => { await checkPath(path); };
  return [
    defineTool(createReadToolDefinition(cwd, { operations: { readFile, access, detectImageMimeType: async () => null } })),
    defineTool(createEditToolDefinition(cwd, { operations: { readFile, writeFile, access } })),
    defineTool(createWriteToolDefinition(cwd, { operations: { writeFile, mkdir: async () => {} } })),
  ].map(tool => ({ ...tool, execute: (...args: Parameters<typeof tool.execute>) => signals.run(args[2], () => tool.execute(...args)) }));
}
