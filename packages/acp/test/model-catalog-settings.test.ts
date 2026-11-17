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
    await settings.execute({operation:'custom-connection',provider:'sr',models:['fixture-model','second-model'],expectedRevision:null,baseUrl:'https://example.invalid/v1',api:'openai-completions',key:'fixture-key'});
    await waitFor(()=>updates.some(hasSr));
    assert.equal(modelOption(updates.at(-1)).currentValue,'eido-fixture/scripted');
    const current = (await settings.status()).customConnections as {id:string;revision:string}[];
    updates.length = 0;
    await settings.execute({operation:'custom-connection',provider:'sr',models:['fixture-model','third-model'],baseUrl:'https://example.invalid/v2',api:'openai-completions',key:'',expectedRevision:current.find(c=>c.id==='sr')!.revision});
    await waitFor(()=>updates.some(options=>JSON.stringify(options).includes('sr/third-model')));
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

test('editing a connection never sends its new key to an old session endpoint', {timeout:15_000}, async () => {
  const {createServer} = await import('node:http');
  const directory = await realpath(await mkdtemp(join(tmpdir(),'eido-connection-destination-')));
  const received: {endpoint:string; key:string|undefined; body:any}[] = [];
  const endpoint = (name:string) => createServer(async (request,response) => {
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
    received.push({endpoint:name,key:request.headers.authorization,body:JSON.parse(Buffer.concat(chunks).toString())});
    response.writeHead(200,{'content-type':'text/event-stream'});
    response.end(`data: ${JSON.stringify({id:'local',object:'chat.completion.chunk',created:1,model:'model',choices:[{index:0,delta:{role:'assistant',content:'Received.'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);
  });
  const oldEndpoint=endpoint('old'),newEndpoint=endpoint('new');
  await new Promise<void>(resolve=>oldEndpoint.listen(0,'127.0.0.1',resolve));
  await new Promise<void>(resolve=>newEndpoint.listen(0,'127.0.0.1',resolve));
  const url=(server:typeof oldEndpoint)=>`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1`;
  await writeFile(join(directory,'settings.json'),JSON.stringify({defaultProvider:'sr',defaultModel:'model',cacheWarming:'off',retry:{enabled:false,provider:{maxRetries:0}},images:{blockImages:true}}));
  const settings=createPiSettings(directory);
  await settings.execute({operation:'custom-connection',provider:'sr',models:['model'],baseUrl:url(oldEndpoint),api:'openai-completions',key:'fixture-old',expectedRevision:null});
  const runtime=await ModelRuntime.create({authPath:join(directory,'auth.json'),modelsPath:join(directory,'models.json'),allowModelNetwork:false});
  const oldModel = runtime.getModel('sr','model')!;
  let holdAuth = false, enterAuth!:()=>void, releaseAuth!:()=>void;
  let interleavedKey: string | undefined;
  const authEntered = new Promise<void>(resolve=>{enterAuth=resolve;});
  const authReleased = new Promise<void>(resolve=>{releaseAuth=resolve;});
  const fixtureResolveAuth = runtime.getAuth.bind(runtime);
  runtime.getAuth = async (model, options) => {
    const held = holdAuth && typeof model !== 'string';
    if (held) { holdAuth=false; enterAuth(); await authReleased; }
    const auth = await (typeof model === 'string' ? fixtureResolveAuth(model, options) : fixtureResolveAuth(model, options));
    if (held) interleavedKey = auth?.auth.apiKey;
    return auth;
  };
  const toAgent=new TransformStream(),toClient=new TransformStream();
  const server=await startEidoAgent(directory,join(directory,'sessions'),{readable:toAgent.readable,writable:toClient.writable},runtime);
  const connection=client({name:'destination-edit-test'}).connect({readable:toClient.readable,writable:toAgent.writable});
  try {
    await connection.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{}});
    const task=await connection.agent.request(methods.agent.session.new,{cwd:directory,mcpServers:[]});
    const send=()=>connection.agent.request(methods.agent.session.prompt,{sessionId:task.sessionId,prompt:[{type:'text',text:'A plain text request'}]});
    await send();
    await settings.execute({operation:'key',provider:'sr',key:'fixture-rotated'});
    await send();
    assert.deepEqual(received.map(r=>[r.endpoint,r.key]),[['old','Bearer fixture-old'],['old','Bearer fixture-rotated']],'Key-only rotation remains usable');
    const state=await settings.status();
    const revision=(state.customConnections as {id:string;revision:string}[]).find(c=>c.id==='sr')!.revision;
    // Pause only after Eido's first destination check, before pi reads credentials.
    holdAuth = true;
    const interleaved = assert.rejects(send(),error=>JSON.stringify(error).includes('This connection changed.'));
    await authEntered;
    await settings.execute({operation:'custom-connection',provider:'sr',models:['model'],baseUrl:url(newEndpoint),api:'openai-completions',key:'fixture-new',expectedRevision:revision});
    releaseAuth();
    await interleaved;
    assert.equal(interleavedKey,'fixture-new','the paused resolution actually read the newly saved credential');
    assert.equal(received.length,2,'the post-resolution check blocks the old-destination/new-key interleaving');
    await assert.rejects(runtime.getAuth(oldModel), /This connection changed/, 'the public auth boundary used by direct summaries also rejects the stale destination');
    await assert.rejects(send(),error=>JSON.stringify(error).includes('This connection changed.'));
    assert.equal(received.length,2,'stale plain-text requests fail before either endpoint receives anything');
    const deadline=Date.now()+4000;
    while(runtime.getModel('sr','model')?.baseUrl!==url(newEndpoint) && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(runtime.getModel('sr','model')?.baseUrl,url(newEndpoint));
    await connection.agent.request(methods.agent.session.setConfigOption,{sessionId:task.sessionId,configId:'model',value:'sr/model'});
    await connection.agent.request(methods.agent.session.prompt,{sessionId:task.sessionId,prompt:[{type:'text',text:'The same ID now uses the saved connection'},
      {type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lpEAAAAASUVORK5CYII='}]});
    assert.deepEqual(received.map(r=>[r.endpoint,r.key]),[['old','Bearer fixture-old'],['old','Bearer fixture-rotated'],['new','Bearer fixture-new']]);
    assert.doesNotMatch(JSON.stringify(received.at(-1)!.body),/image_url|data:image/,'global image blocking remains in force after reselection');
  } finally {
    releaseAuth();
    await server.agent.dispose();connection.close();server.connection.close();
    oldEndpoint.closeAllConnections();newEndpoint.closeAllConnections();oldEndpoint.close();newEndpoint.close();
    await rm(directory,{recursive:true,force:true});
  }
});
