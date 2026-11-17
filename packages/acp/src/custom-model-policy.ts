import type {AgentSession} from '@earendil-works/pi-coding-agent';
import type {Model, Api} from '@earendil-works/pi-ai';
import {validatedCustomProviders} from '../../runtime/src/pi/settings.mjs';
import {rememberErrorSecrets} from '../adapter/src/errors.js';

export type CustomImagePolicy = {allowsDefault(model: Pick<Model<Api>, 'provider'|'id'>): boolean};
const bindings = new WeakMap<object, CustomImagePolicy>();
export function imageInputAllowed(session: object | undefined, model: Model<Api> | undefined) {
  return !!model && (model.input.includes('image') || !!(session && bindings.get(session)?.allowsDefault(model)));
}
export async function customImagePolicy(directory: string) {
  let defaults = new Set<string>();
  const refresh = async () => {
    const providers = await validatedCustomProviders(directory);
    const next = new Set<string>();
    for (const [provider, config] of providers) for (const model of config.models ?? []) {
      if (model.input === undefined) next.add(`${provider}/${model.id}`);
    }
    defaults = next; // Keep the last validated snapshot if a later read fails.
  };
  await refresh();
  return {refresh, allowsDefault:(model: Pick<Model<Api>, 'provider'|'id'>) => defaults.has(`${model.provider}/${model.id}`),
    async assertCurrent(model: {provider:string; id:string; baseUrl:string; api:string; eidoSourceApi?:string}) {
      // The selected object can outlive a connection edit while pi resolves fresh
      // credentials per request. Read the saved destination before every request,
      // including plain text, rather than relying on the asynchronous catalog watcher.
      const provider = (await validatedCustomProviders(directory)).get(model.provider);
      if (!provider) return;
      const configured = provider.models?.find(candidate => candidate.id === model.id);
      const baseUrl = configured?.baseUrl ?? provider.baseUrl;
      const api = configured?.api ?? provider.api;
      if ((baseUrl !== undefined && baseUrl !== model.baseUrl) || (api !== undefined && api !== (model.api === 'eido-openai-images' ? model.eidoSourceApi : model.api))) {
        throw new Error('This connection changed. Reselect the model before sending to load its current address and API format.');
      }
    },
  };
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
    return {...previous, ...(policy.allowsDefault(model) && !blocked ? {model:{...model,input:['text','image']}} : {})};
  };
  return () => {bindings.delete(session); rememberErrorSecrets(session, []);};
}
