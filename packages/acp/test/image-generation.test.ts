import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {mkdtemp, readFile, writeFile, rm, realpath, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {client, methods} from '@agentclientprotocol/sdk';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {startEidoAgent} from '../src/server.ts';
import {fixtureModel, type FixtureStep} from './fixture-model.ts';
import {createPiSettings} from '../../runtime/src/pi/settings.mjs';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lpEAAAAASUVORK5CYII=';
async function fixture(steps:FixtureStep[]=[]) {
  const directory=await realpath(await mkdtemp(join(tmpdir(),'eido-image-generation-')));
  const requests:{url:string;key:string|undefined;body:any}[]=[];
  let respond=(request:IncomingMessage,response:ServerResponse)=>{response.setHeader('content-type','application/json');response.end(JSON.stringify({data:[{b64_json:png}]}));};
  const http=createServer(async(request,response)=>{
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
    requests.push({url:request.url!,key:request.headers.authorization,body:JSON.parse(Buffer.concat(chunks).toString())});
    respond(request,response);
  });
  await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
  const baseUrl=`http://127.0.0.1:${(http.address() as import('node:net').AddressInfo).port}/v1`;
  await writeFile(join(directory,'settings.json'),JSON.stringify({defaultProvider:'eido-fixture',defaultModel:'scripted',defaultTools:['generate_image'],cacheWarming:'off',retry:{enabled:false,provider:{maxRetries:0}}}));
  const settings=createPiSettings(directory);
  await settings.execute({operation:'custom-connection',provider:'sr',models:['gpt-image-2.5-sunburst','ordinary-chat'],baseUrl,api:'openai-completions',key:'fixture-image-key',expectedRevision:null});
  const runtime=await ModelRuntime.create({authPath:join(directory,'auth.json'),modelsPath:join(directory,'models.json'),allowModelNetwork:false});
  const scripted=await fixtureModel(directory,steps,{runtime});
  const incoming=new TransformStream(),outgoing=new TransformStream();
  const server=await startEidoAgent(directory,join(directory,'sessions'),{readable:incoming.readable,writable:outgoing.writable},runtime);
  const updates:any[]=[];
  const connection=client({name:'image-test'})
    .onNotification(methods.client.session.update,({params})=>{updates.push(params.update);})
    .onRequest(methods.client.session.requestPermission,()=>({outcome:{outcome:'selected',optionId:'allow_once'}}))
    .connect({readable:outgoing.readable,writable:incoming.writable});
  await connection.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{}});
  const task=await connection.agent.request(methods.agent.session.new,{cwd:directory,mcpServers:[]});
  const send=(text:string,id?:string)=>connection.agent.request(methods.agent.session.prompt,{sessionId:task.sessionId,prompt:[{type:'text',text}],...(id?{_meta:{eidoDeliveryId:id}}:{})});
  const select=(value:string)=>connection.agent.request(methods.agent.session.setConfigOption,{sessionId:task.sessionId,configId:'model',value});
  return {directory,settings,runtime,scripted,requests,updates,connection,server,task,send,select,respond:(next:typeof respond)=>{respond=next;},
    async close(){await server.agent.dispose();connection.close();server.connection.close();http.closeAllConnections();http.close();await rm(directory,{recursive:true,force:true});}};
}

test('direct images save, replay offline, deduplicate deliveries and preserve configured chat choices', {timeout:20_000},async()=>{
  const f=await fixture();try {
    const original=JSON.parse(await readFile(join(f.directory,'models.json'),'utf8'));
    await f.select('sr/gpt-image-2.5-sunburst');
    assert.equal((await f.send('A raccoon in a garden','direct-image')).stopReason,'end_turn');
    assert.deepEqual(f.requests,[{url:'/v1/images/generations',key:'Bearer fixture-image-key',body:{model:'gpt-image-2.5-sunburst',prompt:'A raccoon in a garden',n:1}}]);
    assert.equal(f.scripted.requests(),0);
    const rendered=f.updates.find(update=>update.sessionUpdate==='agent_message_chunk'&&update.content.type==='image');
    assert.equal(rendered.content.data,png);
    const text=f.updates.find(update=>update.sessionUpdate==='agent_message_chunk'&&update.content.text?.startsWith('Saved image:')).content.text;
    const path=/Saved image: \[([^\]]+)\]/.exec(text)![1]!;
    assert.equal((await readFile(path)).toString('base64'),png);
    assert.equal((await stat(path)).mode&0o777,0o600);
    await f.send('A raccoon in a garden','direct-image');assert.equal(f.requests.length,1);
    await f.connection.agent.request(methods.agent.session.close,{sessionId:f.task.sessionId});
    f.updates.length=0;
    await f.connection.agent.request(methods.agent.session.load,{sessionId:f.task.sessionId,cwd:f.directory,mcpServers:[]});
    assert.ok(f.updates.some(update=>update.sessionUpdate==='agent_message_chunk'&&update.content.type==='image'&&update.content.data===png));
    assert.ok(f.updates.some(update=>update.sessionUpdate==='user_message_chunk'&&update.content.text==='A raccoon in a garden'));
    assert.equal(f.requests.length,1,'history never regenerates images');
    await f.select('eido-fixture/scripted');assert.equal((await f.send('Continue chatting')).stopReason,'end_turn');
    assert.equal(f.scripted.requests(),1);
    assert.deepEqual(JSON.parse(await readFile(join(f.directory,'models.json'),'utf8')),original);
  } finally {await f.close();}
});

