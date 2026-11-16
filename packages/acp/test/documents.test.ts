import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,realpath,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {client,methods,type ContentBlock} from '@agentclientprotocol/sdk';
import {fixtureModel,call,lastToolText,type FixtureStep} from './fixture-model.ts';
import {startEidoAgent} from '../src/server.ts';
import {ResearchStore,sha256} from '../../runtime/src/research/store.mjs';
import {ResearchUsage} from '../../runtime/src/research/usage.mjs';
import type {DocumentDescriptor} from '../src/documents.ts';

async function harness(t:any,steps:FixtureStep[],handler:(request:number)=>unknown,{pageCount=3,repeatedPages=false}={}) {
  const directory=await realpath(await mkdtemp(join(tmpdir(),'eido-document-acp-')));let calls=0;
  const http=createServer(async(req,res)=>{for await(const _ of req){}calls++;const result=handler(calls);if(result===null){res.destroy();return;}res.end('\n'+JSON.stringify(result));});
  await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
  const address=http.address() as {port:number};
  await writeFile(join(directory,'settings.json'),JSON.stringify({defaultProvider:'eido-fixture',defaultModel:'scripted',compaction:{enabled:false},eido:{research:{schemaVersion:1,enabled:true,revision:1,baseUrl:`http://127.0.0.1:${address.port}/v1`}}}));
  const original=Buffer.from('%PDF-1.4 self-created transport fixture'),png=Buffer.from([137,80,78,71,13,10,26,10,...Buffer.from('local png transport fixture')]);
  const descriptor:DocumentDescriptor={version:1,attachmentId:'document-fixture',originalName:'fixture.pdf',mimeType:'application/pdf',size:original.length,expectedHash:sha256(original),selectionIdentity:'selected-fixture'};
  const captures=new Map<string,{hash:string;bytes:Buffer;session:string;turn:string}>();let nativeCalls=0;
  const fixture=await fixtureModel(directory,steps);
  fixture.runtime.registerProvider('deepseek',{api:'openai-completions',baseUrl:'https://api.deepseek.com/v1',apiKey:'transport-test-credential'});
  const toAgent=new TransformStream(),toClient=new TransformStream();
  const server=await startEidoAgent(directory,join(directory,'sessions'),{readable:toAgent.readable,writable:toClient.writable},fixture.runtime);
  const native=({params}:any)=>{
    nativeCalls++;assert.equal(params.version,1);assert.equal(params.selectionIdentity,descriptor.selectionIdentity);assert.ok(params.turnId);assert.ok(params.sessionId);
    if(params.action==='open'){assert.equal(params.attachmentId,descriptor.attachmentId);captures.set('original',{hash:descriptor.expectedHash,bytes:original,session:params.sessionId,turn:params.turnId});return {version:1,handle:'original',descriptor,chunkBytes:262144};}
    const capture=captures.get(params.handle);assert.ok(capture);assert.equal(params.expectedHash,capture.hash);assert.equal(params.sessionId,capture.session);assert.equal(params.turnId,capture.turn);
    if(params.action==='release'){captures.delete(params.handle);return {released:true};}
    if(params.action==='render'){const bytes=Buffer.concat([png,Buffer.from(repeatedPages?'same':String(params.pageIndex))]),hash=sha256(bytes),handle=`page-${params.pageIndex}`;captures.set(handle,{...capture,bytes,hash});return {version:1,handle,size:bytes.length,manifest:{pageIndex:params.pageIndex,pageCount,renderWidth:100,renderHeight:200,renderVersion:'eido-canonical-1',pngHash:hash}};}
    assert.equal(params.action,'chunk');return {version:1,offset:params.offset,total:capture.bytes.length,hash:capture.hash,content:capture.bytes.toString('base64'),next:null};
  };
  const connection=client({name:'document-transport-fixture'}).onRequest('_eido/documents/snapshot',{parse:raw=>raw},native).onRequest('_eido/documents/render',{parse:raw=>raw},native)
    .onNotification(methods.client.session.update,()=>{}).onRequest(methods.client.session.requestPermission,()=>({outcome:{outcome:'selected',optionId:'allow_once'}}))
    .connect({readable:toClient.readable,writable:toAgent.writable});
  await connection.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{_meta:{eidoDocuments:1,eidoResearch:1}}});
  const task=await connection.agent.request(methods.agent.session.new,{cwd:directory,mcpServers:[]});
  const attachment:ContentBlock={type:'resource',resource:{uri:`eido-document://${descriptor.attachmentId}`,mimeType:'application/vnd.eido.document+json',text:JSON.stringify(descriptor)}};
  t.after(async()=>{await server.agent.dispose();connection.close();server.connection.close();http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));await rm(directory,{recursive:true,force:true});});
  return {directory,task,connection,fixture,descriptor,captures,calls:()=>calls,nativeCalls:()=>nativeCalls,prompt:()=>connection.agent.request(methods.agent.session.prompt,{sessionId:task.sessionId,prompt:[{type:'text',text:'Extract the attached public test document.'},attachment]})};
}
const response=(text:string)=>({page_count:1,pages:[{index:0,text:`<｜ref｜>${text}<｜/ref｜><｜box｜>[[10,20,900,800]]<｜/box｜>`,finish_reason:'stop'}]});
test('real ACP document bridge saves each page and reuses immutable renditions without extra OCR',async t=>{
  let version='';
  const f=await harness(t,[
    ()=>call('mcp__eido_research__document_extract',{attachmentId:'document-fixture'}),
    context=>{const result=JSON.parse(lastToolText(context,'mcp__eido_research__document_extract').split('\n')[0]!);assert.equal(result.status,'complete');assert.equal(result.pages.length,3);version=result.source.versionId;return 'Extracted.';},
    ()=>call('mcp__eido_research__document_extract',{attachmentId:'document-fixture'}),
    context=>{const result=JSON.parse(lastToolText(context,'mcp__eido_research__document_extract').split('\n')[0]!);assert.ok(result.pages.every((p:any)=>p.reused));return 'Reused saved pages.';},
  ],n=>response(`Page ${n} text 😀`));
  assert.equal((await f.prompt()).stopReason,'end_turn');assert.equal(f.calls(),3);assert.equal(f.captures.size,0);
  const store=new ResearchStore({directory:f.directory,sessionId:f.task.sessionId});assert.match((await store.read(version)).text,/Page 3 text 😀/);
  const citation=await store.cite(version,'Page 2 text 😀');assert.equal(citation.matchState,'exact');assert.equal(citation.regions?.[0]?.pageIndex,1);
  assert.equal((await f.prompt()).stopReason,'end_turn');assert.equal(f.calls(),3);assert.equal(f.captures.size,0);
  const usage=await new ResearchUsage(f.directory).summary(f.task.sessionId);assert.equal(usage.task?.ocrPages,3);assert.equal(f.fixture.requests(),4);
  const manifest=await store.manifest();assert.equal(manifest.extractions.length,2);assert.ok(manifest.sources.every(source=>source.ownerSession===f.task.sessionId));
});
test('unknown OCR preserves completed pages and does not automatically re-upload on a later extraction',async t=>{
  const f=await harness(t,[
    ()=>call('mcp__eido_research__document_extract',{attachmentId:'document-fixture'}),
    context=>{const result=JSON.parse(lastToolText(context,'mcp__eido_research__document_extract').split('\n')[0]!);assert.equal(result.status,'partial');assert.deepEqual(result.missingPages,[1,2]);return 'Partial.';},
    ()=>call('mcp__eido_research__document_extract',{attachmentId:'document-fixture'}),
    context=>{const result=JSON.parse(lastToolText(context,'mcp__eido_research__document_extract').split('\n')[0]!);assert.equal(result.status,'partial');assert.equal(result.pages[0]!.reused,true);return 'Explicit retry required.';},
  ],n=>n===1?response('Completed first page'):null);
  await f.prompt();assert.equal(f.calls(),2);await f.prompt();assert.equal(f.calls(),2);
  const usage=await new ResearchUsage(f.directory).summary();assert.equal(usage.global.unknown,1);
  const manifest=await new ResearchStore({directory:f.directory,sessionId:f.task.sessionId}).manifest();assert.equal(manifest.extractions[0]!.status,'partial');assert.equal(manifest.extractions[0]!.pages[0]!.status,'complete');assert.equal(manifest.extractions[0]!.pages[1]!.status,'interrupted_unknown');
});


