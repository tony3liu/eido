import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,realpath,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {client,methods} from '@agentclientprotocol/sdk';
import {startEidoAgent} from '../src/server.ts';
import {fixtureModel,call,lastToolText} from './fixture-model.ts';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ElicitRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {connectDefaultMcpClient, type McpSessionBinding} from '../adapter/src/mcp-bridge.js';
import {realSleep} from '../adapter/src/deps.js';

const name=(n:string)=>`mcp__eido_browser__browser_${n}`;
test('MCP browser ownership rejects competing inputs and closing invalidates queued navigation work',{timeout:30000},async()=>{
 const site=createServer((req,res)=>{
  if(req.url==='/hold'){held();return;}
  res.end('<title>Ownership check</title><button onclick="this.textContent=\'Changed\'">Original</button>');
 });
 let held!:()=>void;const started=new Promise<void>(r=>held=r);
 await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));const address=site.address();assert.ok(address&&typeof address!=='string');
 const url=`http://127.0.0.1:${address.port}`;
 const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../../runtime/bin/browser-server.mjs',import.meta.url))],env:{...process.env,JEV_BROWSER_HEADED:'0'}});
 const conn=new Client({name:'ownership-check',version:'1'},{capabilities:{elicitation:{form:{}}}});
 let entered!:()=>void,release!:()=>void;const began=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 conn.setRequestHandler(ElicitRequestSchema,async()=>{entered();await gate;return {action:'accept',content:{done:true}};});
 const callTool=(name:string,args={})=>conn.callTool({name:`browser_${name}`,arguments:args});
 try {
  await conn.connect(transport);await callTool('open',{url});
  const handoff=callTool('takeover',{reason:'Test input ownership.'});await began;
  const denied=await callTool('act',{action:'click',element:1});assert.equal(denied.isError,true);assert.match(JSON.stringify(denied),/user owns/);
  release();assert.match(JSON.stringify(await handoff),/resumed/);
  const navigation=callTool('open',{url:`${url}/hold`});await started;
  const queued=callTool('snapshot');await callTool('close');
  assert.equal((await navigation).isError,true);assert.match(JSON.stringify(await queued),/stale/);
  const status=await callTool('status');assert.equal(JSON.parse((status.content as any[])[0].text).open,false);
  assert.match(JSON.stringify(await callTool('open',{url})),/Original/);
 }finally{release?.();await conn.close();await transport.close();site.closeAllConnections();await new Promise<void>(r=>site.close(()=>r()));}
});

test('browser handoff holds automation, re-observes manual changes and cancels without retaining the browser',{timeout:30000},async()=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'eido-browser-handoff-')));let manual=false;
 const site=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<title>${manual?'Verified page':'Security verification'}</title><p id="state">${manual?'Manual step complete':'Verify you are human'}</p><script>setTimeout(()=>location.reload(),500)</script>`);});
 await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));const address=site.address();assert.ok(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}`;
 await writeFile(join(dir,'settings.json'),JSON.stringify({defaultProvider:'eido-fixture',defaultModel:'scripted',compaction:{enabled:false}}));
 let formStarted!:()=>void,releaseForm!:()=>void;const began=new Promise<void>(r=>formStarted=r),gate=new Promise<void>(r=>releaseForm=r);let forms=0;
 const model=await fixtureModel(dir,[
  ()=>call(name('open'),{url}),ctx=>{assert.match(lastToolText(ctx,name('open')),/needs_user/);return call(name('takeover'),{reason:'Complete the local verification step.'});},
  ctx=>{assert.match(lastToolText(ctx,name('takeover')),/Manual step complete/);assert.match(lastToolText(ctx,name('takeover')),/resumed/);return 'Manual handoff verified.';},
  ()=>call(name('open'),{url}),()=>call(name('takeover'),{reason:'Wait for the cancellation check.'}),
 ]);
 const a=new TransformStream(),b=new TransformStream();const server=await startEidoAgent(dir,join(dir,'sessions'),{readable:a.readable,writable:b.writable},model.runtime);
 const conn=client({name:'handoff-test'}).onNotification(methods.client.session.update,()=>{})
 .onRequest(methods.client.session.requestPermission,()=>({outcome:{outcome:'selected',optionId:'allow_once'}}))
 .onRequest(methods.client.elicitation.create,async({params})=>{
  forms++;if(forms===1){assert.match(JSON.stringify(params),/Manual Takeover/);assert.match(JSON.stringify(params),/Use Computer Use/);return {action:'accept',content:{method:'manual'}};}
  if(forms===2){manual=true;await new Promise(r=>setTimeout(r,800));return {action:'accept',content:{done:true}};}
  formStarted();await gate;return {action:'cancel'};
 }).connect({readable:b.readable,writable:a.writable});
 try {
  await conn.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{elicitation:{form:{}}}});
  const task=await conn.agent.request(methods.agent.session.new,{cwd:dir,mcpServers:[{name:'eido_browser',command:process.execPath,args:[fileURLToPath(new URL('../../runtime/bin/browser-server.mjs',import.meta.url))],env:[{name:'JEV_BROWSER_HEADED',value:'0'}]}]});
  const prompt=()=>conn.agent.request(methods.agent.session.prompt,{sessionId:task.sessionId,prompt:[{type:'text',text:'Verify browser handoff.'}]});
  assert.equal((await prompt()).stopReason,'end_turn');
  const pending=prompt();await began;await conn.agent.notify(methods.agent.session.cancel,{sessionId:task.sessionId});releaseForm();
  assert.equal((await pending).stopReason,'cancelled');assert.equal(forms,3);
 }finally{releaseForm?.();await server.agent.dispose();conn.close();server.connection.close();site.closeAllConnections();await new Promise<void>(r=>site.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});

