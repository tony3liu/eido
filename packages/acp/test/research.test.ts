import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,realpath,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {client,methods,type SessionUpdate} from '@agentclientprotocol/sdk';
import {fixtureModel,call,lastToolText,declaredTools} from './fixture-model.ts';
import {startEidoAgent} from '../src/server.ts';
import {ResearchStore} from '../../runtime/src/research/store.mjs';

test('built-in Research uses the existing MCP bridge and restores immutable source ownership without model calls', {timeout:30000}, async()=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),'eido-research-acp-')));
  await writeFile(join(directory,'settings.json'),JSON.stringify({defaultProvider:'eido-fixture',defaultModel:'scripted',defaultTools:['-mcp__eido_research__search'],compaction:{enabled:false},eido:{research:{schemaVersion:1,enabled:true,revision:1}}}));
  let version='';
  const fixture=await fixtureModel(directory,[
    context=>{assert.ok(!declaredTools(context).includes('mcp__eido_research__search'));return call('mcp__eido_research__source',{action:'read',versionId:version});},
    context=>{assert.match(lastToolText(context,'mcp__eido_research__source'),/immutable original/);return 'Source read.';},
  ]);
  const toAgent=new TransformStream(),toClient=new TransformStream();
  const server=await startEidoAgent(directory,join(directory,'sessions'),{readable:toAgent.readable,writable:toClient.writable},fixture.runtime);
  const updates:SessionUpdate[]=[];
  const connection=client({name:'research-fixture'}).onNotification(methods.client.session.update,({params})=>{updates.push(params.update);})
    .onRequest(methods.client.session.requestPermission,()=>({outcome:{outcome:'selected',optionId:'allow_once'}}))
    .connect({readable:toClient.readable,writable:toAgent.writable});
  try {
    await connection.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{_meta:{eidoResearch:1,eidoDocuments:1}}});
    const task=await connection.agent.request(methods.agent.session.new,{cwd:directory,mcpServers:[]});
    const store=new ResearchStore({directory,sessionId:task.sessionId});
    const operation=await store.beginOperation({operationId:'saved-op',turnId:'earlier-turn',kind:'fetch'});
    const source=await store.addSource({kind:'web',canonicalUrl:'https://example.com'},{body:'immutable original',operationId:operation.operationId});
    version=source.versionId;await store.setOperation(operation.operationId,{status:'complete'});
    const response=await connection.agent.request(methods.agent.session.prompt,{sessionId:task.sessionId,prompt:[{type:'text',text:'Read the saved source.'}]});
    assert.equal(response.stopReason,'end_turn');assert.equal(fixture.requests(),2);
    const result=updates.findLast(update=>update.sessionUpdate==='tool_call_update'&&!!(update.rawOutput as {structuredContent?:{eidoResearch?:unknown}})?.structuredContent?.eidoResearch);
    assert.ok(result,'structured MCP evidence reaches ACP rawOutput');
    const local=()=>connection.agent.request<Record<string,unknown>>('_eido/research',{version:1,sessionId:task.sessionId,action:'read',versionId:version});
    assert.equal((await local()).text,'immutable original');
    const other=await connection.agent.request(methods.agent.session.new,{cwd:directory,mcpServers:[]});
    await assert.rejects(connection.agent.request('_eido/research',{version:1,sessionId:other.sessionId,action:'read',versionId:version}));
    await assert.rejects(connection.agent.request('_eido/research',{version:2,sessionId:task.sessionId,action:'list'}));
    const interrupted=await store.beginOperation({operationId:'interrupted-op',turnId:'earlier-turn',kind:'ocr'});
    await store.setOperation(interrupted.operationId,{status:'dispatched'});
    await connection.agent.request(methods.agent.session.close,{sessionId:task.sessionId});updates.length=0;
    await connection.agent.request(methods.agent.session.load,{sessionId:task.sessionId,cwd:directory,mcpServers:[]});
    assert.equal((await local()).text,'immutable original');assert.equal(fixture.requests(),2);
    assert.equal((await store.manifest()).operations.find(item=>item.operationId==='saved-op')?.receipt,'recorded');
    const receipts=updates.filter((u:any)=>u.toolCallId?.startsWith('research-')).map((u:any)=>u.rawOutput.structuredContent.eidoResearch);
    assert.ok(receipts.some(r=>r.operationId==='saved-op'&&r.status==='complete'&&r.sourceRefs.includes(version)),'production complete receipt replays through ACP');
    assert.ok(receipts.some(r=>r.operationId==='interrupted-op'&&r.status==='interrupted_unknown'),'interrupted receipt replays without another request');
    const config=JSON.parse(await readFile(join(directory,'settings.json'),'utf8'));assert.equal(config.defaultProvider,'eido-fixture');assert.equal(config.defaultModel,'scripted');
    const revision=(await store.manifest()).revision;
    await connection.agent.request('_eido/research',{version:1,sessionId:task.sessionId,action:'delete',versionIds:[version],expectedRevision:revision,operationId:'delete-op'});
    await assert.rejects(local());
    await connection.agent.request(methods.agent.session.close,{sessionId:task.sessionId});
    await connection.agent.request(methods.agent.session.load,{sessionId:task.sessionId,cwd:directory,mcpServers:[]});
    await assert.rejects(local());assert.equal(fixture.requests(),2);
  } finally {await server.agent.dispose();connection.close();server.connection.close();await rm(directory,{recursive:true,force:true});}
});

