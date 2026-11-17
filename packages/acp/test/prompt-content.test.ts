import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, realpath, writeFile, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {client, methods, type ContentBlock, type SessionUpdate} from '@agentclientprotocol/sdk';
import {preparePromptContent} from '../src/prompt-content.ts';
import {startEidoAgent} from '../src/server.ts';
import {fixtureModel} from './fixture-model.ts';

const png = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGMwyXtAEmIY1TCqYfhqAACJooIQq9u/YAAAAABJRU5ErkJggg==';
const image: ContentBlock = {type: 'image', data: png, mimeType: 'image/png'};
const text = (text: string): ContentBlock => ({type: 'text', text});

test('inline text keeps its source, binary images/text decode, linked resources are not fetched', () => {
  const uri = 'file:///project/unsaved.ts#L2:3';
  const link: ContentBlock = {type: 'resource_link', name: 'Reference', uri: 'https://example.invalid/no-fetch'};
  const blocks: ContentBlock[] = [text('Review'),
    {type: 'resource', resource: {uri, text: 'const current = "unsaved";'}},
    {type: 'resource', resource: {uri: 'file:///image.png', mimeType: 'image/png', blob: png}},
    {type: 'resource', resource: {uri: 'file:///unicode.json', mimeType: 'application/json; charset=utf-8', blob: Buffer.from('{"说明":"当前"}').toString('base64')}}, link];
  const result = preparePromptContent(blocks);
  assert.deepEqual(result[1], text(`Attached resource: ${JSON.stringify(uri)}\nconst current = "unsaved";`));
  assert.deepEqual(result[2], {...image, uri: 'file:///image.png'});
  assert.deepEqual(result[3], text('Attached resource: "file:///unicode.json"\n{"说明":"当前"}'));
  assert.equal(result[4], link);
  assert.equal(blocks[1]!.type, 'resource', 'normalization cannot mutate the original delivery identity');
});

test('unsupported or corrupt attachments fail explicitly instead of becoming missing content', () => {
  for (const [block, error] of [
    [{type: 'audio', data: 'AA==', mimeType: 'audio/wav'}, /audio attachments/],
    [{type: 'resource', resource: {uri: 'file:///file.pdf', mimeType: 'application/pdf', blob: 'AA=='}}, /Convert this file/],
    [{type: 'resource', resource: {uri: 'file:///file.txt', mimeType: 'text/plain', blob: '/w=='}}, /UTF-8/],
    [{...image, data: 'corrupt!'}, /base64/],
    [{...image, mimeType: 'image/svg+xml'}, /PNG, JPEG/],
  ] as [ContentBlock, RegExp][]) assert.throws(() => preparePromptContent([block]), error);
});