test('verification requires an explicit method and Computer Use keeps the original browser and unverified state',{timeout:30000},async()=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'eido-verification-choice-')));
 const site=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<title>Security verification</title><p>Verify you are human</p><input value="Keep this page">');});
 await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));const address=site.address();assert.ok(address&&typeof address!=='string');
 const url=`http://127.0.0.1:${address.port}/original`;
 await writeFile(join(dir,'settings.json'),JSON.stringify({eido:{computerUse:{enabled:false}}}));
 const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../../runtime/bin/browser-server.mjs',import.meta.url))],env:{...process.env,JEV_BROWSER_HEADED:'0',EIDO_PI_CONFIG_DIR:dir}});
 const conn=new Client({name:'verification-choice-check',version:'1'},{capabilities:{elicitation:{form:{}}}});
 let response:any={action:'cancel'},forms=0;
 conn.setRequestHandler(ElicitRequestSchema,async request=>{
  forms++;assert.equal(request.params.mode,'form');
  assert.match(request.params.message,new RegExp(address.port.toString()));
  const schema=(request.params as any).requestedSchema;
  assert.deepEqual(schema.properties.method.oneOf.map((v:any)=>v.const),['manual','computer_use']);
  assert.equal(schema.properties.method.default,undefined,'a displayed default is not consent');
  return response;
 });
 const callTool=async(name:string,args={})=>{
  const result=await conn.callTool({name:`browser_${name}`,arguments:args});
  assert.notEqual(result.isError,true,JSON.stringify(result));
  return JSON.parse((result.content as any[])[0].text);
 };
 try {
  await conn.connect(transport);assert.equal((await callTool('open',{url})).status,'needs_user');
  for(const action of ['cancel','decline']) {
   response={action};const result=await callTool('takeover',{reason:'Local verification choice check.'});
   assert.equal(result.status,'needs_user');assert.equal(result.method,undefined);
   assert.equal((await callTool('status')).owner,'agent');
  }
  response={action:'accept',content:{method:'computer_use'}};
  const disabled=await callTool('takeover',{reason:'Local verification choice check.'});
  assert.equal(disabled.status,'needs_user');assert.match(disabled.message,/Computer Use is unavailable/);
  // Direct browser MCP only: an executable configuration proves availability,
  // not a connected desktop service or successful desktop action.
  await writeFile(join(dir,'settings.json'),JSON.stringify({eido:{computerUse:{enabled:true,path:process.execPath}}}));
  const result=await callTool('takeover',{reason:'Local verification choice check.'});
  assert.equal(result.status,'computer_use_requested');assert.equal(result.method,'computer_use');
  assert.deepEqual(result.target,{url,title:'Security verification'});
  assert.equal(result.observation.status,'needs_user');assert.match(result.observation.snapshot,/Keep this page/);
  assert.match(result.message,/eido_computer/);assert.match(result.message,/browser_snapshot/);
  assert.equal(forms,4,'Computer Use should not require manual completion confirmation');
  const status=await callTool('status');assert.equal(status.open,true);assert.equal(status.owner,'agent');
  const after=await callTool('snapshot');assert.equal(after.url,url);assert.equal(after.status,'needs_user');
 }finally{await conn.close();await transport.close();site.closeAllConnections();await new Promise<void>(r=>site.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});

test('browser form waits beyond the network deadline and remains cancellable',{timeout:20000},async()=>{
 const site=createServer((_req,res)=>res.end('<title>Local handoff timing check</title>Local test'));
 await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));const address=site.address();assert.ok(address&&typeof address!=='string');
 const signal=new AbortController(),turn=new AbortController();let duringForm=false,forms=0;
 let started!:()=>void,release!:()=>void;
 const entered=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);
 const binding={sessionId:'handoff-timing',cwd:tmpdir(),sessionSignal:signal.signal,
  getPi:()=>undefined,getTurnSignal:()=>turn.signal,isPublished:()=>true,emitDiagnostic:()=>{},
  client:{request:async()=>{
   forms++;if(forms===1){await new Promise(r=>setTimeout(r,250));return {action:'accept',content:{done:true}};}
   started();await gate;return {action:'accept',content:{done:true}};
  }},
 } as unknown as McpSessionBinding;
 const handle=await connectDefaultMcpClient({name:'eido_browser',command:process.execPath,args:[fileURLToPath(new URL('../../runtime/bin/browser-server.mjs',import.meta.url))],env:[{name:'JEV_BROWSER_HEADED',value:'0'}]},
  signal.signal,60_000,(ms,abort)=>realSleep(duringForm&&ms===60_000?100:ms,abort),binding);
 const callTool=(name:string,args={})=>handle.callTool(`browser_${name}`,args,signal.signal,10_000);
 try {
  await callTool('open',{url:`http://127.0.0.1:${address.port}`});duringForm=true;
  const result=await callTool('takeover',{reason:'Allow time for a person to respond.'});
  assert.match(JSON.stringify(result),/resumed/,'a network deadline must not cancel a person still using the form');
  const pending=callTool('takeover',{reason:'Cancellation still works during human input.'});
  await entered;turn.abort();assert.match(JSON.stringify(await pending),/not confirmed/);release();
 }finally{release?.();await handle.close();site.closeAllConnections();await new Promise<void>(r=>site.close(()=>r()));}
});
