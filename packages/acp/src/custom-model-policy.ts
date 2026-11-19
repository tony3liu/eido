import type {ModelRuntime, AgentSession} from '@earendil-works/pi-coding-agent';
import {getSupportedThinkingLevels, type Model, type Api} from '@earendil-works/pi-ai';
import {getBuiltinModels, getBuiltinProviders} from '@earendil-works/pi-ai/providers/all';
import {validatedCustomProviders} from '../../runtime/src/pi/settings.mjs';
import {rememberErrorSecrets} from '../adapter/src/errors.js';

export type CustomImagePolicy = {
  allowsDefault(model: Pick<Model<Api>, 'provider'|'id'>): boolean;
  copyModel?(model: Model<Api>, changes?: Partial<Model<Api>>): Model<Api>;
};
// Read only capability fields from pi's public, bundled catalog. Never inherit
// a vendor destination, credential, price or cross-API compatibility flags.
export type CatalogThinking = Pick<Model<Api>, 'provider'|'api'|'reasoning'|'thinkingLevelMap'> & {forceAdaptiveThinking?:boolean};
export const builtinThinking = new Map<string,CatalogThinking[]>();
export const builtinCatalog: (CatalogThinking & {id:string;name:string})[] = [];
for (const provider of getBuiltinProviders()) for (const model of getBuiltinModels(provider)) {
  const entries = builtinThinking.get(model.id) ?? [];
  entries.push({provider:model.provider,api:model.api,reasoning:model.reasoning,thinkingLevelMap:model.thinkingLevelMap,
    forceAdaptiveThinking:(model.compat as {forceAdaptiveThinking?:boolean}|undefined)?.forceAdaptiveThinking});
  builtinThinking.set(model.id,entries);
  builtinCatalog.push({...entries.at(-1)!,id:model.id,name:model.name});
}
// Ask pi for its public domain, including future levels supported only by a map.
const recognizedLevels = getSupportedThinkingLevels({reasoning:true, thinkingLevelMap:new Proxy({}, {
  get: (_target, property) => typeof property === 'string' ? property : undefined,
})} as Model<Api>);
const standardEfforts = new Set<string>(['none', ...recognizedLevels]);
const genericTrialMap = Object.fromEntries(recognizedLevels.filter(level => level !== 'off').map(level => [level,level]));
const openaiApi = (api: string) => api === 'openai-completions' || api === 'openai-responses';
const googleApi = (api: string) => api === 'google-generative-ai' || api === 'google-vertex';
/** Resolve ambiguity before borrowing catalog metadata; never infer a vendor from an alias. */
export function resolveCatalogThinking(model: Pick<Model<Api>, 'id'|'provider'|'api'>, candidates: readonly CatalogThinking[] = builtinThinking.get(model.id) ?? []) {
  const sameProvider = candidates.filter(candidate => candidate.provider === model.provider);
  const portable = (candidate:CatalogThinking) =>
    !Object.values(candidate.thinkingLevelMap ?? {}).some(value=>value !== null && !standardEfforts.has(value)) &&
    (candidate.api === model.api || openaiApi(model.api) || (googleApi(model.api) && googleApi(candidate.api)));
  // A mirror that only declares reasoning:true has no level information. For
  // foreign providers, prefer safe explicit maps before comparing API proximity.
  // Exact provider identities retain priority, including their explicit defaults.
  const detailed = candidates.filter(candidate=>candidate.thinkingLevelMap !== undefined && portable(candidate));
  const borrowable = detailed.length ? detailed : candidates;
  const sameApi = borrowable.filter(candidate => candidate.api === model.api);
  const peerApi = borrowable.filter(candidate => openaiApi(model.api) && openaiApi(candidate.api));
  const exact = sameProvider.filter(candidate => candidate.api === model.api);
  const preferred = exact.length ? exact : sameProvider.length ? sameProvider : sameApi.length ? sameApi : peerApi.length ? peerApi : borrowable;
  const first = preferred[0];
  if (!first) return undefined;
  for (const candidate of preferred) {
    const exactConnection = candidate.provider === model.provider && candidate.api === model.api;
    // Vendor-specific budget strings or formats are not portable even between
    // two OpenAI-compatible providers unless the catalog connection is exact.
    if (!exactConnection && Object.values(candidate.thinkingLevelMap ?? {}).some(value => value !== null && !standardEfforts.has(value))) return undefined;
    if (candidate.api !== model.api && !openaiApi(model.api) && !(googleApi(model.api) && googleApi(candidate.api))) return undefined;
  }
  const signature = (candidate: CatalogThinking) => JSON.stringify([candidate.reasoning,
    Object.entries(candidate.thinkingLevelMap ?? {}).sort(([a],[b]) => a.localeCompare(b)),
    model.api === 'anthropic-messages' ? candidate.forceAdaptiveThinking ?? null : null]);
  return preferred.every(candidate => signature(candidate) === signature(first)) ? first : undefined;
}
const trialThinkingModels = new WeakSet<object>();
export function hasTrialThinking(model: object | undefined) { return !!model && trialThinkingModels.has(model); }
// Bundled One Code runs in a separate extension module graph. Mark the selected
// model so its context and wire hooks can leave protocol switching to pi.
const responsesCompatModel = Symbol.for('eido.pi.responses-compat');
const changedConnection = () => new Error('This connection changed. Reselect the model before sending to load its current address, API format and thinking capabilities.');
const bindings = new WeakMap<object, CustomImagePolicy>();
export function imageInputAllowed(session: object | undefined, model: Model<Api> | undefined) {
  return !!model && (model.input.includes('image') || !!(session && bindings.get(session)?.allowsDefault(model)));
}
export async function customImagePolicy(directory: string) {
  let providers = await validatedCustomProviders(directory);
  let lookupAlias: ((model:Model<Api>) => CatalogThinking|undefined)|undefined;
  const sources = new WeakMap<object, {provider:string; id:string; baseUrl:string; api:string; capabilities:string}>();
  const key = (model: {provider:string; id:string}) => providers.get(model.provider)?.models?.find(candidate => candidate.id === model.id);
  const capabilities = (model: {reasoning?:boolean; thinkingLevelMap?:unknown; compat?:{forceAdaptiveThinking?:boolean}}, provider?:{compat?:{forceAdaptiveThinking?:boolean}}) =>
    JSON.stringify([model.reasoning ?? null, model.thinkingLevelMap ?? null, model.compat?.forceAdaptiveThinking ?? provider?.compat?.forceAdaptiveThinking ?? null]);
  const project = (model: Model<Api>): Model<Api> => {
    if (sources.has(model)) return model;
    const configured = key(model);
    if (!configured) return model;
    const inferred = !builtinThinking.has(model.id) ? lookupAlias?.(model) : undefined;
    const builtin = resolveCatalogThinking(model) ?? inferred;
    const openaiCompatible = ['openai-completions','openai-responses'].includes(model.api);
    const nativeAnthropic = model.api === 'anthropic-messages' && builtin?.api === model.api;
    const gemini = /^(?:google\/)?gemini-/i.test(model.id);
    const nativeGoogle = ['google-generative-ai','google-vertex'].includes(model.api) && (builtin?.api === 'google-generative-ai' || gemini);
    const adapt = !!builtin || openaiCompatible || nativeAnthropic || nativeGoogle;
    const reasoning = adapt ? configured.reasoning ?? builtin?.reasoning ?? true : model.reasoning;
    // A declared map is a complete capability choice: missing extended levels
    // stay unavailable, and null/custom values are never filled or overwritten.
    const catalogMap = nativeAnthropic && (model.compat as {forceAdaptiveThinking?:boolean}|undefined)?.forceAdaptiveThinking === false
      ? undefined : builtin?.thinkingLevelMap;
    const thinkingLevelMap = adapt ? configured.thinkingLevelMap ?? model.thinkingLevelMap ?? catalogMap
      ?? (!builtin && gemini ? {off:null,minimal:null,low:'low',medium:'medium',high:'high',xhigh:null,max:null}
        : !builtin && openaiCompatible ? genericTrialMap : undefined) : model.thinkingLevelMap;
    const trial = reasoning && (inferred ? configured.thinkingLevelMap === undefined :
      (openaiCompatible || nativeGoogle) && !builtin && (configured.reasoning === undefined ||
        (configured.thinkingLevelMap === undefined && model.thinkingLevelMap === undefined)));
    const projected = {...model, reasoning, ...(thinkingLevelMap ? {thinkingLevelMap:{...thinkingLevelMap}} : {}),
      ...(model.api === 'openai-completions' ? {[responsesCompatModel]:true} : {}),
      // pi's native Anthropic encoder needs this public flag to send effort.
      // Only the exact same API can inherit it; existing explicit values win.
      ...(nativeAnthropic && builtin?.forceAdaptiveThinking === true ? {compat:{forceAdaptiveThinking:true,...model.compat}} : {})};
    sources.set(projected, {provider:model.provider,id:model.id,baseUrl:model.baseUrl,api:model.api,capabilities:capabilities(configured,providers.get(model.provider))});
    if (trial) trialThinkingModels.add(projected);
    return projected;
  };
  const copyModel = (model: Model<Api>, changes: Partial<Model<Api>> = {}) => {
    const copy = {...model, ...changes};
    const source = sources.get(model);
    // Source metadata is private and cannot be supplied through an API string.
    const configured = key(model);
    if (source) sources.set(copy, source);
    else if (configured) sources.set(copy, {provider:model.provider,id:model.id,baseUrl:model.baseUrl,api:model.api,capabilities:capabilities(configured,providers.get(model.provider))});
    return copy;
  };
  return {
    refresh: async () => { providers = await validatedCustomProviders(directory); },
    project,
    copyModel,
    setAliasLookup: (lookup:typeof lookupAlias) => { lookupAlias = lookup; },
    needsAlias: (model:Model<Api>) => {
      const configured = key(model);
      return !!configured && configured.reasoning !== false && configured.thinkingLevelMap === undefined && !builtinThinking.has(model.id);
    },
    isCompletions: (model: Model<Api>) => model.api === 'openai-completions' && !!key(model),
    allowsDefault: (model: Pick<Model<Api>, 'provider'|'id'>) => key(model)?.input === undefined && !!key(model),
    async assertCurrent(model: {provider:string; id:string; baseUrl:string; api:string; eidoSourceApi?:string}) {
      const source = sources.get(model);
      if (source && (model.provider !== source.provider || model.id !== source.id || model.baseUrl !== source.baseUrl ||
          (model.api !== source.api && !(source.api === 'openai-completions' && model.api === 'openai-responses')))) throw changedConnection();
      const current = (await validatedCustomProviders(directory)).get(model.provider);
      if (!current) { if (source) throw changedConnection(); return; }
      const configured = current.models?.find(candidate => candidate.id === model.id);
      const baseUrl = configured?.baseUrl ?? current.baseUrl;
      const api = configured?.api ?? current.api;
      const sourceApi = source?.api ?? (model.api === 'eido-openai-images' ? model.eidoSourceApi : model.api);
      if ((baseUrl !== undefined && baseUrl !== model.baseUrl) || (api !== undefined && api !== sourceApi) ||
          (source && (!configured || capabilities(configured,current) !== source.capabilities))) throw changedConnection();
    },
  };
}
/** Adapt only public catalog reads; pi retains selection, restore and clamping. */
export function installCustomModelCatalog(runtime: ModelRuntime, policy: Awaited<ReturnType<typeof customImagePolicy>>) {
  const original = {getModel:runtime.getModel, getModels:runtime.getModels, getAvailable:runtime.getAvailable, getAvailableSnapshot:runtime.getAvailableSnapshot};
  runtime.getModel = (...args) => {const model = original.getModel.apply(runtime,args); return model && policy.project(model);};
  runtime.getModels = (...args) => original.getModels.apply(runtime,args).map(policy.project);
  runtime.getAvailable = async (...args) => (await original.getAvailable.apply(runtime,args)).map(policy.project);
  runtime.getAvailableSnapshot = () => original.getAvailableSnapshot.call(runtime).map(policy.project);
  return () => { Object.assign(runtime, original); };
}