test('Search to Fetch to exact citation crosses real ACP and keeps the non-DeepSeek model', {timeout:30000}, async()=>{
  const {createServer}=await import('node:http');
  const directory=await realpath(await mkdtemp(join(tmpdir(),'eido-research-chain-')));let requests=0;
  const http=createServer(async(req,res)=>{for await(const _ of req){}requests++;assert.equal(req.headers.authorization,'Bearer local-research-credential');res.end(JSON.stringify(req.url?.endsWith('search')?{results:[{title:'Public document',url:'https://example.com/doc',summary:'A summary, not the body'}]}:{title:'Public document',content:'Immutable original requirement: support 😀 text.'}));});
  await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));const address=http.address() as {port:number};
  await writeFile(join(directory,'settings.json'),JSON.stringify({defaultProvider:'eido-fixture',defaultModel:'scripted',compaction:{enabled:false},eido:{research:{schemaVersion:1,enabled:true,revision:1,baseUrl:`http://127.0.0.1:${address.port}/v1`}}}));
  let version='',citation='';
  const fixture=await fixtureModel(directory,[
    ()=>call('mcp__eido_research__search',{query:'Public document'}),
    context=>{const result=JSON.parse(lastToolText(context,'mcp__eido_research__search'));assert.equal(result.sources[0].readState,'summary_only');return call('mcp__eido_research__fetch',{url:'https://example.com/doc'});},
    context=>{const result=JSON.parse(lastToolText(context,'mcp__eido_research__fetch'));assert.equal(result.source.readState,'read');version=result.source.versionId;return call('mcp__eido_research__source',{action:'cite',versionId:version,quote:'support 😀 text.'});},
    context=>{const result=JSON.parse(lastToolText(context,'mcp__eido_research__source'));assert.equal(result.matchState,'exact');citation=result.url;return 'Requirement cited.';},
  ]);
  fixture.runtime.registerProvider('deepseek',{api:'openai-completions',baseUrl:'https://api.deepseek.com/v1',apiKey:'local-research-credential'});
  const toAgent=new TransformStream(),toClient=new TransformStream();const server=await startEidoAgent(directory,join(directory,'sessions'),{readable:toAgent.readable,writable:toClient.writable},fixture.runtime);
  const updates:SessionUpdate[]=[];
  const connection=client({name:'research-chain'}).onNotification(methods.client.session.update,({params})=>{updates.push(params.update);}).onRequest(methods.client.session.requestPermission,()=>({outcome:{outcome:'selected',optionId:'allow_once'}})).connect({readable:toClient.readable,writable:toAgent.writable});
  try {
    await connection.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{}});const task=await connection.agent.request(methods.agent.session.new,{cwd:directory,mcpServers:[]});
    await connection.agent.request(methods.agent.session.prompt,{sessionId:task.sessionId,prompt:[{type:'text',text:'Research the public requirement and cite its original wording.'}]});
    assert.equal(requests,2);assert.equal(fixture.requests(),4);assert.match(citation,new RegExp(`^eido-source://${version}/`));
    const manifest=await new ResearchStore({directory,sessionId:task.sessionId}).manifest();assert.equal(manifest.sources.length,2);assert.equal(manifest.citations.length,1);
    const ref=updates.findLast(update=>update.sessionUpdate==='tool_call_update'&&!!(update.rawOutput as any)?.structuredContent?.eidoResearch?.citationRefs?.length);assert.ok(ref,'exact citation refs cross the MCP structured result');
    assert.equal(JSON.parse(await readFile(join(directory,'settings.json'),'utf8')).defaultProvider,'eido-fixture');
  } finally {await server.agent.dispose();connection.close();server.connection.close();http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});

