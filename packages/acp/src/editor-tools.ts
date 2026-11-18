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
  const read = createReadToolDefinition(cwd, { operations: { readFile, access, detectImageMimeType } });
  const recoveringRead: typeof read = {
    ...read,
    description: `${read.description} If a text offset is past EOF, the read automatically returns a bounded tail of the current file and reports the adjusted range.`,
    async execute(id, params, signal, onUpdate, ctx) {
      // Keep recovery on the same native buffer snapshot, including unsaved
      // edits. Per-call state also prevents concurrent reads sharing snapshots.
      let snapshot: Buffer | undefined;
      let mime: string | null | undefined;
      const attempt = createReadToolDefinition(cwd, { operations: {
        access,
        readFile: async path => snapshot ??= await readFile(path),
        detectImageMimeType: async path => mime === undefined ? (mime = (await detectImageMimeType(path)) ?? null) : mime,
      } });
      try {
        return await attempt.execute(id, params, signal, onUpdate, ctx);
      } catch (error) {
        const { offset, limit } = params;
        if (signal?.aborted || mime || !snapshot || !Number.isSafeInteger(offset)
          || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))) throw error;
        // Match pi's line convention: an empty buffer is one line and a final
        // newline starts an empty last line. Do not reinterpret native errors.
        const totalLines = snapshot.toString('utf8').split('\n').length;
        if (offset === undefined || offset <= totalLines || !(error instanceof Error)
          || error.message !== `Offset ${offset} is beyond end of file (${totalLines} lines total)`) throw error;
        const adjustedLimit = Math.min(limit ?? 200, 200, totalLines);
        const adjustedOffset = totalLines - adjustedLimit + 1;
        // Exactly one retry; pi still handles image behavior, byte limits and
        // cancellation through its public tool definition, without a patch.
        const result = await attempt.execute(id, { ...params, offset: adjustedOffset, limit: adjustedLimit }, signal, onUpdate, ctx);
        const note = `[Read range adjusted: requested offset ${offset} is past EOF (${totalLines} lines total). Reading from offset=${adjustedOffset} with limit=${adjustedLimit}.${snapshot.length === 0 ? ' The file is empty.' : ''} Use the current line numbers; do not repeat the out-of-range offset.]`;
        const content = result.content.map(item => item.type === 'text' ? { ...item, text: `${note}\n\n${item.text}` } : item);
        return { ...result, content, structuredContent: content.find(item => item.type === 'text')?.text };
      }
    },
  };
  return [
    defineTool(recoveringRead),
    defineTool(createEditToolDefinition(cwd, { operations: { readFile, writeFile, access } })),
    defineTool(createWriteToolDefinition(cwd, { operations: { writeFile, mkdir: async () => {} } })),
  ].map(tool => ({ ...tool, execute: async (...args: Parameters<typeof tool.execute>) => {const scope=tool.name==='read'?undefined:await research?.capture(args[0]);return edits.run([],()=>provenance.run(scope,()=>signals.run(args[2], async () => {const result=await tool.execute(...args);return {...result,details:{...result.details as Record<string,unknown>,eidoResearchEdit:{...(scope??{version:1,requirements:[],status:'Unlinked'}),files:edits.getStore()}}};})));} }));
}