test('an unsubmitted descriptor cannot authorize native document reads',async t=>{
  const f=await harness(t,[
    ()=>call('mcp__eido_research__document_extract',{attachmentId:'never-submitted'}),
    context=>{const result=context.messages.findLast(m=>m.role==='toolResult');assert.ok(result&&result.role==='toolResult'&&result.isError);assert.match(JSON.stringify(result.content),/unsubmitted_document/);return 'Attachment required.';},
  ],()=>response('must never dispatch'));
  await f.prompt();assert.equal(f.calls(),0);assert.equal(f.nativeCalls(),0);
});


for(const split of [false,true])test(`identical PNG pages reuse OCR and cite the target page (${split?'separate ranges':'one extraction'})`,async t=>{
  const versions:string[]=[];
  const extract=(pages?:number[])=>()=>call('mcp__eido_research__document_extract',{attachmentId:'document-fixture',...(pages?{pages}:{})});
  const save=(context:any)=>{const result=JSON.parse(lastToolText(context,'mcp__eido_research__document_extract'));assert.equal(result.status,'complete');versions.push(result.source.versionId);return 'Saved.';};
  const f=await harness(t,split?[extract([0]),save,extract([1]),save]:[extract(),save],()=>response('Repeated text'),{pageCount:2,repeatedPages:true});
  await f.prompt();if(split)await f.prompt();
  assert.equal(f.calls(),1,'identical canonical images incur only one OCR request');
  const store=new ResearchStore({directory:f.directory,sessionId:f.task.sessionId});
  const start=split?0:Buffer.byteLength('Repeated text\n');
  const citation=await store.cite(versions.at(-1)!,'Repeated text',[start,start+Buffer.byteLength('Repeated text')]);
  assert.equal(citation.matchState,'exact');assert.equal(citation.regions?.[0]?.pageIndex,1);assert.deepEqual(citation.regions?.[0]?.refIds,['page-1-ref-0']);
  const first=await store.cite(versions[0]!,'Repeated text',[0,Buffer.byteLength('Repeated text')]);
  assert.equal(first.regions?.[0]?.pageIndex,0);assert.deepEqual(first.regions?.[0]?.refIds,['page-0-ref-0']);
  const manifest=await store.manifest(),pages=manifest.extractions.at(-1)!.pages;assert.equal(pages.find(p=>p.pageIndex===1)?.reused,true);assert.equal(f.captures.size,0);
});