test('ACP embeds editor context and passes images through templates, skills, reload and history', {timeout: 30_000}, async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'eido-attachments-')));
  await writeFile(join(cwd, 'settings.json'), JSON.stringify({defaultProvider: 'eido-fixture', defaultModel: 'scripted', images: {autoResize: true}}));
  await mkdir(join(cwd, 'prompts'));
  await writeFile(join(cwd, 'prompts/inspect.md'), 'Inspect attachment: $ARGUMENTS');
  await mkdir(join(cwd, 'skills/picture'), {recursive: true});
  await writeFile(join(cwd, 'skills/picture/SKILL.md'), '---\nname: picture\ndescription: Read the supplied picture\n---\nUse the supplied image.');
  await mkdir(join(cwd, 'extensions'));
  await writeFile(join(cwd, 'extensions/text-command.js'), 'export default pi => pi.registerCommand("text-only", {handler: async () => {throw new Error("Must not lose the image");}});');
  let checked = 0;
  const verify = (context: Parameters<Parameters<typeof fixtureModel>[1][number]>[0]) => {
    const user = context.messages.findLast(message => message.role === 'user');
    assert.ok(user?.role === 'user' && Array.isArray(user.content));
    const images = user.content.filter(part => part.type === 'image');
    const value = user.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    if (checked === 0) {
      assert.match(value, /Inspect attachment: present/);
      assert.match(value, /file:\/\/\/project\/unsaved.ts#L2:3/);
      assert.match(value, /buffer-only-marker/);
    } else if (checked === 1) assert.match(value, /<skill name="picture"/);
    else {assert.equal(images.length, 0); assert.match(value, /Image reading is disabled/);}
    if (checked < 2) {assert.equal(images.length, 1); assert.equal(images[0]!.data, png);}
    checked++;
    return 'Attachment checked.';
  };
  const fixture = await fixtureModel(cwd, [verify, verify, verify]);
  const toAgent = new TransformStream(), toClient = new TransformStream();
  const server = await startEidoAgent(cwd, join(cwd, 'sessions'), {readable: toAgent.readable, writable: toClient.writable}, fixture.runtime);
  const updates: SessionUpdate[] = [];
  const connection = client({name: 'attachment-test'}).onNotification(methods.client.session.update, ({params}) => {updates.push(params.update);})
    .connect({readable: toClient.readable, writable: toAgent.writable});
  try {
    const initialized = await connection.agent.request(methods.agent.initialize, {protocolVersion: 1, clientCapabilities: {}});
    assert.equal(initialized.agentCapabilities?.promptCapabilities?.embeddedContext, true);
    assert.equal(initialized.agentCapabilities?.promptCapabilities?.image, true);
    const task = await connection.agent.request(methods.agent.session.new, {cwd, mcpServers: []});
    const send = (prompt: ContentBlock[], id?: string) => connection.agent.request(methods.agent.session.prompt, {sessionId: task.sessionId, prompt, ...(id ? {_meta: {eidoDeliveryId: id}} : {})});
    const first: ContentBlock[] = [text('/inspect present'), {type: 'resource', resource: {uri: 'file:///project/unsaved.ts#L2:3', text: 'buffer-only-marker', _meta:{eidoReference:{version:1,unsaved:true,summary:false}}}}, image];
    assert.equal((await send(first, 'attachment-delivery')).stopReason, 'end_turn');
    await send(first, 'attachment-delivery');
    assert.equal(checked, 1, 'the original attachment identity prevents duplicate inference');
    assert.equal((await send([text('/skill:picture'), image])).stopReason, 'end_turn');
    await assert.rejects(send([text('/session'), image]));
    await assert.rejects(send([text('/text-only'), image]));
    assert.equal(checked, 2, 'text-only commands cannot silently discard attachments');
    await assert.rejects(send([{type: 'audio', data: 'AA==', mimeType: 'audio/wav'}]), /audio attachments/);
    await connection.agent.request(methods.agent.session.close, {sessionId: task.sessionId});
    updates.length = 0;
    await connection.agent.request(methods.agent.session.load, {sessionId: task.sessionId, cwd, mcpServers: []});
    assert.ok(updates.some(update => update.sessionUpdate === 'user_message_chunk' && update.content.type === 'image' && update.content.data === png));
    assert.match(JSON.stringify(updates), /buffer-only-marker/);
    const restored = updates.filter(update => update.sessionUpdate === 'user_message_chunk' && update.content.type === 'resource');
    assert.equal(restored.length, 1, 'one immutable reference survives history reload without duplicate model calls');
    assert.equal(restored[0]?.sessionUpdate, 'user_message_chunk');
    if (restored[0]?.sessionUpdate === 'user_message_chunk') assert.deepEqual(restored[0].content, first[1]);
    await writeFile(join(cwd, 'settings.json'), JSON.stringify({defaultProvider: 'eido-fixture', defaultModel: 'scripted', images: {blockImages: true, autoResize: false}}));
    await send([text('/reload')]);
    assert.equal((await send([text('Image blocking applies now'), image])).stopReason, 'end_turn');
    assert.equal(checked, 3);
  } finally {await server.agent.dispose(); connection.close(); server.connection.close(); await rm(cwd, {recursive: true, force: true});}
});

test('document descriptors reach the model as metadata without raw PDF bytes',()=>{
  const descriptor={version:1,attachmentId:'selected',originalName:'spec.pdf',mimeType:'application/pdf',size:100,expectedHash:'a'.repeat(64),selectionIdentity:'local-choice'};
  const result=preparePromptContent([{type:'resource',resource:{uri:'eido-document://selected',mimeType:'application/vnd.eido.document+json',text:JSON.stringify(descriptor)}}]);
  assert.equal(result[0]?.type,'text');assert.match((result[0] as {text:string}).text,/document_extract/);assert.doesNotMatch(JSON.stringify(result),/JVBER/);
  assert.throws(()=>preparePromptContent([{type:'resource',resource:{uri:'eido-document://other',mimeType:'application/vnd.eido.document+json',text:JSON.stringify(descriptor)}}]),/identity/);
});

