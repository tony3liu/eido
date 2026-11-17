import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, readFile, rename, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {Type} from 'typebox';
import {defineTool, type AgentSession, type ModelRuntime} from '@earendil-works/pi-coding-agent';
import type {Api, AssistantImages, ImageContent, ImageModel, Model, ProviderImages, TextContent} from '@earendil-works/pi-ai';
import {resolveHttpProxyUrlForTarget} from '@earendil-works/pi-ai/utils/node-http-proxy';
import {validatedCustomProviders} from '../../runtime/src/pi/settings.mjs';
import {appendEidoEntry} from './session-persistence.ts';

export const IMAGE_API = 'eido-openai-images';
export const IMAGE_OPERATION = 'eido.image.operation.v1';
const SUPPORTED = new Set(['gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5', 'gpt-image-2.5-sunburst']);
const MAX_IMAGE = 20 * 1024 * 1024, MAX_JSON = 30 * 1024 * 1024;
const {ProxyAgent} = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'))('undici') as typeof import('undici');
type Content = (ImageContent | TextContent)[];
export type GeneratedImage = {content: Content; path: string; model: string};
type Operation = {id: string; status: 'pending'|'complete'|'failed'; fingerprint: string; userEntry?: string; path?: string; model: string; error?: string};
type SourceModel = Model<Api>;
type RequestModel = ImageModel<typeof IMAGE_API> & {eidoSourceApi: string; eidoSourceBaseUrl: string; eidoSourceConfigured: boolean};

export class ImageGenerationError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(`Image generation ${code}${status === undefined ? '' : ` (HTTP ${status})`}. No automatic retry was made.`);
    this.name = 'ImageGenerationError';
  }
}
const failure = (code: string, status?: number) => new ImageGenerationError(code, status);
const safeFailure = (error: unknown) => error instanceof ImageGenerationError ? error : failure('failed');
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');

async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) { await response.body?.cancel(); throw failure('response_too_large'); }
  if (!response.body) throw failure('invalid_response');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw failure('response_too_large');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

/** Check the file container before retaining bytes supplied by a remote provider. */
function imageType(bytes: Buffer): {mimeType: string; extension: string} {
  if (!bytes.length || bytes.length > MAX_IMAGE) throw failure('invalid_image');
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    let offset = 8, header = false, data = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
      if (length > bytes.length - offset - 12) break;
      if (!header) {
        if (type !== 'IHDR' || length !== 13 || !bytes.readUInt32BE(offset + 8) || !bytes.readUInt32BE(offset + 12)) break;
        header = true;
      }
      if (type === 'IDAT') data = true;
      offset += length + 12;
      if (type === 'IEND' && length === 0 && header && data && offset === bytes.length) return {mimeType:'image/png', extension:'png'};
    }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length-2] === 0xff && bytes[bytes.length-1] === 0xd9) {
    let offset = 2, dimensions = false;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda && dimensions) return {mimeType:'image/jpeg', extension:'jpg'};
      if (marker === undefined || marker === 0xd9) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)
          && length >= 8 && bytes.readUInt16BE(offset + 3) > 0 && bytes.readUInt16BE(offset + 5) > 0) dimensions = true;
      offset += length;
    }
  }
  if (bytes.length >= 20 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP'
      && bytes.readUInt32LE(4) === bytes.length - 8 && ['VP8 ','VP8L','VP8X'].includes(bytes.toString('ascii',12,16))
      && bytes.readUInt32LE(16) > 0 && bytes.readUInt32LE(16) <= bytes.length - 20) return {mimeType:'image/webp', extension:'webp'};
  throw failure('invalid_image');
}

