import type {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {createAssistantMessageEventStream, type Model, type Api, type AuthResult, type AssistantMessage, type AssistantMessageEvent} from '@earendil-works/pi-ai';
import type {customImagePolicy} from './custom-model-policy.ts';
import {requiresResponses, responsesFailure} from '../adapter/src/errors.js';

type Policy = Awaited<ReturnType<typeof customImagePolicy>>;
type AuthScope = {snapshot?: string};
const connectionChanged = 'This connection changed. Reselect the model before retrying.';
const diagnosticText = (message: AssistantMessage) => [message.errorMessage, ...message.diagnostics?.map(item => item.error?.message) ?? []].filter(Boolean).join('\n');
function failure(model: Model<Api>, error: unknown, aborted: boolean): AssistantMessage {
  return {role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],stopReason:aborted?'aborted':'error',
    errorMessage:error instanceof Error ? error.message : String(error),timestamp:Date.now(),
    usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
}
/** A runtime-local protocol choice. pi still owns auth, encoding, tools and the Agent stream function. */
export function installResponsesCompat(runtime: ModelRuntime, policy: Policy) {
  const original = runtime.streamSimple;
  const originalRefresh = runtime.refresh;
  const cached = new Set<string>();
  const scopes = new WeakMap<object, AuthScope>();
  let generation = 0;
  const wrapped: ModelRuntime['streamSimple'] = (model, context, options) => {
    if (!policy.isCompletions(model)) return original.call(runtime,model,context,options);
    const key = JSON.stringify([model.provider,model.id,model.baseUrl,model.api]);
    const revision = generation;
    const output = createAssistantMessageEventStream();
    const scope: AuthScope = {};
    let responses = cached.has(key);
    const attempt = async (retry: boolean): Promise<AssistantMessage | undefined> => {
      const request = policy.copyModel(model, retry ? {api:'openai-responses'} : {});
      scopes.set(request,scope);
      let pending: AssistantMessageEvent | undefined;
      let content = false;
      let terminal = false;
      const flush = () => { if(pending) {output.push(pending);pending=undefined;} };
      try {
        for await (const event of original.call(runtime,request,context,options)) {
          if (event.type === 'start' && !content && event.partial.content.length === 0) { pending = event; continue; }
          if (event.type !== 'start' && event.type !== 'error' && event.type !== 'done') content = true;
          if (event.type === 'start' && event.partial.content.length > 0) content = true;
          if (event.type === 'error') {
            terminal = true;
            cached.delete(key);
            if (!retry && !content && !event.error.content.length && event.reason === 'error' && !options?.signal?.aborted && requiresResponses(diagnosticText(event.error))) return event.error;
            flush();
            output.push(retry ? {...event,error:{...event.error,errorMessage:responsesFailure(diagnosticText(event.error),event.reason === 'aborted'),diagnostics:undefined}} : event);
            return;
          }
          if (event.type === 'done') {
            terminal = true;
            if (retry && revision === generation && !options?.signal?.aborted && ['stop','toolUse'].includes(event.reason)) cached.add(key);
          }
          flush();
          output.push(event);
          if (terminal) return;
        }
        throw new Error('Provider stream ended without a terminal result.');
      } finally {
        scopes.delete(request);
      }
    };
    void (async () => {
      try {
        const rejected = await attempt(responses);
        if (rejected) {
          // An abort between streams never starts a second network request.
          if (options?.signal?.aborted) {
            output.push({type:'error',reason:'aborted',error:{...rejected,stopReason:'aborted',errorMessage:'Request cancelled.'}});
          } else { responses = true; await attempt(true); }
        }
      } catch (error) {
        cached.delete(key);
        const message = failure(model,error,!!options?.signal?.aborted);
        if (responses) message.errorMessage = responsesFailure(message.errorMessage,!!options?.signal?.aborted);
        output.push({type:'error',reason:options?.signal?.aborted?'aborted':'error',error:message});
      } finally { output.end(); }
    })();
    return output;
  };
  runtime.streamSimple = wrapped;
  const refresh: ModelRuntime["refresh"] = async (...args) => { generation++;cached.clear();await policy.refresh();return originalRefresh.apply(runtime,args); };
  runtime.refresh = refresh;
  return {
    recordAuth(model: object, resolution: AuthResult | undefined) {
      const scope = scopes.get(model);
      if (!scope) return;
      // Compare copies, never retain or log credential objects. Subsequent user
      // requests get a new scope and can use normally rotated credentials.
      const auth = resolution?.auth;
      const headers = Object.entries(auth?.headers ?? {}).map(([name,value]) => [name.toLowerCase(),value]).sort(([a],[b]) => a!.localeCompare(b!));
      const snapshot = JSON.stringify([auth?.baseUrl ?? null,auth?.apiKey ?? null,headers]);
      if (scope.snapshot !== undefined && scope.snapshot !== snapshot) throw new Error(connectionChanged);
      scope.snapshot = snapshot;
    },
    clear() {generation++;cached.clear();},
    dispose() {generation++;cached.clear();if(runtime.streamSimple === wrapped)runtime.streamSimple=original;if(runtime.refresh === refresh)runtime.refresh=originalRefresh;},
  };
}