test('custom models send user and tool images through the real compatible protocol without fallback', {timeout:20_000}, async () => {
  const {createServer} = await import('node:http');
  const cwd = await realpath(await mkdtemp(join(tmpdir(),'eido-image-protocol-')));
  let mode = 'tool'; const bodies: any[] = [];
  const http = createServer(async (req,res) => {
    const chunks: Buffer[]=[]; for await(const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    if(mode==='rejected'){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'image_url is unsupported; private-fixture-key',type:'invalid_request_error'}}));return;}
    if(mode==='auth'){res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'invalid api key'}}));return;}
    if(mode==='network'){res.destroy();return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    const delta = mode==='tool' ? {role:'assistant',tool_calls:[{index:0,id:'screenshot-call',type:'function',function:{name:'fixture_screenshot',arguments:'{}'}}]} : {role:'assistant',content:'Images received.'};
    res.write(`data: ${JSON.stringify({id:'local',object:'chat.completion.chunk',created:1,model:'sr-image',choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
    res.write(`data: ${JSON.stringify({id:'local',object:'chat.completion.chunk',created:1,model:'sr-image',choices:[{index:0,delta:{},finish_reason:mode==='tool'?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:3,total_tokens:23}})}\n\n`);
    res.end('data: [DONE]\n\n'); if(mode==='tool')mode='ok';
  });
  await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
  const settings = {defaultProvider:'sr',defaultModel:'sr-image',cacheWarming:'off',images:{autoResize:false},retry:{enabled:false,provider:{maxRetries:0}},defaultTools:['fixture_screenshot'],eido:{fullAccess:true}};
  await writeFile(join(cwd,'settings.json'),JSON.stringify(settings));
  await writeFile(join(cwd,'models.json'),JSON.stringify({providers:{sr:{baseUrl:`http://127.0.0.1:${(http.address() as import('node:net').AddressInfo).port}/v1`,api:'openai-completions',models:[{id:'sr-image'}]}}}));
  await writeFile(join(cwd,'auth.json'),JSON.stringify({sr:{type:'api_key',key:'private-fixture-key'}}));
  await mkdir(join(cwd,'extensions'));
  await writeFile(join(cwd,'extensions/screenshot.js'),`export default pi => pi.registerTool({name:'fixture_screenshot',label:'Screenshot fixture',description:'Return a local screenshot',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'image',mimeType:'image/png',data:${JSON.stringify(png)}}]})});`);
  const toAgent=new TransformStream(),toClient=new TransformStream();
  const server=await startEidoAgent(cwd,join(cwd,'sessions'),{readable:toAgent.readable,writable:toClient.writable});
  const connection=client({name:'image-protocol-test'}).connect({readable:toClient.readable,writable:toAgent.writable});
  try {
    await connection.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{}});
    const task=await connection.agent.request(methods.agent.session.new,{cwd,mcpServers:[]});
    const send=(prompt:ContentBlock[])=>connection.agent.request(methods.agent.session.prompt,{sessionId:task.sessionId,prompt});
    assert.equal((await send([text('Inspect this image and take a screenshot'),image])).stopReason,'end_turn');
    assert.equal(bodies.length,2);
    const wireImages=(body:any)=>body.messages.flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).filter((part:any)=>part.type==='image_url');
    assert.equal(wireImages(bodies[0]).length,1,'the real pi OpenAI serializer retains the user image');
    assert.equal(wireImages(bodies[1]).length,2,'tool screenshot and user image both reach the next request');
    assert.ok(wireImages(bodies[1]).every((part:any)=>part.image_url.url.includes(png)));
    for(mode of ['rejected','auth','network']) {
      const before: number=bodies.length;
      await assert.rejects(send([text('Try this image'),image]),error=>{
        const details=JSON.stringify(error);
        assert.doesNotMatch(details,/private-fixture-key/);
        if(mode==='rejected')assert.match(details,/rejected image input/);
        return true;
      });
      assert.equal(bodies.length,before+1,'errors do not trigger a text-only retry or model fallback');
    }
    mode='ok';await send([text('Images still enabled'),image]);
    assert.ok(wireImages(bodies.at(-1)).length>0,'failures do not change the image policy');
    await writeFile(join(cwd,'settings.json'),JSON.stringify({...settings,images:{autoResize:false,blockImages:true}}));
    await send([text('/reload')]);
    await send([text('Images are now blocked'),image]);
    assert.equal(wireImages(bodies.at(-1)).length,0,'global blockImages removes image bytes from the actual request');
  } finally {await server.agent.dispose();connection.close();server.connection.close();http.closeAllConnections();http.close();await rm(cwd,{recursive:true,force:true});}
});
