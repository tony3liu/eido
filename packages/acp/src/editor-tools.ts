import {createHash} from 'node:crypto';
import type {ResearchHooks,ResearchProvenance} from './research-requirements.ts';
import { AsyncLocalStorage } from "node:async_hooks";
import { stat } from "node:fs/promises";
import { workspacePath } from "./workspace-path.ts";
import { methods, type AgentContext } from "@agentclientprotocol/sdk";
import {
  createReadToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  defineTool,
  detectSupportedImageMimeTypeFromFile,
} from "@earendil-works/pi-coding-agent";

export function editorTools(cwd: string, sessionId: string, client: Pick<AgentContext, "request">,
  outputImage: (path:string)=>{data:string;mimeType:string}|undefined = ()=>undefined, research?:ResearchHooks) {
  const readPaths = new Set<string>();
  const edits=new AsyncLocalStorage<{path:string;contentHash:string}[]>();
  const provenance = new AsyncLocalStorage<ResearchProvenance | undefined>();
  const signals = new AsyncLocalStorage<AbortSignal | undefined>();
  const checkPath = (path: string) => workspacePath(cwd, path, true);
  const imagePaths = new Set<string>();
  const detectImageMimeType = async (path: string) => {
    const output = outputImage(path); if (output) return output.mimeType;
    const canonical = await checkPath(path);
    // The public pi detector only sniffs the header. Read actual image contents
    // through the native snapshot endpoint, with its exclusions and size bound.
    const mime = await detectSupportedImageMimeTypeFromFile(canonical).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null; // new unsaved editor file
      throw error;
    });
    if (mime) imagePaths.add(canonical); else imagePaths.delete(canonical);
    return mime;
  };
  const readFile = async (path: string) => {
    const output = outputImage(path); if (output) return Buffer.from(output.data, 'base64');
    const canonical = await checkPath(path);
    if (imagePaths.has(canonical)) {
      const response = await client.request<{content:string}>('_eido/fs/snapshot', {sessionId, path:canonical}, {cancellationSignal:signals.getStore()});
      const content = Buffer.from(response.content, 'base64');
      if (content.toString('base64') !== response.content) throw new Error('Invalid native image snapshot.');
      return content;
    }
    const response = await client.request(methods.client.fs.readTextFile, { sessionId, path: canonical }, { cancellationSignal: signals.getStore() });
    readPaths.add(canonical);
    return Buffer.from(response.content, "utf8");
  };
  const writeFile = async (path: string, content: string) => {
    const canonical = await checkPath(path);
    const exists = await stat(canonical).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return false;
    });
    if (exists && !readPaths.has(canonical)) throw new Error("Read the file in this session before replacing its contents.");
    await client.request(methods.client.fs.writeTextFile, { sessionId, path: canonical, content,
      _meta: {...(!exists ? {"eido.dev/createFile": true} : {}), ...(provenance.getStore()?{"eido.dev/research":provenance.getStore()}: {})},
    }, { cancellationSignal: signals.getStore() });
    const contentHash=createHash("sha256").update(content).digest("hex");edits.getStore()?.push({path:canonical,contentHash});
    await research?.edit(provenance.getStore(),canonical,contentHash);
    readPaths.add(canonical);
  };
  const access = async (path: string) => { if (!outputImage(path)) await checkPath(path); };
  return [
    defineTool(createReadToolDefinition(cwd, { operations: { readFile, access, detectImageMimeType } })),
    defineTool(createEditToolDefinition(cwd, { operations: { readFile, writeFile, access } })),
    defineTool(createWriteToolDefinition(cwd, { operations: { writeFile, mkdir: async () => {} } })),
  ].map(tool => ({ ...tool, execute: async (...args: Parameters<typeof tool.execute>) => {const scope=tool.name==='read'?undefined:await research?.capture(args[0]);return edits.run([],()=>provenance.run(scope,()=>signals.run(args[2], async () => {const result=await tool.execute(...args);return {...result,details:{...result.details as Record<string,unknown>,eidoResearchEdit:{...(scope??{version:1,requirements:[],status:'Unlinked'}),files:edits.getStore()}}};})));} }));
}