function decodeBase64(value: string) {
  if (!value || value.length > Math.ceil(MAX_IMAGE / 3) * 4 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw failure('invalid_image');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw failure('invalid_image');
  return bytes;
}

export async function createImageGeneration(agentDir: string, runtime: ModelRuntime, options: {timeoutMs?: number} = {}) {
  const pending = new Map<string, {fingerprint:string; promise:Promise<GeneratedImage>}>();
  const configuredBindings = new WeakMap<object, boolean>();
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 300_000, 1), 300_000);
  const supports = (model: Pick<SourceModel,'id'|'provider'> | undefined): model is SourceModel => !!model && SUPPORTED.has(model.id);
  const candidates = () => runtime.getAvailableSnapshot().filter(model => supports(model) && !runtime.getRegisteredNativeProvider(model.provider));

  const assertCurrent = async (model: RequestModel) => {
    if (runtime.getRegisteredNativeProvider(model.provider)) throw failure('unsupported_provider');
    const providers = await validatedCustomProviders(agentDir), config = providers.get(model.provider);
    const current = runtime.getModel(model.provider, model.id);
    if (!current || !supports(current) || current.baseUrl !== model.eidoSourceBaseUrl || current.api !== model.eidoSourceApi) throw failure('connection_changed');
    if (config) {
      const configured = config.models?.find(candidate => candidate.id === model.id);
      const baseUrl = configured?.baseUrl ?? config.baseUrl, api = configured?.api ?? config.api;
      if ((baseUrl !== undefined && baseUrl !== model.eidoSourceBaseUrl) || (api !== undefined && api !== model.eidoSourceApi)
          || (config.models && !configured)) throw failure('connection_changed');
    } else if (model.eidoSourceConfigured) {
      throw failure('connection_changed');
    }
    if (model.baseUrl !== model.eidoSourceBaseUrl) throw failure('connection_changed');
  };

  const implementation: ProviderImages = {async generateImages(model, context, requestOptions = {}) {
    const result: AssistantImages = {api: IMAGE_API, provider:model.provider, model:model.id, output:[], stopReason:'error', timestamp:Date.now()};
    const timer = AbortSignal.timeout(timeoutMs), signal = requestOptions.signal ? AbortSignal.any([requestOptions.signal, timer]) : timer;
    const dispatchers: InstanceType<typeof ProxyAgent>[] = [];
    const request = async (url: URL, init: RequestInit) => {
      const proxy = resolveHttpProxyUrlForTarget(url, requestOptions.env);
      const dispatcher = proxy ? new ProxyAgent(proxy.href) : undefined;
      if (dispatcher) dispatchers.push(dispatcher);
      return (requestOptions.fetch ?? globalThis.fetch)(url, {...init, signal, redirect:'error', credentials:'omit', ...(dispatcher ? {dispatcher} : {})});
    };
    try {
      signal.throwIfAborted();
      await assertCurrent(model as RequestModel);
      if (context.input.length !== 1 || context.input[0]?.type !== 'text') throw failure('unsupported_input');
      const endpoint = new URL(`${model.baseUrl.replace(/\/+$/, '')}/images/generations`);
      if (!['http:','https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw failure('invalid_connection');
      const headers = new Headers({'content-type':'application/json'});
      if (requestOptions.apiKey) headers.set('authorization', `Bearer ${requestOptions.apiKey}`);
      for (const [key,value] of Object.entries(requestOptions.headers ?? {})) {
        if (value === null) headers.delete(key); else headers.set(key,value);
      }
      // Auth was resolved by ModelRuntime before this callback; re-read the saved binding
      // immediately before fetch so an edited connection cannot receive fresh credentials.
      await assertCurrent(model as RequestModel);
      signal.throwIfAborted();
      const response = await request(endpoint, {method:'POST', headers, body:JSON.stringify({model:model.id,prompt:context.input[0].text,n:1})});
      if (!response.ok) {
        await response.body?.cancel();
        throw failure(response.status === 401 || response.status === 403 ? 'authentication_failed' : response.status === 429 ? 'rate_limited' : 'provider_rejected', response.status);
      }
      let body: unknown;
      try { body = JSON.parse((await boundedBody(response, MAX_JSON)).toString('utf8')); }
      catch (error) { if (error instanceof ImageGenerationError) throw error; throw failure('invalid_response'); }
      const data = (body as {data?: {b64_json?: unknown;url?: unknown}[]})?.data;
      if (!Array.isArray(data) || data.length !== 1 || !data[0]) throw failure('invalid_response');
      let bytes: Buffer;
      if (typeof data[0].b64_json === 'string') bytes = decodeBase64(data[0].b64_json);
      else if (typeof data[0].url === 'string') {
        const url = new URL(data[0].url);
        if (url.protocol !== 'https:' || url.username || url.password) throw failure('invalid_image_url');
        // Deliberately omit all provider headers and credentials on the image download.
        const download = await request(url, {method:'GET'});
        if (!download.ok) { await download.body?.cancel(); throw failure('download_failed', download.status); }
        bytes = await boundedBody(download, MAX_IMAGE);
      } else throw failure('invalid_response');
      const {mimeType} = imageType(bytes);
      result.output = [{type:'image',data:bytes.toString('base64'),mimeType}];
      result.stopReason = 'stop';
      return result;
    } catch (error) {
      result.stopReason = requestOptions.signal?.aborted ? 'aborted' : 'error';
      result.errorMessage = (requestOptions.signal?.aborted ? failure('cancelled') : timer.aborted ? failure('timed_out') : safeFailure(error)).message;
      return result;
    } finally { await Promise.all(dispatchers.map(dispatcher => dispatcher.close().catch(() => undefined))); }
  }};

  const refresh = async () => {
    const configured = await validatedCustomProviders(agentDir);
    for (const model of runtime.getModels().filter(supports)) {
      if (!configuredBindings.has(model)) configuredBindings.set(model, configured.has(model.provider));
    }
    for (const provider of new Set(runtime.getModels().filter(supports).map(model => model.provider))) {
      // registerProvider replaces a native extension provider. Leave its ownership intact.
      if (runtime.getRegisteredNativeProvider(provider)) continue;
      const previous = runtime.getRegisteredProviderConfig(provider);
      if (previous?.images?.[IMAGE_API] !== implementation) runtime.registerProvider(provider, {images:{...previous?.images,[IMAGE_API]:implementation}});
    }
  };
  await refresh();

  const readResult = async (record: Operation): Promise<GeneratedImage> => {
    if (record.status !== 'complete' || !record.path) throw new ImageGenerationError(record.status === 'pending' ? 'interrupted_or_unknown' : 'previously_failed');
    if ((await stat(record.path)).size > MAX_IMAGE) throw failure('invalid_image');
    const bytes = await readFile(record.path), {mimeType} = imageType(bytes);
    return {path:record.path,model:record.model,content:[{type:'image',data:bytes.toString('base64'),mimeType},
      {type:'text',text:`Saved image: [${record.path}](${pathToFileURL(record.path).href})`}]};
  };

  const retainOperation = async (session: AgentSession, record: Operation) => {
    appendEidoEntry(session.sessionManager,IMAGE_OPERATION,record);
    const path = session.sessionManager.getSessionFile();
    if (path && session.sessionManager.isPersisted()) {
      const file = await open(path,'r');
      try { await file.sync(); } finally { await file.close(); }
    }
  };

  const generate = (session: AgentSession, source: SourceModel, prompt: string, signal: AbortSignal | undefined, operationId: string, userEntry?: string): Promise<GeneratedImage> => {
    const key = `${session.sessionId}/${operationId}`, digest = fingerprint(`${source.provider}/${source.id}\0${prompt}`);
    const active = pending.get(key);
    if (active) return active.fingerprint === digest ? active.promise : Promise.reject(failure('operation_conflict'));
    const run = (async () => {
      if (!supports(source) || !prompt.trim() || prompt.length > 32_000) throw failure('unsupported_input');
      if (signal?.aborted) throw failure('cancelled');
      const records = session.sessionManager.getEntries().filter(entry => entry.type === 'custom' && entry.customType === IMAGE_OPERATION)
        .map(entry => (entry as {data:Operation}).data);
      const existing = records.findLast(record => record.id === operationId);
      if (existing) {
        if (existing.fingerprint !== digest) throw failure('operation_conflict');
        return readResult(existing);
      }
      // A model cannot turn one failed user request into another billable attempt
      // with a newly invented tool-call id. A new user message grants a new attempt.
      if (userEntry) {
        const latest = new Map(records.filter(record => record.userEntry === userEntry).map(record => [record.id,record]));
        if ([...latest.values()].some(record => record.status !== 'complete')) throw failure('requires_new_user_request');
      }
      const model: RequestModel = {id:source.id,name:source.name,provider:source.provider,baseUrl:source.baseUrl,headers:source.headers,
        input:['text'],output:['image'],cost:source.cost,type:'image',api:IMAGE_API,eidoSourceApi:source.api,eidoSourceBaseUrl:source.baseUrl,eidoSourceConfigured:configuredBindings.get(source) ?? (await validatedCustomProviders(agentDir)).has(source.provider)};
      await assertCurrent(model);
      const record: Operation = {id:operationId,status:'pending',fingerprint:digest,userEntry,model:`${source.provider}/${source.id}`};
      await retainOperation(session,record);
      try {
        const result = await runtime.generateImages(model,{input:[{type:'text',text:prompt}]},{signal,maxRetries:0,timeoutMs});
        if (result.stopReason !== 'stop') {
          const known = /^Image generation ([a-z_]+)(?: \(HTTP (\d+)\))?\. No automatic retry was made\.$/.exec(result.errorMessage ?? '');
          throw result.stopReason === 'aborted' ? failure('cancelled') : known ? failure(known[1]!,known[2] ? Number(known[2]) : undefined) : failure('authentication_or_provider_failed');
        }
        const image = result.output.find((item): item is ImageContent => item.type === 'image');
        if (!image) throw failure('invalid_response');
        const bytes = decodeBase64(image.data), {extension,mimeType} = imageType(bytes);
        const directory = join(agentDir,'generated-images',encodeURIComponent(session.sessionId).replace(/^\.\.?$/,value => value.split('').map(() => '%2E').join('')));
        await mkdir(directory,{recursive:true,mode:0o700});
        const path = join(directory,`${fingerprint(operationId)}.${extension}`), temporary = `${path}.${randomUUID()}.tmp`;
        try {
          const file = await open(temporary,'wx',0o600);
          try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
          await rename(temporary,path);
        } finally { await rm(temporary,{force:true}); }
        await retainOperation(session,{...record,status:'complete',path});
        return {path,model:record.model,content:[{type:'image' as const,data:bytes.toString('base64'),mimeType},
          {type:'text' as const,text:`Saved image: [${path}](${pathToFileURL(path).href})`}]};
      } catch (error) {
        const safe = signal?.aborted ? failure('cancelled') : safeFailure(error);
        await retainOperation(session,{...record,status:'failed',error:safe.message});
        throw safe;
      }
    })();
    pending.set(key,{fingerprint:digest,promise:run});
    void run.finally(() => {if (pending.get(key)?.promise === run) pending.delete(key);}).catch(() => undefined);
    return run;
  };

  return {refresh,supports,candidates,
    async runDirect(session: AgentSession, input: {text:string;images?:unknown[];signal?:AbortSignal;operationId:string}) {
      if (!supports(session.model)) return undefined;
      if (input.images?.length) throw failure('image_editing_not_supported');
      return generate(session,session.model,input.text,input.signal,input.operationId);
    },
    tool(session: () => AgentSession | undefined, _sessionId: string) {
      return defineTool({name:'generate_image',label:'Generate image',
        description:'Generate and save one image with a configured image model, then continue the current conversation. model is provider/model-id. Omit it only when exactly one configured image model is available. Never retry a failed or interrupted generation without a new explicit user request.',
        promptSnippet:'Generate an image using an existing configured image model and return its image and local file.',
        parameters:Type.Object({prompt:Type.String({minLength:1,maxLength:32_000}),model:Type.Optional(Type.String())}),
        executionMode:'sequential',
        prepareLoadout:() => ({descriptions:{generate_image:`Generate and save one image. Available configured image models: ${candidates().map(model=>`${model.provider}/${model.id}`).join(', ') || '(none)'}. Pass prompt and model; omit model only with exactly one candidate. Never retry a failed call without a new user request.`}}),
        async execute(id,args,signal) {
          const current = session();
          if (!current) throw failure('session_unavailable');
          const available = candidates(), model = args.model ? available.find(model=>`${model.provider}/${model.id}` === args.model) : available.length === 1 ? available[0] : undefined;
          if (!model) throw new Error(`Choose a configured image model: ${available.map(model=>`${model.provider}/${model.id}`).join(', ') || 'none available'}.`);
          const userEntry = current.sessionManager.getEntries().findLast(entry=>entry.type === 'message' && entry.message.role === 'user')?.id;
          const result = await generate(current,model,args.prompt,signal,`tool:${id}`,userEntry);
          return {content:result.content,details:{path:result.path,model:result.model}};
        },
      });
    },
  };
}