test('main model calls generate_image, receives its image and continues without changing models or repeating delivery', {timeout:20_000},async()=>{
  const f=await fixture([
    ()=>[{type:'toolCall',id:'one-image-call',name:'generate_image',arguments:{prompt:'A tiny raccoon'}}],
    context=>{
      const image=context.messages.findLast(message=>message.role==='toolResult'&&message.toolName==='generate_image');
      assert.ok(image&&image.role==='toolResult'&&!image.isError);
      assert.ok(image.content.some(item=>item.type==='image'&&item.data===png));
      assert.ok(image.content.some(item=>item.type==='text'&&item.text.includes('Saved image:')));
      return 'The image is ready; I can continue our conversation.';
    },
  ]);try {
    assert.equal((await f.send('Please create a tiny raccoon and continue','tool-image')).stopReason,'end_turn');
    assert.equal(f.requests.length,1);assert.equal(f.scripted.requests(),2);
    assert.ok(f.updates.some(update=>update.sessionUpdate==='agent_message_chunk'&&update.content.text?.includes('I can continue')));
    assert.ok(f.updates.some(update=>update.sessionUpdate==='tool_call_update'&&update.status==='completed'&&JSON.stringify(update).includes('image/png')));
    await f.send('Please create a tiny raccoon and continue','tool-image');
    assert.equal(f.requests.length,1);assert.equal(f.scripted.requests(),2);
    const loaded=await f.connection.agent.request(methods.agent.session.setConfigOption,{sessionId:f.task.sessionId,configId:'model',value:'eido-fixture/scripted'});
    assert.equal(loaded.configOptions.find(option=>option.id==='model')?.currentValue,'eido-fixture/scripted');
  }finally{await f.close();}
});

test('image failures and cancellation never retry, redact provider output, reject steering and allow chat recovery', {timeout:20_000},async()=>{
  const f=await fixture();try {
    await f.select('sr/gpt-image-2.5-sunburst');
    await assert.rejects(f.connection.agent.request(methods.agent.session.prompt,{sessionId:f.task.sessionId,prompt:[
      {type:'text',text:'Generate from attached private context'},
      {type:'resource',resource:{uri:'file:///private.txt',mimeType:'text/plain',text:'PRIVATE FILE CONTENT'}},
    ]}));
    assert.equal(f.requests.length,0,'converted private attachments must never reach the image endpoint');
    for(const status of [401,429,400]) {
      f.respond((_request,response)=>{response.writeHead(status);response.end('PRIVATE fixture-image-key https://private.invalid/?token=secret');});
      let error:unknown;try{await f.send('Generate',`failed-${status}`);}catch(e){error=e;}
      assert.ok(error);assert.match(JSON.stringify(error),new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(JSON.stringify(error),/PRIVATE|fixture-image-key|private.invalid|token=secret/);
      await assert.rejects(f.send('Generate',`failed-${status}`));
    }
    assert.equal(f.requests.length,3);
    f.respond((_request,response)=>{response.end(JSON.stringify({data:[{b64_json:'bm90LWltYWdl'}]}));});
    await assert.rejects(f.send('Bad image'));assert.equal(f.requests.length,4);
    let entered!:()=>void;const inRequest=new Promise<void>(resolve=>{entered=resolve;});
    f.respond(()=>{entered();});
    const pending=f.send('Wait for image','cancel-image');await inRequest;
    await assert.rejects(f.connection.agent.request('_session/steering',{sessionId:f.task.sessionId,prompt:[{type:'text',text:'Must not become hidden input'}]}));
    await f.connection.agent.notify(methods.agent.session.cancel,{sessionId:f.task.sessionId});
    assert.equal((await pending).stopReason,'cancelled');assert.equal(f.requests.length,5);
    await f.select('eido-fixture/scripted');assert.equal((await f.send('Recover in chat')).stopReason,'end_turn');
    assert.equal(f.scripted.requests(),1);
  }finally{await f.close();}
});

test('saved connection edits block a stale image destination before any request', {timeout:20_000},async()=>{
  const f=await fixture();try {
    await f.select('sr/gpt-image-2.5-sunburst');
    const state=await f.settings.status(),revision=(state.customConnections as {id:string;revision:string}[]).find(item=>item.id==='sr')!.revision;
    await f.settings.execute({operation:'custom-connection',provider:'sr',models:['gpt-image-2.5-sunburst','ordinary-chat'],baseUrl:'http://127.0.0.1:9/v1',api:'openai-completions',key:'fixture-new-key',expectedRevision:revision});
    await assert.rejects(f.send('Stale endpoint'));
    assert.equal(f.requests.length,0);
  }finally{await f.close();}
});
