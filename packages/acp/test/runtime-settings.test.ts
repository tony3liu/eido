import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdir, mkdtemp, writeFile, readFile, rm, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {client, methods} from '@agentclientprotocol/sdk';
import {startEidoAgent} from '../src/server.ts';
import {call, fixtureModel, type FixtureStep} from './fixture-model.ts';

test('model defaults flow through ACP selection and pi compaction after reload', {timeout:30_000}, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'eido-model-settings-')));
  const key = 'eido-fixture/scripted';
  const configure = (override:Record<string,unknown>, thinking:string) => writeFile(join(dir,'settings.json'),JSON.stringify({
    defaultProvider:'eido-fixture',defaultModel:'scripted',defaultThinkingLevel:'off',cacheWarming:'off',
    modelThinkingLevels:{[key]:thinking},compaction:{enabled:false,reserveTokens:1000,keepRecentTokens:100,modelOverrides:{[key]:override}},
  }));
  await configure({reserveTokens:1500},'high');
  await mkdir(join(dir,'extensions'));
  await writeFile(join(dir,'extensions/compaction.js'), `import {appendFile} from 'node:fs/promises';
    export default pi => pi.on('session_before_compact', async event => {
      await appendFile(${JSON.stringify(join(dir,'compaction.jsonl'))}, JSON.stringify(event.preparation.settings)+'\\n');
    });`);
  const model = await fixtureModel(dir,[()=> 'Earlier context. '.repeat(400),()=> 'Recent answer.',
    context => {assert.match(JSON.stringify(context),/context summarization assistant/);return 'Saved fixture summary.';}],{reasoning:true});
  const toAgent = new TransformStream(), toClient = new TransformStream();
  const server = await startEidoAgent(dir,join(dir,'sessions'),{readable:toAgent.readable,writable:toClient.writable},model.runtime);
  const connection = client({name:'model-settings-test'}).connect({readable:toClient.readable,writable:toAgent.writable});
  try {
    await connection.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{}});
    const task = await connection.agent.request(methods.agent.session.new,{cwd:dir,mcpServers:[]});
    const level = (options:typeof task.configOptions) => options?.find(o=>o.id==='thinkingLevel')?.currentValue;
    assert.equal(level(task.configOptions),'high');
    const send = (text:string) => connection.agent.request(methods.agent.session.prompt,{sessionId:task.sessionId,prompt:[{type:'text',text}]});
    const select = (configId:string,value:string) => connection.agent.request(methods.agent.session.setConfigOption,{sessionId:task.sessionId,configId,value});
    assert.equal(level((await select('thinkingLevel','medium')).configOptions),'medium');
    // An explicit task choice must not silently become a saved model default.
    assert.equal(JSON.parse(await readFile(join(dir,'settings.json'),'utf8')).modelThinkingLevels[key],'high');
    await send('Remember the marker. '.repeat(100)); await send('Continue.');
    await configure({reserveTokens:2200,keepRecentTokens:64},'low'); await send('/reload');
    assert.equal(level((await select('model',key)).configOptions),'low');
    await send('/compact keep the marker');
    assert.deepEqual(JSON.parse((await readFile(join(dir,'compaction.jsonl'),'utf8')).trim()),{enabled:false,reserveTokens:2200,keepRecentTokens:64});
    assert.equal(model.requests(),3);
    const next = await connection.agent.request(methods.agent.session.new,{cwd:dir,mcpServers:[]});
    assert.equal(level(next.configOptions),'low');
  } finally {await server.agent.dispose();connection.close();server.connection.close();await rm(dir,{recursive:true,force:true});}
});