test('requirement revisions retain original criteria and reject claimed checks or foreign citations',async()=>{
  const {ResearchRequirements}=await import('../src/research-requirements.ts');
  const directory=await mkdtemp(join(tmpdir(),'eido-requirements-'));
  try {
    const store=new ResearchStore({directory,sessionId:'owner'}),requirements=new ResearchRequirements(store);
    const source=await store.addSource({kind:'web'},{body:'Support Unicode identifiers.'}),citation=await store.cite(source.versionId,'Unicode identifiers');
    const input={action:'create',title:'Unicode',text:'Support Unicode identifiers',citationIds:[citation.citationId],relatedFiles:['src/parser.ts'],criteria:[{text:'Parser accepts Unicode',checkType:'command',checkSpec:'npm test',sourceCitationIds:[citation.citationId]}]};
    const first=await requirements.execute(input) as any;assert.equal(first.status,'Not checked');assert.equal(first.sources,'Confirmed');
    await assert.rejects(requirements.execute({...input,passed:true}),{code:'invalid_requirement'});
    await assert.rejects(requirements.execute({...input,citationIds:['other-task-citation']}),{code:'source_unavailable'});
    const updated=await requirements.execute({...input,action:'update',requirementId:first.requirement.requirementId,expectedRevision:1,text:'Support more Unicode identifiers',criteria:first.requirement.criteria}) as any;
    assert.equal(updated.requirement.revision,2);assert.equal((await requirements.get(first.requirement.requirementId,1)).text,'Support Unicode identifiers');
    await assert.rejects(requirements.execute({...input,action:'update',requirementId:first.requirement.requirementId,expectedRevision:1}),{code:'conflict'});
    assert.equal((await store.manifest()).requirements.length,2);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('submitted requirement reference binds its exact revision to the active user turn',async()=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),'eido-requirement-scope-')));
  await writeFile(join(directory,'settings.json'),JSON.stringify({defaultProvider:'eido-fixture',defaultModel:'scripted',compaction:{enabled:false},eido:{research:{schemaVersion:1,enabled:true,revision:1}}}));
  let sessionId='',requirementId='';
  const fixture=await fixtureModel(directory,[async()=>{
    const status=await connection.agent.request<any>('_eido/research',{version:1,sessionId,action:'status'});
    assert.equal(status.activeScope.ownerSession,sessionId);assert.ok(status.activeScope.turnId);assert.ok(status.activeScope.requestId);assert.deepEqual(status.activeScope.requirements,[{version:1,requirementId,revision:1}]);
    return call('mcp__eido_research__requirements',{action:'get',requirementId,revision:1});
  },context=>{assert.equal(JSON.parse(lastToolText(context,'mcp__eido_research__requirements')).requirement.revision,1);return 'Exact requirement received.';}]);
  const toAgent=new TransformStream(),toClient=new TransformStream();const server=await startEidoAgent(directory,join(directory,'sessions'),{readable:toAgent.readable,writable:toClient.writable},fixture.runtime);
  const connection=client({name:'requirement-scope'}).onNotification(methods.client.session.update,()=>{}).onRequest(methods.client.session.requestPermission,()=>({outcome:{outcome:'selected',optionId:'allow_once'}})).connect({readable:toClient.readable,writable:toAgent.writable});
  try {
    await connection.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{}});const task=await connection.agent.request(methods.agent.session.new,{cwd:directory,mcpServers:[]});sessionId=task.sessionId;
    const result=await connection.agent.request<any>('_eido/research',{version:1,sessionId,action:'requirements',operationId:'create-requirement',request:{action:'create',title:'Local draft',text:'Implement local behavior',citationIds:[],relatedFiles:[],criteria:[{text:'Observe expected behavior',checkType:'manual',sourceCitationIds:[]}]}});requirementId=result.requirement.requirementId;
    const reference={version:1,requirementId,revision:1};
    await connection.agent.request(methods.agent.session.prompt,{sessionId,prompt:[{type:'text',text:'Implement this saved requirement.'},{type:'resource',resource:{uri:`eido-requirement://${requirementId}/1`,mimeType:'application/vnd.eido.requirement+json',text:JSON.stringify(reference)}}]});
    assert.equal((await connection.agent.request<any>('_eido/research',{version:1,sessionId,action:'status'})).activeScope,null);
    const other=await connection.agent.request(methods.agent.session.new,{cwd:directory,mcpServers:[]});await assert.rejects(connection.agent.request(methods.agent.session.prompt,{sessionId:other.sessionId,prompt:[{type:'resource',resource:{uri:`eido-requirement://${requirementId}/1`,mimeType:'application/vnd.eido.requirement+json',text:JSON.stringify(reference)}}]}));assert.equal(fixture.requests(),2);
  } finally {await server.agent.dispose();connection.close();server.connection.close();await rm(directory,{recursive:true,force:true});}
});