test('HTTP 200 OCR service error before any extracted page is a failed tool result',async t=>{
  let observed:any;
  const f=await harness(t,[
    ()=>call('mcp__eido_research__document_extract',{attachmentId:'document-fixture'}),
    context=>{observed=context.messages.findLast(m=>m.role==='toolResult');return 'The service failed before extracting text.';},
  ],()=>({error:{message:'private-upstream-detail'}}));
  await f.prompt();
  assert.equal(f.calls(),1,'a service error must not automatically retry OCR');
  assert.equal(f.captures.size,0);
  assert.doesNotMatch(JSON.stringify(observed.content),/private-upstream-detail/);
  const manifest=await new ResearchStore({directory:f.directory,sessionId:f.task.sessionId}).manifest();
  const extraction=manifest.extractions[0]!;
  assert.equal(extraction.pages.filter(p=>p.status==='complete'||p.status==='partial').length,0);
  assert.equal(extraction.pages[0]?.status,'failed');
  assert.deepEqual(extraction.missingPages,[0,1,2]);
  const usage=await new ResearchUsage(f.directory).summary(f.task.sessionId);
  assert.equal(usage.task?.attempts,1);assert.equal(usage.task?.successful,0);
  const result=JSON.parse(observed.content.map((c:any)=>c.text??'').join('\n'));
  t.diagnostic(JSON.stringify({extractionStatus:extraction.status,modelStatus:result.status,sourceReadState:result.source?.readState,isError:observed.isError,extractedPages:extraction.pages.filter(p=>p.status==='complete'||p.status==='partial').length,error:result.error}));
  assert.deepEqual({extractionStatus:extraction.status,modelStatus:result.status,isError:observed.isError},{extractionStatus:'failed',modelStatus:'failed',isError:true},'zero extracted pages must report failure to persistence and the model');
  assert.equal(result.source.readState,'failed');
});

