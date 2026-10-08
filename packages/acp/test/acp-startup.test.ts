import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {client,methods} from '@agentclientprotocol/sdk';
import {startEidoAgent} from '../src/server.ts';
import {fixtureModel} from './fixture-model.ts';

test('requests arriving during Eido startup wait for capability and session setup',{timeout:20000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'eido-startup-'));
  await writeFile(join(dir,'settings.json'),JSON.stringify({defaultProvider:'eido-fixture',defaultModel:'scripted'}));
  const model=await fixtureModel(dir,[]);
  const toAgent=new TransformStream(),toClient=new TransformStream();
  const conn=client({name:'startup-client'}).connect({readable:toClient.readable,writable:toAgent.writable});
  // Queue the request before starting the server: an external client need not
  // know how long model loading and Eido's history setup take.
  const initialized=conn.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{}});
  let server:Awaited<ReturnType<typeof startEidoAgent>>|undefined;
  try {
    server=await startEidoAgent(dir,join(dir,'sessions'),{readable:toAgent.readable,writable:toClient.writable},model.runtime);
    const result=await initialized;
    assert.equal(result.agentCapabilities?.promptCapabilities?.embeddedContext,true);
    const task=await conn.agent.request(methods.agent.session.new,{cwd:dir,mcpServers:[]});
    assert.ok(task.sessionId);
  }finally{await server?.agent.dispose();conn.close();server?.connection.close();await rm(dir,{recursive:true,force:true});}
});
