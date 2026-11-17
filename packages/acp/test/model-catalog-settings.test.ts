import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, writeFile, rm, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {client, methods} from '@agentclientprotocol/sdk';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {startEidoAgent} from '../src/server.ts';
import {fixtureModel} from './fixture-model.ts';
import {createPiSettings} from '../../runtime/src/pi/settings.mjs';

test('saved connections refresh an open workbench without changing its selected model', {timeout:15_000}, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(),'eido-model-catalog-')));
  await writeFile(join(dir,'settings.json'),JSON.stringify({defaultProvider:'eido-fixture',defaultModel:'scripted',cacheWarming:'off'}));
  const runtime = await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),allowModelNetwork:false});
  await fixtureModel(dir,[],{runtime});
  const toAgent = new TransformStream(), toClient = new TransformStream();
  const server = await startEidoAgent(dir,join(dir,'sessions'),{readable:toAgent.readable,writable:toClient.writable},runtime);
  const updates: any[] = [];
  const connection = client({name:'catalog-settings-test'})
    .onNotification(methods.client.session.update, ({params}) => {
      if(params.update.sessionUpdate === 'config_option_update') updates.push(params.update.configOptions);
    }).connect({readable:toClient.readable,writable:toAgent.writable});
  const modelOption = (options:any[]) => options.find(o=>o.id==='model');
  const hasSr = (options:any[]) => JSON.stringify(modelOption(options)?.options).includes('sr/fixture-model');
  const waitFor = async (predicate:()=>boolean) => {
    const until = Date.now()+5000;
    while(!predicate() && Date.now()<until) await new Promise(resolve=>setTimeout(resolve,30));
    assert.ok(predicate(),'the live model catalog should update after a settings write');
  };
  try {
    await connection.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{}});
    const task = await connection.agent.request(methods.agent.session.new,{cwd:dir,mcpServers:[]});
    assert.equal(hasSr(task.configOptions!),false);
    const settings = createPiSettings(dir,join(dir,'unused-source'));
    await settings.execute({operation:'custom-model',provider:'sr',model:'fixture-model',baseUrl:'https://example.invalid/v1',api:'openai-completions',key:'fixture-key'});
    await waitFor(()=>updates.some(hasSr));
    assert.equal(modelOption(updates.at(-1)).currentValue,'eido-fixture/scripted');
    const selected = await connection.agent.request(methods.agent.session.setConfigOption,{sessionId:task.sessionId,configId:'model',value:'sr/fixture-model'});
    assert.equal(modelOption(selected.configOptions).currentValue,'sr/fixture-model');
    await connection.agent.request(methods.agent.session.setConfigOption,{sessionId:task.sessionId,configId:'model',value:'eido-fixture/scripted'});
    updates.length = 0;
    await settings.execute({operation:'remove-key',provider:'sr'});
    await waitFor(()=>updates.length>0 && !hasSr(updates.at(-1)));
  } finally {
    await server.agent.dispose(); connection.close(); server.connection.close();
    await rm(dir,{recursive:true,force:true});
  }
});