test('HTTP 200 OCR service error after a completed page preserves a partial extraction',async t=>{
  let observed:any;
  const f=await harness(t,[
    ()=>call('mcp__eido_research__document_extract',{attachmentId:'document-fixture'}),
    context=>{observed=JSON.parse(lastToolText(context,'mcp__eido_research__document_extract'));return 'One page remains available.';},
  ],n=>n===1?response('Saved first page'):({error:{message:'service unavailable'}}));
  await f.prompt();assert.equal(f.calls(),2);assert.equal(f.captures.size,0);
  assert.equal(observed.status,'partial');assert.deepEqual(observed.missingPages,[1,2]);
  const store=new ResearchStore({directory:f.directory,sessionId:f.task.sessionId});
  assert.match((await store.read(observed.source.versionId)).text,/Saved first page/);
  const manifest=await store.manifest();assert.equal(manifest.extractions[0]?.pages[0]?.status,'complete');
  assert.equal(manifest.extractions[0]?.pages[1]?.status,'failed');
});


test('zero-page unknown OCR remains unknown with an error result and no implicit retry',async t=>{
  let observed:any;
  const f=await harness(t,[()=>call('mcp__eido_research__document_extract',{attachmentId:'document-fixture'}),context=>{observed=context.messages.findLast(m=>m.role==='toolResult');return 'No OCR result was received.';}],()=>null);
  await f.prompt();assert.equal(f.calls(),1);assert.equal(f.captures.size,0);
  const result=JSON.parse(observed.content.map((c:any)=>c.text??'').join('\n'));
  assert.equal(result.status,'interrupted_unknown');assert.equal(result.source.readState,'failed');assert.equal(observed.isError,true);
  const store=new ResearchStore({directory:f.directory,sessionId:f.task.sessionId});
  assert.equal((await store.manifest()).extractions[0]!.status,'interrupted_unknown');
  assert.equal((await new ResearchUsage(f.directory).summary()).global.unknown,1);
});

for(const [text,finishReason,expected] of [['Useful fragment','length','partial'],['','length','failed'],['   ','length','failed'],['','stop','complete']] as const){
  test(`OCR ${finishReason} with ${text.length} characters reports ${expected}`,async t=>{
    let observed:any;
    const f=await harness(t,[()=>call('mcp__eido_research__document_extract',{attachmentId:'document-fixture'}),context=>{observed=context.messages.findLast(m=>m.role==='toolResult');return 'Recorded page outcome.';}],()=>({page_count:1,pages:[{index:0,text,finish_reason:finishReason}]}),{pageCount:1});
    await f.prompt();assert.equal(f.calls(),1);assert.equal(f.captures.size,0);
    const result=JSON.parse(observed.content.map((c:any)=>c.text??'').join('\n'));
    assert.equal(result.status,expected);assert.equal(result.source.readState,expected==='complete'?'read':expected);
    assert.equal(observed.isError,expected==='failed');
    const store=new ResearchStore({directory:f.directory,sessionId:f.task.sessionId}),manifest=await store.manifest();
    assert.equal(manifest.extractions[0]!.status,expected);assert.equal(manifest.extractions[0]!.pages[0]!.status,finishReason==='stop'?'complete':'partial');
    assert.equal((await store.read(result.source.versionId)).text,text+'\n','the accepted partial or blank page bytes remain available');
  });
}

