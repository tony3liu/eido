import {join} from 'node:path';
import {ModelRuntime,SettingsManager} from '../../../acp/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import {applyHttpProxySettings,configureHttpDispatcher} from '../../../acp/node_modules/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js';
import {normalizeHttpProxy} from '../pi/http-settings.mjs';
import {browserTextSettings} from './config.mjs';
import {clampThinkingLevel} from '../../../acp/node_modules/@earendil-works/pi-ai/dist/index.js';

// The shared helper uses pi's public provider API, including custom endpoints,
// OAuth and API-key resolution. It never copies the main key into browser env.
export async function createBrowserTextModel(directory,{runtime}={}) {
  const config=await browserTextSettings(directory,runtime);
  if(config.source==='custom')return {source:'custom',apiUrl:process.env.TEXT_MODEL_BASE_URL??config.apiUrl,
    model:process.env.TEXT_MODEL??config.model,key:process.env.TEXT_MODEL_API_KEY??'',reasoning:config.reasoning};
  let models=runtime;
  return {source:'pi',model:config.model,generate:async(context,instructions,signal)=>{
    signal?.throwIfAborted();
    const settings=SettingsManager.create(directory,directory,{projectTrusted:false});
    if(settings.drainErrors().length)throw new Error('Unable to read the main model settings; nothing typed.');
    if(!models) {
      const proxy=settings.getGlobalSettings().httpProxy;
      if(proxy)applyHttpProxySettings(normalizeHttpProxy(proxy));
      configureHttpDispatcher(settings.getHttpIdleTimeoutMs());
      models=await ModelRuntime.create({authPath:join(directory,'auth.json'),modelsPath:join(directory,'models.json'),
        modelsStorePath:join(directory,'models-store.json'),allowModelNetwork:false,signal});
    }
    const provider=settings.getDefaultProvider(),id=settings.getDefaultModel();
    const model=provider&&id?models.getModel(provider,id):undefined;
    if(!model)throw new Error('Choose a main language model in global settings; nothing typed.');
    const bounded=AbortSignal.any([AbortSignal.timeout(25_000),...(signal?[signal]:[])]);
    try {
      const thinkingLevel=config.reasoning==='none'?'off':'low';
      const route=models.getPhysicalModel(model.provider,model.id)
        ? {model,thinkingLevel:clampThinkingLevel(model,thinkingLevel)}
        : await models.resolveModel(model,[],{reason:'direct',thinkingLevel,signal:bounded});
      const result=await models.completeSimple(route.model,{systemPrompt:instructions,
        messages:[{role:'user',content:context,timestamp:Date.now()}]},
        {signal:bounded,maxTokens:1024,reasoning:route.thinkingLevel==='off'?undefined:route.thinkingLevel});
      bounded.throwIfAborted();
      if(result.stopReason==='error'||result.stopReason==='aborted')throw new Error('provider failed');
      return {content:result.content.filter(b=>b.type==='text').map(b=>b.text).join(''),model:result.model,usage:result.usage};
    }catch {
      signal?.throwIfAborted();
      throw new Error('The main language model could not generate browser input text. Check its global model and authentication settings; nothing typed.');
    }
  }};
}