test('requirement hooks bind actual command checks and preserve immutable evidence after edits and revisions',async()=>{
  const {ResearchRequirements,requirementHooks}=await import('../src/research-requirements.ts');
  const directory=await mkdtemp(join(tmpdir(),'eido-requirement-check-'));
  try{
    const store=new ResearchStore({directory,sessionId:'owner'}),requirements=new ResearchRequirements(store);
    const input={action:'create',title:'Check',text:'Command must pass',criteria:[{text:'Tests pass',checkType:'command',checkSpec:'node check.mjs'}]};
    const created=await requirements.execute(input,{operationId:'one',turnId:'local'}) as any;
    assert.deepEqual(await requirements.execute(input,{operationId:'one',turnId:'local'}),created);
    assert.equal((await store.manifest()).requirements.length,1);
    const requirement=created.requirement,criterion=requirement.criteria[0].criterionId;
    const hooks=requirementHooks(store,()=>({ownerSession:'owner',turnId:'actual',requestId:'request',requirements:[{requirementId:requirement.requirementId,revision:1}]}));
    await assert.rejects(hooks.capture('write',['foreign']),{code:'invalid_scope'});
    const scope=await hooks.capture('write',[criterion]);assert.equal(scope?.turnId,'actual');
    await hooks.edit(scope,'/workspace/a.ts','hash');
    const evidence={runId:'run',fingerprint:'code-hash',files:[],freshness:{state:'current',checkedAt:new Date().toISOString()},project:{checks:[{command:'node',args:['check.mjs'],exitCode:0,finishedAt:new Date().toISOString(),timedOut:false}]}};
    assert.equal((await hooks.checks(scope,[criterion],evidence))[0]!.status,'Passed');
    assert.equal((await hooks.checks(scope,[criterion],{...evidence,runId:'bad',project:{checks:[{command:'echo',args:['passed'],exitCode:0,finishedAt:new Date().toISOString()}]}}))[0]!.status,'Not checked');
    await hooks.edit(scope,'/workspace/a.ts','new-hash');
    assert.equal((await store.manifest()).links.find(l=>l.runId==='run')?.freshness,'needs_recheck');
    await requirements.execute({...input,action:'update',requirementId:requirement.requirementId,expectedRevision:1});
    await assert.rejects(hooks.capture('later'),{code:'stale_requirement'});
    await store.recover();assert.equal((await store.manifest()).links.find(l=>l.runId==='run')?.status,'Inputs not rechecked');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('delete is atomic, stale attempts preserve revisions, and receipt retries cannot delete twice',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'eido-delete-cas-'));
  try{
    const store=new ResearchStore({directory,sessionId:'owner'});const source=await store.addSource({kind:'web'},{body:'saved'}),revision=(await store.manifest()).revision;
    await assert.rejects(store.deleteSources([source.versionId],revision-1,'delete'),{code:'conflict'});
    assert.equal((await store.manifest()).revision,revision);
    await store.deleteSources([source.versionId],revision,'delete');
    await store.deleteSources([source.versionId],revision,'delete');
    assert.equal((await store.manifest()).deletions.length,1);assert.equal((await store.manifest()).operations.length,1);
  }finally{await rm(directory,{recursive:true,force:true});}
});