for(const cancelBeforePage of [0,1])test(`local cancellation before page ${cancelBeforePage} preserves actual completed work`,async()=>{
  const {ResearchSession}=await import('../src/research.ts');
  const directory=await mkdtemp(join(tmpdir(),'eido-document-cancel-'));
  const original=Buffer.from('%PDF-cancellation-fixture'),png=Buffer.from([137,80,78,71,13,10,26,10]);
  const descriptor:DocumentDescriptor={version:1,attachmentId:'selected',selectionIdentity:'local-selection',originalName:'cancel.pdf',mimeType:'application/pdf',size:original.length,expectedHash:sha256(original)};
  const controller=new AbortController();let ocrCalls=0;
  const native=async(_method:string,request:any)=>{
    if(request.action==='release')return {released:true};
    if(request.action==='open')return {version:1,handle:'original',descriptor};
    if(request.action==='render'){
      if(request.pageIndex===cancelBeforePage)controller.abort();
      return {version:1,handle:`page-${request.pageIndex}`,size:png.length,manifest:{pageIndex:request.pageIndex,pageCount:2,renderWidth:10,renderHeight:10,renderVersion:'eido-canonical-1',pngHash:sha256(png)}};
    }
    const bytes=request.handle==='original'?original:png;
    return {version:1,offset:0,total:bytes.length,hash:sha256(bytes),content:bytes.toString('base64'),next:null};
  };
  const session=new ResearchSession(directory,{sessionId:'owner',cwd:directory,getTurnId:()=> 'actual-turn',getPi:()=>undefined,client:{request:native}} as any);
  session.client.request=async()=>{ocrCalls++;const data=response('Saved first page');return {data,raw:Buffer.from(JSON.stringify(data)),attempts:[],partial:false,config:await (await import('../../runtime/src/research/config.mjs')).readResearchConfig(directory)};};
  try{
    await session.submit([descriptor],[]);
    const result=await session.remote('document_extract',{attachmentId:descriptor.attachmentId},controller.signal,'cancel-tool');
    const value=JSON.parse((result.content[0] as any).text),expected=cancelBeforePage===0?'cancelled_local':'partial';
    assert.equal(value.status,expected);assert.equal(value.source.readState,cancelBeforePage===0?'failed':'partial');assert.equal(result.isError,cancelBeforePage===0);assert.equal(ocrCalls,cancelBeforePage);
    assert.equal((await session.store.manifest()).extractions[0]!.status,expected);
    if(cancelBeforePage===1)assert.match((await session.store.read(value.source.versionId)).text,/Saved first page/);
    const replay=await session.remote('document_extract',{attachmentId:descriptor.attachmentId},new AbortController().signal,'cancel-tool');
    assert.equal(replay.isError,cancelBeforePage===0);assert.equal(ocrCalls,cancelBeforePage,'restoring the operation must not issue another OCR request');
  }finally{await session.finishTurn();await rm(directory,{recursive:true,force:true});}
});

