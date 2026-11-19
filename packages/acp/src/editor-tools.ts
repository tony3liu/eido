import {createHash} from 'node:crypto';
import type {ResearchHooks,ResearchProvenance} from './research-requirements.ts';
import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { oneCodeDescriptor } from "../../runtime/src/pi/bundled-one-code.mjs";
import { buildArtifactPath, readToolText, workspacePath } from "./workspace-path.ts";
import { methods, type AgentContext } from "@agentclientprotocol/sdk";
import {
  createReadToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  defineTool,
  detectSupportedImageMimeTypeFromFile,
  type Skill,
} from "@earendil-works/pi-coding-agent";

type ResourcePath = (path: string, operation: "read" | "ls") => Promise<string | undefined>;
const noResource: ResourcePath = async () => undefined;
const within = (root: string, path: string) => {
  const local = relative(root, path);
  return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
};
const documentPath = (path: string) => [".md", ".markdown", ".mdx", ".txt", ".rst", ".adoc"].includes(extname(path).toLowerCase());
const tryRealpath = (path: string) => realpath(path).catch(() => undefined);

export function sessionFileResources(cwd: string, sessionId: string, agentDir: string, skills: () => readonly Skill[]): ResourcePath {
  const bundled = oneCodeDescriptor();
  const temp = process.platform === "win32" ? tmpdir() : "/tmp";
  const uid = process.getuid?.();
  let roots: Promise<{workspace: string; agent: string; temp: string}> | undefined;
  let scratchpad: Promise<string | undefined> | undefined;
  const scratchpadPath = async () => {
    if (!bundled.installed || !/^[a-z0-9-]+$/i.test(sessionId)) return;
    // The model prompt uses this same helper from the bundled extension.
    const url = pathToFileURL(join(bundled.path, "extensions/lib/core/scratchpad.ts"));
    const {sessionScratchpadDir} = await import(url.href) as {
      sessionScratchpadDir(cwd: string, id: string): string;
    };
    return sessionScratchpadDir(cwd, sessionId);
  };
  return async (input, operation) => {
    const path = resolve(cwd, input.startsWith("~/") ? join(homedir(), input.slice(2)) : input);
    const resolved = await (roots ??= (async () => ({
      workspace: await realpath(cwd), agent: await tryRealpath(agentDir) ?? resolve(agentDir),
      temp: await tryRealpath(temp) ?? temp,
    }))());
    const canonical = await tryRealpath(path);
    if (!canonical) return;
    const owner = join(resolved.temp, uid === undefined ? "eido" : `eido-${uid}`);
    const normalizeTemp = (path: string) => within(temp, path) ? resolve(resolved.temp, relative(temp, path)) : path;
    const target = normalizeTemp(path);
    if (within(owner, target) || within(owner, canonical)) {
      const root = await (scratchpad ??= scratchpadPath());
      if (!root || !within(root, target) || target !== canonical) throw new Error("File is outside this session's scratchpad.");
      // The temp owner and every directory leading to this session must be private,
      // and no component may be a symlink. Never fall through to document reads here.
      let current = resolved.temp;
      const parts = relative(resolved.temp, target).split(sep);
      for (const [i, part] of parts.entries()) {
        current = join(current, part);
        const info = await lstat(current);
        const directory = i < parts.length - 1 || operation === "ls";
        if ((directory ? !info.isDirectory() : !info.isFile())
          || (uid !== undefined && (info.uid !== uid || (directory && (info.mode & 0o022) !== 0)
            || (i < 4 && (info.mode & 0o077) !== 0)))) {
          throw new Error("Unsafe session scratchpad path.");
        }
      }
      return target;
    }

    // Keep the existing exact grant for a globally configured skill in private
    // workspace storage. Ordinary workspace files still use native buffers.
    const registered = operation === "read" && skills().some(skill =>
      skill.sourceInfo.scope === "user" && !skill.disableModelInvocation && resolve(skill.filePath) === path);
    const protectedPath = (path: string) => {
      const parts = path.toLowerCase().split(sep);
      return parts.includes(".git") || parts.some(part => part.startsWith(".eido-review-"))
        || (within(resolved.agent, path) && !within(join(resolved.agent, "skills"), path));
    };
    const privateWorkspace = (root: string, path: string) => within(root, path)
      && relative(root, path).split(sep).some(part => [".local", ".pi"].includes(part.toLowerCase()));
    if (protectedPath(path) || protectedPath(canonical)) return;
    if (privateWorkspace(resolve(cwd), path) || privateWorkspace(resolved.workspace, canonical)) {
      return registered && documentPath(canonical) ? canonical : undefined;
    }
    if (within(resolved.workspace, canonical)) return;
    if (operation === "read") {
      return documentPath(path) && documentPath(canonical) ? canonical : undefined;
    }
    // A direct request to browse a skill may use an unregistered local Skill,
    // but does not grant directory listings of unrelated places outside the project.
    for (let directory = canonical; directory !== dirname(directory); directory = dirname(directory)) {
      if (protectedPath(directory)) break;
      const marker = await lstat(join(directory, "SKILL.md")).catch(() => undefined);
      if (marker?.isFile() && marker.nlink === 1) return canonical;
    }
  };
}

export function editorTools(cwd: string, sessionId: string, client: Pick<AgentContext, "request">,
  outputImage: (path:string)=>{data:string;mimeType:string}|undefined = ()=>undefined, research?:ResearchHooks,
  resourcePath: ResourcePath = noResource) {
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
    description: `${read.description} Also reads Markdown and common plain text documents at explicit paths, and text in this session's scratchpad. Other read-only exceptions include approved .local build logs and metadata, and Rust sources and Cargo manifests under .local/upstream/zed/crates. If a text offset is past EOF, returns a bounded tail and reports the adjusted range.`,
    async execute(id, params, signal, onUpdate, ctx) {
      // Keep recovery on the same native buffer snapshot, including unsaved
      // edits. Per-call state also prevents concurrent reads sharing snapshots.
      let snapshot: Buffer | undefined;
      let mime: string | null | undefined;
      let readOnlyPath: Promise<string | undefined> | undefined;
      const readOnly = (path: string) => readOnlyPath ??= (async () =>
        await buildArtifactPath(cwd, path, "read") ?? await resourcePath(path, "read"))();
      const attempt = createReadToolDefinition(cwd, { operations: {
        access: async path => { if (!await readOnly(path)) await access(path); },
        readFile: async path => {
          const allowed = await readOnly(path);
          return snapshot ??= allowed ? await readToolText(allowed, signal) : await readFile(path);
        },
        detectImageMimeType: async path => mime === undefined
          ? (mime = await readOnly(path) ? null : (await detectImageMimeType(path)) ?? null) : mime,
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
