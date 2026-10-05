import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, writeFile, rm, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {client, methods} from '@agentclientprotocol/sdk';
import {startEidoAgent} from '../src/server.ts';
import {fixtureModel} from './fixture-model.ts';

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
