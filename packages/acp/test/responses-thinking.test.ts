import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,readFile,mkdir,rm,realpath} from 'node:fs/promises';
import {createServer, type ServerResponse} from 'node:http';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {client,methods} from '@agentclientprotocol/sdk';
import {getBuiltinModels} from '@earendil-works/pi-ai/providers/all';
import {ModelRuntime,createAgentSession,SettingsManager,SessionManager} from '@earendil-works/pi-coding-agent';
import {createAssistantMessageEventStream,getSupportedThinkingLevels,type AssistantMessage,type Model,type Api} from '@earendil-works/pi-ai';
import {startEidoAgent} from '../src/server.ts';
import {customImagePolicy,installCustomModelCatalog} from '../src/custom-model-policy.ts';
import {installResponsesCompat} from '../src/responses-compat.ts';
import {isRetryableAssistantError} from '@earendil-works/pi-ai/compat';
import {classifyTerminal,requiresResponses,responsesFailure} from '../adapter/src/errors.js';
import {createPiSettings} from '../../runtime/src/pi/settings.mjs';

const rejection = 'Chat Completions does not support tools with reasoning_effort. Use /v1/responses instead.';
const reject = (response:ServerResponse,status=400,message=rejection) => {response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify({error:{message}}));};
function respond(response:ServerResponse,tool=false) {
  const item = tool ? {type:'function_call',id:'fc_ping',call_id:'call_ping',name:'validation_ping',arguments:'{}',status:'completed'}
    : {type:'message',id:'msg_done',role:'assistant',status:'completed',content:[{type:'output_text',text:'Local fixture complete.',annotations:[]}]};
  const events = [{type:'response.created',response:{id:'resp_local'}},{type:'response.output_item.done',output_index:0,item},
    {type:'response.completed',response:{id:'resp_local',status:'completed',output:[item],usage:{input_tokens:10,output_tokens:3,total_tokens:13,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:1}}}}];
  response.writeHead(200,{'content-type':'text/event-stream'});
  response.end(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join(''));
}
type Request = {path:string;body:any;authorization:string|undefined};
async function fixture(handler:(request:Request,response:ServerResponse)=>void|Promise<void>,prepare?:(runtime:ModelRuntime,directory:string)=>void,retryEnabled=false) {
  const directory=await realpath(await mkdtemp(join(tmpdir(),'eido-responses-')));
  const requests:Request[]=[];
  const http=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const request={path:req.url!,body:JSON.parse(Buffer.concat(chunks).toString()),authorization:req.headers.authorization};
    requests.push(request);await handler(request,res);
  });
  await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
  const baseUrl=`http://127.0.0.1:${(http.address() as import('node:net').AddressInfo).port}/v1`;
  const models={providers:{sr:{baseUrl,api:'openai-completions',models:[
    {id:'gpt-fixture'},{id:'gemini-fixture'},{id:'disabled',reasoning:false},{id:'mapped',reasoning:true,thinkingLevelMap:{minimal:null,high:'high'}},{id:'responses',api:'openai-responses'},
    {id:'gpt-6.2-sol'},{id:'cd-o-5-5'},{id:'ordinary-fixture'},{id:'gpt-6.1-sol'},
    {id:'claude-opus-4-7'},{id:'claude-opus-4-6'},{id:'gpt-4'},
    {id:'gpt-explicit-map',reasoning:true,thinkingLevelMap:{xhigh:null,max:'high'}},
    {id:'restricted-map',reasoning:true,thinkingLevelMap:{low:'low',high:'high'}},
    {id:'gemini-3-flash-preview'},{id:'gemini-3.1-pro-preview'},{id:'gemini-4-argon'},{id:'gemini-4-hydrogen'},
    {id:'gemini-disabled',reasoning:false},{id:'gemini-explicit',reasoning:true,thinkingLevelMap:{off:'none',minimal:'minimal',high:'high',xhigh:'high',max:null}}]},
    native:{baseUrl:new URL(baseUrl).origin,api:'anthropic-messages',models:[{id:'claude-opus-4-7'},{id:'claude-native-unknown',reasoning:true}]},
    googleNative:{baseUrl,api:'google-generative-ai',models:[{id:'gemini-3-flash-preview'},{id:'gemini-3.1-pro-preview'},{id:'gemini-2.5-flash'},{id:'gemini-4-hydrogen'}]},
    vertexNative:{baseUrl,api:'google-vertex',models:[{id:'gemini-3.1-pro-preview'}]}}};
  await writeFile(join(directory,'models.json'),JSON.stringify(models));
  await writeFile(join(directory,'auth.json'),JSON.stringify({sr:{type:'api_key',key:'fixture-key'},native:{type:'api_key',key:'fixture-native'},googleNative:{type:'api_key',key:'fixture-google'},vertexNative:{type:'api_key',key:'fixture-vertex'}}));
  await writeFile(join(directory,'settings.json'),JSON.stringify({defaultProvider:'sr',defaultModel:'gpt-fixture',defaultThinkingLevel:'off',
    cacheWarming:'off',compaction:{enabled:false},retry:{enabled:retryEnabled,maxRetries:3,baseDelayMs:1,provider:{maxRetries:0}}}));
  await mkdir(join(directory,'extensions'));
  await writeFile(join(directory,'extensions','probe.js'),`import {appendFile} from 'node:fs/promises'; export default api=>api.registerTool({name:'validation_ping',label:'Validation ping',description:'Count a local test call',parameters:{type:'object',properties:{}},async execute(){await appendFile(${JSON.stringify(join(directory,'tool-count'))},'x');return {content:[{type:'text',text:'ping complete'}]};}});`);
  const runtime=await ModelRuntime.create({authPath:join(directory,'auth.json'),modelsPath:join(directory,'models.json'),allowModelNetwork:false});
  prepare?.(runtime,directory);
  const originalStream=runtime.streamSimple, originalGetModel=runtime.getModel;
  const toAgent=new TransformStream(),toClient=new TransformStream();
  const server=await startEidoAgent(directory,join(directory,'sessions'),{readable:toAgent.readable,writable:toClient.writable},runtime);
  const updates:any[]=[];
  const connection=client({name:'responses-thinking-test'})
    .onNotification(methods.client.session.update,({params})=>{updates.push(params.update);})
    .onRequest(methods.client.session.requestPermission,()=>({outcome:{outcome:'selected',optionId:'allow_once'}}))
    .connect({readable:toClient.readable,writable:toAgent.writable});
  await connection.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{}});
  const task=await connection.agent.request(methods.agent.session.new,{cwd:directory,mcpServers:[]});
  return {directory,models,baseUrl,runtime,connection,task,requests,updates,
    select:(configId:string,value:string)=>connection.agent.request(methods.agent.session.setConfigOption,{sessionId:task.sessionId,configId,value}),
    send:()=>connection.agent.request(methods.agent.session.prompt,{sessionId:task.sessionId,prompt:[{type:'text',text:'Run this local fixture.'}]}),
    async close(){await server.agent.dispose();connection.close();server.connection.close();assert.equal(runtime.streamSimple,originalStream);assert.equal(runtime.getModel,originalGetModel);http.closeAllConnections();http.close();await rm(directory,{recursive:true,force:true});}};
}
const thinking=(options:any[])=>options.find(option=>option.id==='thinkingLevel');