test('command and manual checks lose visible Passed after a linked edit and require a new run',async()=>{
  const {ResearchSession}=await import('../src/research.ts');
  const {sha256}=await import('../../runtime/src/research/store.mjs');
  const directory=await mkdtemp(join(tmpdir(),'eido-linked-edit-status-'));
  let content='before',reads=0;
  const session=new ResearchSession(directory,{sessionId:'owner',cwd:directory,getTurnId:()=> 'turn',client:{request:async()=>{reads++;return {content,_meta:{'eido.dev/observeBuffer':true}};}}} as any);
  try{
    const created:any=await session.requirements.execute({action:'create',title:'Both checks',text:'Keep both checks current',criteria:[{text:'Command',checkType:'command',checkSpec:'node check.mjs'},{text:'Observed',checkType:'manual'}]});
    const requirement=created.requirement,ids=requirement.criteria.map((c:any)=>c.criterionId);
    await session.submit([],[{version:1,requirementId:requirement.requirementId,revision:1}]);
    const scope=await session.hooks.capture('check',ids);
    const evidence=(runId:string)=>({runId,fingerprint:sha256(content),files:[{path:'a.ts',hash:sha256(content)}],freshness:{state:'current'},project:{checks:[{command:'node',args:['check.mjs'],exitCode:0,finishedAt:new Date().toISOString()}]}});
    await session.hooks.checks(scope,ids,evidence('first'));
    await session.local({version:1,sessionId:'owner',action:'manual-check',requirementId:requirement.requirementId,revision:1,criterionId:ids[1],outcome:'Passed',observation:'Observed the current preview.'});
    const latest=(manifest:any,id:string)=>manifest.links.findLast((l:any)=>l.kind==='check'&&l.criterionId===id);
    let status:any=await session.local({version:1,sessionId:'owner',action:'status'});
    assert.ok(ids.every((id:string)=>latest(status.manifest,id).status==='Passed'));
    content='after';await session.hooks.edit(scope,join(directory,'a.ts'),sha256(content));reads=0;
    status=await session.local({version:1,sessionId:'owner',action:'status'});
    for(const id of ids){assert.equal(latest(status.manifest,id).status,'Needs recheck');assert.equal(latest(status.manifest,id).freshness,'needs_recheck');}
    assert.equal(reads,0,'already invalid checks need no native reads');
    await assert.rejects(session.local({version:1,sessionId:'owner',action:'manual-check',requirementId:requirement.requirementId,revision:1,criterionId:ids[1],outcome:'Passed',observation:'Old preview.'}),{code:'needs_recheck'});
    assert.equal((await session.hooks.checks(scope,[ids[0]],evidence('first')))[0]!.status,'Needs recheck','reusing an old run cannot restore Passed');
    await session.hooks.checks(scope,ids,evidence('second'));
    status=await session.local({version:1,sessionId:'owner',action:'status'});
    assert.equal(latest(status.manifest,ids[0]).status,'Passed');assert.equal(latest(status.manifest,ids[1]).status,'Not checked');
    await session.local({version:1,sessionId:'owner',action:'manual-check',requirementId:requirement.requirementId,revision:1,criterionId:ids[1],outcome:'Passed',observation:'Observed the new preview.'});
    // Persisted records from earlier builds must not retain an obsolete Passed label.
    await session.store.mutate(m=>{const old=latest(m,ids[1]);old.freshness='inputs_not_rechecked';old.status='Passed';});
    status=await session.local({version:1,sessionId:'owner',action:'status'});assert.equal(latest(status.manifest,ids[1]).status,'Inputs not rechecked');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('research journal replay preserves custom messages and marks unfinished receipts interrupted',async()=>{
  const {replayEntry}=await import('../adapter/src/replay.js');
  for(const status of ['queued','reserved','dispatched','running','complete']){
    const entry:any={type:'custom',customType:'eido.research.event.v1',data:{operationId:'operation',eidoResearch:{version:1,sessionId:'owner',status}}};
    const updates:any[]=replayEntry(entry);
    assert.equal(updates.length,1);assert.equal(updates[0].rawOutput.structuredContent.eidoResearch.status,status==='complete'?'complete':'interrupted_unknown');
    assert.equal(entry.data.eidoResearch.status,status,'replay must not mutate journal evidence');
  }
  assert.deepEqual(replayEntry({type:'message',id:'legacy',message:{role:'custom',display:true,content:'Visible custom history'}} as any),[{sessionUpdate:'agent_message_chunk',messageId:'legacy',content:{type:'text',text:'Visible custom history'}}]);
  assert.deepEqual(replayEntry({type:'message',id:'hidden',message:{role:'custom',display:false,content:'Hidden'}} as any),[]);
});