for(const boundary of ['reserved page 0','reserved page 1','dispatched cancellation','dispatched disconnect'])test(`real OCR client: ${boundary} preserves recovery and continuation rules`,async t=>{
  const {ResearchSession}=await import('../src/research.ts');
  const directory=await mkdtemp(join(tmpdir(),'eido-document-reservation-'));
  const controller=new AbortController(),local=boundary.startsWith('reserved'),pageCount=boundary==='reserved page 1'?2:1;
  let requests=0,progress=0;
  const http=createServer(async(req,res)=>{
    for await(const _ of req){}requests++;
    if(boundary==='dispatched cancellation'){controller.abort();return;}
    if(boundary==='dispatched disconnect'){res.destroy();return;}
    res.end(JSON.stringify(response(`Saved page ${requests}`)));
  });
  await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));await rm(directory,{recursive:true,force:true});});
  await writeFile(join(directory,'settings.json'),JSON.stringify({eido:{research:{schemaVersion:1,enabled:true,revision:1,baseUrl:`http://127.0.0.1:${(http.address() as {port:number}).port}/v1`}}}));
  const original=Buffer.from('%PDF-reservation-fixture'),png=(page:number)=>Buffer.from([137,80,78,71,13,10,26,10,page]);
  const descriptor:DocumentDescriptor={version:1,attachmentId:'selected',selectionIdentity:'local-selection',originalName:'reserve.pdf',mimeType:'application/pdf',size:original.length,expectedHash:sha256(original)};
  const native=async(_method:string,request:any)=>{
    if(request.action==='release')return {released:true};
    if(request.action==='open')return {version:1,handle:'original',descriptor};
    if(request.action==='render')return {version:1,handle:`${request.pageIndex}`,size:png(request.pageIndex).length,manifest:{pageIndex:request.pageIndex,pageCount,renderWidth:10,renderHeight:10,renderVersion:'eido-canonical-1',pngHash:sha256(png(request.pageIndex))}};
    const bytes=request.handle==='original'?original:png(Number(request.handle));
    return {version:1,offset:0,total:bytes.length,hash:sha256(bytes),content:bytes.toString('base64'),next:null};
  };
  const session=new ResearchSession(directory,{sessionId:'owner',cwd:directory,getTurnId:()=> 'actual-turn',getPi:()=>undefined,client:{request:native},modelRuntime:{getAuth:async()=>({auth:{apiKey:'local-fixture-token'}}),settleCredentialWrites:async()=>{}}} as any);
  try{
    await session.submit([descriptor],[]);
    const args={attachmentId:descriptor.attachmentId},expected=local?(pageCount===1?'cancelled_local':'partial'):'interrupted_unknown';
    const result=await session.remote('document_extract',args,controller.signal,'first',()=>{progress++;if(local&&progress===(pageCount-1)*2+1)controller.abort();});
    const value=JSON.parse((result.content[0] as any).text),manifest=await session.store.manifest();
    assert.equal(value.status,expected);assert.equal(result.isError,expected!=='partial');assert.equal(value.source.readState,expected==='partial'?'partial':'failed');
    assert.equal(manifest.operations[0]!.status,expected);assert.equal(manifest.extractions[0]!.status,expected);
    assert.equal(manifest.extractions[0]!.pages.at(-1)!.status,local?'cancelled_local':'interrupted_unknown');
    assert.equal(requests,local?pageCount-1:1);
    const ledger=JSON.parse(await readFile(join(directory,'research/v1/usage.json'),'utf8')),attempt=ledger.attempts.at(-1);
    assert.equal(ledger.attempts.length,pageCount);assert.equal(attempt.status,local?'cancelled_local':'interrupted_unknown');assert.equal(attempt.billingState,local?'not_dispatched':'unknown');assert.equal(Boolean(attempt.dispatchedAt),!local);
    const usage=await session.usage.summary();assert.equal(usage.global.attempts,requests);assert.equal(usage.global.unknown,local?0:1);assert.equal(usage.global.estimatedCny,local?(pageCount-1)*.0015:0);assert.equal(usage.global.unknownMaximumCny,local?null:.0015);assert.equal(usage.global.uploadedBytes,requests*png(0).length);
    if(pageCount===2)assert.match((await session.store.read(value.source.versionId)).text,/Saved page 1/);
    const restored=await session.remote('document_extract',args,new AbortController().signal,'first');
    assert.equal(JSON.parse((restored.content[0] as any).text).status,expected);assert.equal(restored.isError,expected!=='partial');assert.equal(requests,local?pageCount-1:1,'same operation never replays the request');
    const continued=await session.remote('document_extract',args,new AbortController().signal,'new-operation');
    const next=JSON.parse((continued.content[0] as any).text);
    assert.equal(next.status,local?'complete':'interrupted_unknown');assert.equal(continued.isError,!local);assert.equal(requests,local?pageCount:1,'only never-dispatched pages can continue without reextract');
    if(local){assert.equal(next.source.readState,'read');assert.equal((await session.usage.summary()).global.unknown,0);if(pageCount===2)assert.equal(next.pages[0].reused,true);}
  }finally{await session.finishTurn();}
});