test('ACP preserves real low/high effort, tool execution, restore, capability opt-out and protocol cache isolation', {timeout:30_000}, async()=>{
  let tools=0;
  const f=await fixture((request,response)=>request.path.endsWith('/chat/completions') ? reject(response) : respond(response,tools++===0));
  try {
    const configBefore=await readFile(join(f.directory,'models.json'),'utf8');
    assert.ok(thinking(f.task.configOptions!).options.some((option:any)=>option.value==='high'));
    assert.match(thinking(f.task.configOptions!).description,/available to try/);
    for(const read of [()=>f.runtime.getModel('sr','gemini-fixture'),()=>f.runtime.getModels('sr').find(m=>m.id==='gemini-fixture'),
      ()=>f.runtime.getAvailableSnapshot().find(m=>m.id==='gemini-fixture'),async()=>(await f.runtime.getAvailable('sr')).find(m=>m.id==='gemini-fixture')]) assert.equal((await read())?.reasoning,true);
    assert.deepEqual(getSupportedThinkingLevels(f.runtime.getModel('sr','disabled')!),['off']);
    assert.ok(!getSupportedThinkingLevels(f.runtime.getModel('sr','mapped')!).includes('minimal'));
    assert.equal(f.runtime.getModel('sr','responses')!.reasoning,true);
    for(const effort of ['low','high']) {
      const selected=await f.select('thinkingLevel',effort);assert.equal(thinking(selected.configOptions).currentValue,effort);
      await f.send();
    }
    assert.deepEqual(f.requests.map(r=>r.path),['/v1/chat/completions','/v1/responses','/v1/responses','/v1/responses']);
    assert.deepEqual(f.requests.map(r=>r.body.reasoning_effort ?? r.body.reasoning?.effort),['low','low','low','high']);
    assert.ok(f.requests.every(r=>r.body.model==='gpt-fixture'&&r.authorization==='Bearer fixture-key'));
    assert.ok(f.requests[0]!.body.tools.some((t:any)=>t.function.name==='validation_ping'));
    assert.ok(f.requests[1]!.body.tools.some((t:any)=>t.name==='validation_ping'));
    assert.equal(await readFile(join(f.directory,'tool-count'),'utf8'),'x','pi executes the final tool call once');
    await f.select('model','sr/gemini-fixture');await f.select('thinkingLevel','high');await f.send();
    assert.deepEqual(f.requests.slice(-2).map(r=>[r.path,r.body.model,r.body.reasoning_effort??r.body.reasoning?.effort]),[
      ['/v1/chat/completions','gemini-fixture','high'],['/v1/responses','gemini-fixture','high']]);
    await f.connection.agent.request(methods.agent.session.close,{sessionId:f.task.sessionId});
    const restored=await f.connection.agent.request(methods.agent.session.load,{sessionId:f.task.sessionId,cwd:f.directory,mcpServers:[]});
    assert.equal(thinking(restored.configOptions!).currentValue,'high');
    await f.send();assert.equal(f.requests.at(-1)!.path,'/v1/responses');
    await f.runtime.refresh({allowNetwork:false});await f.send();assert.equal(f.requests.at(-2)!.path,'/v1/chat/completions','refresh discards successful adaptation');
    await f.select('model','sr/disabled');
    assert.deepEqual(thinking((await f.select('thinkingLevel','high')).configOptions).options.map((o:any)=>o.value),['off']);
    assert.equal(thinking((await f.select('thinkingLevel','high')).configOptions).currentValue,'off');
    assert.equal(await readFile(join(f.directory,'models.json'),'utf8'),configBefore);
  } finally {await f.close();}
});