test('global pi queue modes control actual consumption and reload in an open task', {timeout:30_000}, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'eido-queue-modes-')));
  const configure = (mode:string) => writeFile(join(dir, 'settings.json'), JSON.stringify({
    defaultProvider:'eido-fixture', defaultModel:'scripted', cacheWarming:'off', compaction:{enabled:false},
    steeringMode:mode, followUpMode:mode,
  }));
  await configure('one-at-a-time');
  await mkdir(join(dir, 'extensions'));
  await writeFile(join(dir, 'extensions/queue.js'), `export default pi => pi.registerTool({
    name:'queue_followups', label:'Queue fixture', description:'Queue two fixture follow-ups',
    parameters:{type:'object',properties:{prefix:{type:'string'}},required:['prefix']},
    async execute(_id,args) {
      pi.sendUserMessage(args.prefix+'-1',{deliverAs:'followUp'});
      pi.sendUserMessage(args.prefix+'-2',{deliverAs:'followUp'});
      return {content:[{type:'text',text:'Follow-ups queued'}]};
    }
  });`);
  const steps:FixtureStep[] = [];
  const model = await fixtureModel(dir, steps);
  const toAgent = new TransformStream(), toClient = new TransformStream();
  const server = await startEidoAgent(dir, join(dir,'sessions'), {readable:toAgent.readable,writable:toClient.writable}, model.runtime);
  const connection = client({name:'queue-modes-test'})
    .onRequest(methods.client.session.requestPermission, () => ({outcome:{outcome:'selected',optionId:'allow_once'}}))
    .connect({readable:toClient.readable,writable:toAgent.writable});
  try {
    await connection.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{}});
    const {sessionId} = await connection.agent.request(methods.agent.session.new,{cwd:dir,mcpServers:[]});
    const send = (text:string) => connection.agent.request(methods.agent.session.prompt,{sessionId,prompt:[{type:'text',text}]});
    const expectBoundary = (prefix:string, count:number):FixtureStep => context => {
      const messages = context.messages.filter(message => message.role === 'user')
        .map(message => JSON.stringify(message.content));
      assert.equal(messages.filter(message => message.includes(prefix)).length, count);
      return 'Boundary consumed.';
    };
    for (const mode of ['one-at-a-time','all']) {
      await configure(mode);
      await send('/reload');
      const prefix = `steering-${mode}`;
      let started!:()=>void, release!:()=>void;
      const began = new Promise<void>(resolve => {started=resolve;});
      const gate = new Promise<void>(resolve => {release=resolve;});
      steps.push(async () => {started(); await gate; return 'Initial response.';}, expectBoundary(prefix,mode==='all'?2:1));
      if (mode==='one-at-a-time') steps.push(expectBoundary(prefix,2));
      const turn = send('Wait while two steering messages are queued.');
      try {
        await began;
        for (const suffix of [1,2]) await connection.agent.request('_session/steering',{
          sessionId,prompt:[{type:'text',text:`${prefix}-${suffix}`}],_meta:{eidoDeliveryId:`${prefix}-${suffix}`},
        });
      } finally {release();}
      assert.equal((await turn).stopReason,'end_turn');
      assert.equal(model.requests(),steps.length);
      const followUp = `followup-${mode}`;
      steps.push(() => call('queue_followups',{prefix:followUp}), () => 'Initial turn finished.', expectBoundary(followUp,mode==='all'?2:1));
      if (mode==='one-at-a-time') steps.push(expectBoundary(followUp,2));
      assert.equal((await send('Queue two follow-ups using the fixture tool.')).stopReason,'end_turn');
      assert.equal(model.requests(),steps.length);
    }
  } finally {await server.agent.dispose();connection.close();server.connection.close();await rm(dir,{recursive:true,force:true});}
});

test('pi reload applies request transport, thinking budgets, timeout and retry behavior', {timeout:30_000}, async () => {
  const dir=await realpath(await mkdtemp(join(tmpdir(),'eido-runtime-settings-')));
  const configure=(values:Record<string,unknown>)=>writeFile(join(dir,'settings.json'),JSON.stringify({
    defaultProvider:'eido-fixture',defaultModel:'scripted',cacheWarming:'off',compaction:{enabled:false},...values,
  }));
  await configure({transport:'sse',thinkingBudgets:{low:128},httpIdleTimeoutMs:600,retry:{provider:{maxRetryDelayMs:200}}});
  let observed=0;
  const model=await fixtureModel(dir,[
    (_context,_signal,options)=>{
      assert.equal(options?.transport,'sse'); assert.deepEqual(options?.thinkingBudgets,{low:128});
      assert.equal(options?.timeoutMs,600); assert.equal(options?.maxRetryDelayMs,200);
      observed++; return 'Initial runtime applied.';
    },
    (_context,_signal,options)=>{
      assert.equal(options?.transport,'websocket'); assert.deepEqual(options?.thinkingBudgets,{low:256});
      assert.equal(options?.timeoutMs,750); assert.equal(options?.maxRetries,2); assert.equal(options?.maxRetryDelayMs,300);
      observed++; return 'Reloaded runtime applied.';
    },
    ()=>{throw new Error('503 Service Unavailable: intentional retry fixture');},
    ()=>{observed++;return 'Retried once.';},
    ()=>{throw new Error('503 Service Unavailable: retry disabled fixture');},
  ]);
  const toAgent=new TransformStream(),toClient=new TransformStream();
  const server=await startEidoAgent(dir,join(dir,'sessions'),{readable:toAgent.readable,writable:toClient.writable},model.runtime);
  const connection=client({name:'runtime-settings-test'}).connect({readable:toClient.readable,writable:toAgent.writable});
  try {
    await connection.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{}});
    const task=await connection.agent.request(methods.agent.session.new,{cwd:dir,mcpServers:[]});
    const send=(text:string)=>connection.agent.request(methods.agent.session.prompt,{sessionId:task.sessionId,prompt:[{type:'text',text}]});
    assert.equal((await send('Inspect initial request options.')).stopReason,'end_turn');
    await configure({transport:'websocket',thinkingBudgets:{low:256},httpIdleTimeoutMs:900,
      retry:{enabled:true,maxRetries:1,baseDelayMs:0,provider:{timeoutMs:750,maxRetries:2,maxRetryDelayMs:300}}});
    await send('/reload');
    assert.equal((await send('Inspect changed request options.')).stopReason,'end_turn');
    assert.equal((await send('Retry one transient failure.')).stopReason,'end_turn');
    await configure({retry:{enabled:false}}); await send('/reload');
    await assert.rejects(send('Do not retry this failure.'));
    assert.equal(model.requests(),5); assert.equal(observed,3);
  } finally {await server.agent.dispose();connection.close();server.connection.close();await rm(dir,{recursive:true,force:true});}
});