export function containsImages(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsImages);
  const item = value as Record<string, unknown>;
  if (item.type === 'image') return true;
  return ['content','messages','message','messagesToSummarize','turnPrefixMessages','entriesToSummarize'].some(key => containsImages(item[key]));
}
export function installCustomImagePolicy(session: AgentSession, policy: CustomImagePolicy) {
  bindings.set(session, policy);
  const prepare = session.agent.prepareRequest;
  session.agent.prepareRequest = async (request, signal) => {
    const previous = await prepare?.(request, signal);
    const effective = {...request, ...previous};
    const model = effective.model;
    const blocked = session.settingsManager.getBlockImages();
    if (!blocked && containsImages(effective.context.messages) && !imageInputAllowed(session, model)) {
      throw new Error('This model explicitly disables image input. Choose another model to send these images.');
    }
    try {
      const resolved = await session.modelRuntime.getAuth(model);
      rememberErrorSecrets(session, [resolved?.auth.apiKey, ...Object.values(resolved?.auth.headers ?? {})]);
    } catch { /* pi reports authentication failures through its normal request path. */ }
    // Only the request copy changes: selected model, history, auth and stream function stay pi-owned.
    return {...previous, ...(policy.allowsDefault(model) && !blocked ? {model:(policy.copyModel?.(model,{input:['text','image']}) ?? {...model,input:['text','image']})} : {})};
  };
  return () => {bindings.delete(session); rememberErrorSecrets(session, []);};
}