const message=(model:Model<Api>,errorMessage?:string):AssistantMessage=>({role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],stopReason:errorMessage?'error':'stop',errorMessage,timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
test('only explicit empty HTTP 400 refusals retry; partial streams, cancellation and retry failures terminate once',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'eido-responses-boundary-'));
  await writeFile(join(directory,'models.json'),JSON.stringify({providers:{sr:{baseUrl:'https://example.invalid/v1',api:'openai-completions',apiKey:'fixture',models:[{id:'test'}]}}}));
  const policy=await customImagePolicy(directory);
  const model=policy.project({id:'test',provider:'sr',api:'openai-completions',baseUrl:'https://example.invalid/v1',name:'test',reasoning:false,input:['text'],contextWindow:4096,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}});
  try {
    for(const scenario of ['ordinary400','401','429','500','network','cancel','text_start','thinking_start','toolcall_start','partial-terminal','cached-failure','retry-401','retry-429','retry-throw','incomplete','success']) {
      let calls=0;const controller=new AbortController();const context={messages:[]};const options={reasoning:'high' as const,signal:controller.signal,timeout:10_000,headers:{'x-fixture':'preserved'}};
      const runtime={refresh:async()=>({}),streamSimple:(request:Model<Api>,receivedContext:unknown,receivedOptions:unknown)=>{
        assert.equal(receivedContext,context);assert.equal(receivedOptions,options);assert.equal(request.id,model.id);assert.equal(request.baseUrl,model.baseUrl);assert.equal(request.reasoning,true);
        calls++;const call=calls;const stream=createAssistantMessageEventStream();
        queueMicrotask(()=>{
          const output=message(request);stream.push({type:'start',partial:output});
          if(call===1) {
            let error=`HTTP 400: ${rejection}`;
            if(['401','429','500'].includes(scenario))error=`HTTP ${scenario}: ${rejection}`;
            if(scenario==='ordinary400')error='HTTP 400: Invalid input';
            if(scenario==='network')error='Network connection reset';
            if(scenario==='cancel')controller.abort();
            if(['text_start','thinking_start','toolcall_start'].includes(scenario))stream.push({type:scenario as 'text_start',contentIndex:0,partial:output});
            if(scenario==='partial-terminal')output.content=[{type:'text',text:'already emitted'}];
            output.errorMessage=error;output.stopReason='error';stream.push({type:'error',reason:'error',error:output});
          } else if(scenario==='retry-401'||scenario==='retry-429'||(scenario==='cached-failure'&&call===3)) {
            output.errorMessage=`HTTP ${scenario==='retry-401'?'401':'429'}: secret-fixture-key https://private.invalid body text`;output.stopReason='error';stream.push({type:'error',reason:'error',error:output});
          } else if(scenario==='retry-throw') {stream.end(output);return;}
          else {stream.push({type:'done',reason:scenario==='incomplete'?'length':'stop',message:output});}
          stream.end();
        });return stream;
      }} as unknown as ModelRuntime;
      const compat=installResponsesCompat(runtime,policy);
      try {
        const events=[];const stream=runtime.streamSimple(model,context,options);for await(const event of stream)events.push(event);const result=await stream.result();
        const retries=['success','cached-failure','retry-401','retry-429','retry-throw','incomplete'].includes(scenario);
        assert.equal(calls,retries?2:1,scenario);assert.equal(events.filter(e=>e.type==='error'||e.type==='done').length,1,scenario);
        assert.equal(events.filter(e=>e.type==='start').length,scenario==='retry-throw'?0:1,scenario);
        if(scenario.startsWith('retry-')) {
          const error=JSON.stringify(classifyTerminal(result));assert.match(error,/Responses was tried automatically/);assert.doesNotMatch(error,/secret-fixture|private.invalid|body text/);
          if(scenario==='retry-401')assert.match(error,/auth_error/);if(scenario==='retry-429')assert.match(error,/rate_limit/);
        }
        if(scenario==='success') {await runtime.streamSimple(model,context,options).result();assert.equal(calls,3);}
        if(scenario==='cached-failure') {await runtime.streamSimple(model,context,options).result();assert.equal(calls,3);await runtime.streamSimple(model,context,options).result();assert.equal(calls,4);}
      } finally {compat.dispose();}
    }
    assert.equal(requiresResponses(`HTTP 422: ${rejection}`),false);
    const runtime=await ModelRuntime.create({modelsPath:join(directory,'models.json'),allowModelNetwork:false});
    const restore=installCustomModelCatalog(runtime,policy);
    const created=await createAgentSession({cwd:directory,agentDir:directory,modelRuntime:runtime,model:runtime.getModel('sr','test'),
      sessionManager:SessionManager.inMemory(directory),settingsManager:SettingsManager.inMemory({cacheWarming:'off'}),noTools:"all"});
    const identity=created.session.agent.streamFunction;const compat=installResponsesCompat(runtime,policy);
    created.session.setThinkingLevel('high');assert.equal(created.session.thinkingLevel,'high');assert.equal(created.session.agent.streamFunction,identity);
    compat.dispose();created.session.dispose();restore();
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('Responses auth rechecks reject credential changes inside one adaptation but allow later user requests', {timeout:20_000},async()=>{
  let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(r=>{entered=r;});const resume=new Promise<void>(r=>{release=r;});let hold=true;
  const f=await fixture((request,response)=>request.path.endsWith('/chat/completions')?reject(response):respond(response),runtime=>{
    const original=runtime.getAuth.bind(runtime);
    runtime.getAuth=async(model,options)=>{if(typeof model!=='string'&&model.api==='openai-responses'&&hold){hold=false;entered();await resume;}return typeof model==='string'?original(model,options):original(model,options);};
  });
  try {
    await f.select('thinkingLevel','low');
    const pending=assert.rejects(f.send(),error=>/connection or credentials changed/.test(JSON.stringify(error)));
    await waiting;
    // Change the credential while preserving the configured destination.
    await createPiSettings(f.directory).execute({operation:'key',provider:'sr',key:'fixture-rotated'});release();await pending;
    assert.deepEqual(f.requests.map(r=>[r.path,r.authorization]),[['/v1/chat/completions','Bearer fixture-key']]);
    await f.runtime.refresh({allowNetwork:false});
    await f.send();assert.deepEqual(f.requests.slice(-2).map(r=>r.authorization),['Bearer fixture-rotated','Bearer fixture-rotated']);
    const stale=f.runtime.getModel('sr','gpt-fixture')!;
    const policy=await customImagePolicy(f.directory);const derived=policy.copyModel(policy.project(stale),{api:'openai-responses'});
    await assert.rejects(f.runtime.getAuth({...derived,eidoSourceApi:'openai-completions'} as Model<Api>),/This connection changed/,'public strings cannot authorize derived Responses models');
    (f.models.providers.sr.models[0] as any).reasoning=false;await writeFile(join(f.directory,'models.json'),JSON.stringify(f.models));await f.runtime.refresh({allowNetwork:false});
    await assert.rejects(f.runtime.getAuth(stale),/This connection changed/,'a newly explicit capability opt-out invalidates the old selection');
    await f.select('model','sr/gpt-fixture');assert.equal(thinking((await f.select('thinkingLevel','high')).configOptions).currentValue,'off');
  } finally {release();await f.close();}
});


test('enabled pi turn retries cannot restart an ended Responses adaptation', {timeout:15_000}, async()=>{
  for (const status of [401,429,500,503]) {
    const terminal:AssistantMessage={role:'assistant',api:'openai-responses',provider:'sr',model:'fixture',content:[],timestamp:Date.now(),
      usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
      stopReason:'error',errorMessage:responsesFailure(`HTTP ${status}: fixture`)};
    assert.equal(isRetryableAssistantError(terminal),false,`adaptation status ${status} must be terminal to pi`);
    assert.match(JSON.stringify(classifyTerminal(terminal)),new RegExp(`HTTP ${status}`));
  }
  for (const status of [429,503]) {
    const f=await fixture((request,response)=>request.path.endsWith('/chat/completions') ? reject(response)
      : reject(response,status,status===429?'Rate limit':'Service temporarily unavailable'),undefined,true);
    try {
      const settings=await SettingsManager.create(f.directory,f.directory,{projectTrusted:false});
      assert.equal(settings.getRetrySettings().enabled,true);
      assert.equal(settings.getRetrySettings().maxRetries,3);
      await f.select('thinkingLevel','low');
      await assert.rejects(f.send(),error=>{
        const details=JSON.stringify(error);
        assert.match(details,new RegExp(`HTTP ${status}`));
        assert.match(details,status===429?/rate_limit/:/provider_error/);
        assert.match(details,/Responses was tried automatically/);
        assert.match(details,/Automatic adaptation has stopped/);
        return true;
      });
      assert.deepEqual(f.requests.map(request=>request.path),['/v1/chat/completions','/v1/responses'],`HTTP ${status} must end after one protocol pair`);
      assert.equal((await SettingsManager.create(f.directory,f.directory,{projectTrusted:false})).getRetrySettings().enabled,true,'the user retry setting stays enabled');
    } finally {await f.close();}
  }
});


function respondAnthropic(response:ServerResponse) {
  const events=[
    {type:'message_start',message:{id:'msg_local',type:'message',role:'assistant',model:'claude-opus-4-7',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:1}}},
    {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
    {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Local native fixture complete.'}},
    {type:'content_block_stop',index:0},
    {type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:3}},
    {type:'message_stop'},
  ];
  response.writeHead(200,{'content-type':'text/event-stream'});
  response.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}

test('catalog and trial extended levels preserve xhigh/max on the actual API without overriding explicit limits', {timeout:20_000}, async()=>{
  const f=await fixture((request,response)=>request.path.startsWith('/v1/messages') ? respondAnthropic(response)
    : request.path.endsWith('/chat/completions') ? reject(response) : respond(response));
  const send = async () => {
    try {await f.send();} catch(error) {assert.fail(`${f.requests.at(-1)?.path} ${f.requests.at(-1)?.body.model}: ${JSON.stringify(error)}`);}
  };
  try {
    const before=await readFile(join(f.directory,'models.json'),'utf8');
    const builtins=[...getBuiltinModels('openai'),...getBuiltinModels('anthropic')];
    for(const id of ['gpt-6.1-sol','claude-opus-4-7','claude-opus-4-6','gpt-4']) {
      const source=builtins.find(model=>model.id===id)!;assert.ok(source);
      const projected=f.runtime.getModel('sr',id)!;
      assert.equal(projected.reasoning,source.reasoning);
      assert.deepEqual(projected.thinkingLevelMap,source.thinkingLevelMap);
      assert.equal(projected.baseUrl,f.baseUrl);
      assert.deepEqual(projected.cost,{input:0,output:0,cacheRead:0,cacheWrite:0});
      assert.equal((projected.compat as any)?.forceAdaptiveThinking,undefined,'native compatibility flags never cross API boundaries');
    }
    assert.deepEqual(getSupportedThinkingLevels(f.runtime.getModel('sr','gpt-4')!),['off']);
    assert.ok(!getSupportedThinkingLevels(f.runtime.getModel('sr','claude-opus-4-6')!).includes('xhigh'));
    for(const id of ['gpt-6.2-sol','cd-o-5-5','ordinary-fixture','gpt-6.1-sol','claude-opus-4-7']) {
      const selected=await f.select('model',`sr/${id}`);
      if(!builtins.some(model=>model.id===id))assert.match(thinking(selected.configOptions).description,/available to try/);
      for(const effort of ['xhigh','max']) {
        assert.equal(thinking((await f.select('thinkingLevel',effort)).configOptions).currentValue,effort);
        const first=f.requests.length;await send();
        const requests=f.requests.slice(first);
        assert.deepEqual(requests.map(request=>request.path),effort==='xhigh'?['/v1/chat/completions','/v1/responses']:['/v1/responses']);
        assert.ok(requests.every(request=>request.body.model===id&&(request.body.reasoning_effort??request.body.reasoning?.effort)===effort));
      }
    }
    assert.deepEqual(getSupportedThinkingLevels(f.runtime.getModel('sr','disabled')!),['off']);
    const restricted=f.runtime.getModel('sr','restricted-map')!;
    assert.ok(!getSupportedThinkingLevels(restricted).includes('xhigh'));assert.ok(!getSupportedThinkingLevels(restricted).includes('max'));
    await f.select('model','sr/gpt-explicit-map');
    const explicit=f.runtime.getModel('sr','gpt-explicit-map')!;
    assert.equal(explicit.thinkingLevelMap?.xhigh,null);assert.equal(explicit.thinkingLevelMap?.max,'high');
    await f.select('thinkingLevel','max');const customStart=f.requests.length;await send();
    assert.ok(f.requests.slice(customStart).every(request=>(request.body.reasoning_effort??request.body.reasoning?.effort)==='high'));
    const native=f.runtime.getModel('native','claude-opus-4-7')!;
    assert.equal((native.compat as any)?.forceAdaptiveThinking,true);
    assert.ok(!getSupportedThinkingLevels(f.runtime.getModel('native','claude-native-unknown')!).includes('xhigh'));
    assert.ok(!getSupportedThinkingLevels(f.runtime.getModel('native','claude-native-unknown')!).includes('max'));
    await f.select('model','native/claude-opus-4-7');
    for(const effort of ['xhigh','max']) {
      assert.equal(thinking((await f.select('thinkingLevel',effort)).configOptions).currentValue,effort);
      const start=f.requests.length;await send();assert.equal(f.requests.length,start+1);
      assert.match(f.requests.at(-1)!.path,/messages/);assert.equal(f.requests.at(-1)!.body.output_config.effort,effort);
      assert.equal(f.requests.at(-1)!.body.thinking.type,'adaptive');
    }
    assert.equal(await readFile(join(f.directory,'models.json'),'utf8'),before,'capability projection never rewrites configuration');
    (f.models.providers.native.models[0] as any).compat={forceAdaptiveThinking:false};
    const known=f.models.providers.sr.models.find(model=>model.id==='gpt-6.1-sol')!;
    (known as any).thinkingLevelMap={xhigh:null,max:'high'};
    await writeFile(join(f.directory,'models.json'),JSON.stringify(f.models));await f.runtime.refresh({allowNetwork:false});
    await assert.rejects(f.runtime.getAuth(native),/This connection changed/,'adaptive configuration changes invalidate the old selected object');
    assert.equal((f.runtime.getModel('native','claude-opus-4-7')!.compat as any)?.forceAdaptiveThinking,false);
    assert.ok(!getSupportedThinkingLevels(f.runtime.getModel('native','claude-opus-4-7')!).includes('xhigh'),'disabling adaptive effort does not inherit an unusable extended level');
    assert.deepEqual(f.runtime.getModel('sr','gpt-6.1-sol')!.thinkingLevelMap,{xhigh:null,max:'high'},'an explicit catalog override wins as a complete map');
    delete (f.models.providers.native.models[0] as any).compat;
    (f.models.providers.native as any).compat={forceAdaptiveThinking:true};
    await writeFile(join(f.directory,'models.json'),JSON.stringify(f.models));await f.runtime.refresh({allowNetwork:false});
    const providerEnabled=f.runtime.getModel('native','claude-opus-4-7')!;
    assert.equal((providerEnabled.compat as any)?.forceAdaptiveThinking,true);
    (f.models.providers.native as any).compat.forceAdaptiveThinking=false;
    await writeFile(join(f.directory,'models.json'),JSON.stringify(f.models));await f.runtime.refresh({allowNetwork:false});
    await assert.rejects(f.runtime.getAuth(providerEnabled),/This connection changed/,'provider-only adaptive configuration changes also invalidate the selected model');
    assert.equal((f.runtime.getModel('native','claude-opus-4-7')!.compat as any)?.forceAdaptiveThinking,false);

  } finally {await f.close();}
});


test('Gemini catalog and family trials retain distinct levels and native Google level/budget payloads', {timeout:15_000},async()=>{
  const f=await fixture((request,response)=>{
    if(request.path.includes(':streamGenerateContent')) {
      response.writeHead(200,{'content-type':'text/event-stream'});
      response.end(`data: ${JSON.stringify({candidates:[{content:{role:'model',parts:[{text:'Local Google fixture complete.'}]},finishReason:'STOP',index:0}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:2,totalTokenCount:12}})}\n\n`);
    } else if(request.path.endsWith('/chat/completions'))reject(response);else respond(response);
  });
  const send=async()=>{try{await f.send();}catch(error){assert.fail(`${f.requests.at(-1)?.path}: ${JSON.stringify(error)}`);}};
  try {
    const saved=await readFile(join(f.directory,'models.json'),'utf8');
    const catalog=getBuiltinModels('google');
    for(const id of ['gemini-3-flash-preview','gemini-3.1-pro-preview','gemini-4-argon']) {
      assert.deepEqual(f.runtime.getModel('sr',id)!.thinkingLevelMap,catalog.find(model=>model.id===id)!.thinkingLevelMap);
    }
    assert.deepEqual(getSupportedThinkingLevels(f.runtime.getModel('sr','gemini-3-flash-preview')!),['minimal','low','medium','high']);
    for(const id of ['gemini-3.1-pro-preview','gemini-4-argon','gemini-4-hydrogen'])assert.deepEqual(getSupportedThinkingLevels(f.runtime.getModel('sr',id)!),['low','medium','high']);
    assert.equal(catalog.some(model=>model.id==='gemini-4-hydrogen'),false,'hydrogen is not an alias for a known catalog model');
    assert.deepEqual(getSupportedThinkingLevels(f.runtime.getModel('sr','gemini-disabled')!),['off']);
    assert.deepEqual(f.runtime.getModel('sr','gemini-explicit')!.thinkingLevelMap,{off:'none',minimal:'minimal',high:'high',xhigh:'high',max:null});
    assert.ok(getSupportedThinkingLevels(f.runtime.getModel('sr','ordinary-fixture')!).includes('max'),'opaque aliases are not guessed to be Gemini');
    for(const [id,effort,wire] of [['gemini-3-flash-preview','minimal','minimal'],['gemini-3.1-pro-preview','high','high'],['gemini-4-hydrogen','medium','medium'],['gemini-explicit','xhigh','high']]) {
      const selected=await f.select('model',`sr/${id}`);
      if(id==='gemini-4-hydrogen')assert.match(thinking(selected.configOptions).description,/available to try/);
      assert.equal(thinking((await f.select('thinkingLevel',effort!)).configOptions).currentValue,effort);
      const start=f.requests.length;await send();
      assert.deepEqual(f.requests.slice(start).map(request=>request.path),['/v1/chat/completions','/v1/responses']);
      for(const request of f.requests.slice(start)) {
        assert.equal(request.body.reasoning_effort??request.body.reasoning?.effort,wire);
        assert.equal(request.body.generationConfig,undefined,'OpenAI payloads never receive Google thinkingConfig');
      }
    }
    for(const [provider,id,effort,expected] of [
      ['googleNative','gemini-3-flash-preview','minimal',{thinkingLevel:'MINIMAL'}],
      ['googleNative','gemini-3.1-pro-preview','high',{thinkingLevel:'HIGH'}],
      ['googleNative','gemini-4-hydrogen','medium',{thinkingLevel:'MEDIUM'}],
      ['googleNative','gemini-2.5-flash','low',{thinkingBudget:2048}],
      ['googleNative','gemini-2.5-flash','off',{thinkingBudget:0}],
      ['vertexNative','gemini-3.1-pro-preview','low',{thinkingLevel:'LOW'}],
    ] as const) {
      await f.select('model',`${provider}/${id}`);
      assert.equal(thinking((await f.select('thinkingLevel',effort)).configOptions).currentValue,effort);
      const start=f.requests.length;await send();assert.equal(f.requests.length,start+1);
      const request=f.requests.at(-1)!;assert.match(request.path,/:streamGenerateContent/);
      for(const [key,value] of Object.entries(expected))assert.equal(request.body.generationConfig.thinkingConfig[key],value);
      assert.equal(request.body.reasoning_effort,undefined);assert.equal(request.body.reasoning,undefined);
    }
    assert.equal(await readFile(join(f.directory,'models.json'),'utf8'),saved);
  } finally {await f.close();}
});
