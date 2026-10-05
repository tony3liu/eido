import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer, type ServerResponse} from 'node:http';
import {mkdtemp, mkdir, writeFile, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {client, methods} from '@agentclientprotocol/sdk';
import {startEidoAgent} from '../src/server.ts';
import {call, declaredTools, fixtureModel, lastToolText} from './fixture-model.ts';
import {createExtensionCenter} from '../../../scripts/pi-extensions.mjs';
import {mcpHarness, policyRemote} from './fixture-mcp-policy.ts';

async function remoteFixture(type: 'http'|'sse') {
  const streams = new Set<ServerResponse>();
  let calls = 0, denied = 0;
  const server = createServer(async (req,res) => {
    if (req.headers.authorization !== 'Bearer fixture-mcp-secret') {denied++;res.writeHead(401).end();return;}
    if (req.method === 'GET') {
      res.writeHead(200, {'content-type':'text/event-stream','cache-control':'no-cache'});
      res.write(type==='sse'?'event: endpoint\ndata: /messages\n\n':': connected\n\n');
      streams.add(res); res.on('close',()=>streams.delete(res)); return;
    }
    if (req.method === 'DELETE') {res.writeHead(200).end();return;}
    let body='';for await(const chunk of req) body+=chunk;
    const message=JSON.parse(body);
    if (message.id === undefined) {res.writeHead(202).end();return;}
    const result=message.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'Eido remote fixture',version:'1'}}
      :message.method==='tools/list'?{tools:[{name:'ping',description:'Return a local fixture marker',inputSchema:{type:'object',properties:{}}}]}
      :message.method==='tools/call'?(calls++,{content:[{type:'text',text:`${type} fixture reached`}]}) : {};
    const payload=JSON.stringify({jsonrpc:'2.0',id:message.id,result});
    if(type==='sse') {for(const stream of streams)stream.write(`event: message\ndata: ${payload}\n\n`);res.writeHead(202).end();}
    else res.writeHead(200,{'content-type':'application/json'}).end(payload);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');
  return {url:`http://127.0.0.1:${address.port}/${type==='sse'?'sse':'mcp'}`,calls:()=>calls,denied:()=>denied,streams,
    close:async()=>{for(const stream of streams)stream.end();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}

for(const type of ['http','sse'] as const) test(`configured ${type} MCP uses the existing permission bridge and releases its connection`,{timeout:20_000},async()=>{
  const remote=await remoteFixture(type),dir=await realpath(await mkdtemp(join(tmpdir(),'eido-mcp-http-')));
  let active:Awaited<ReturnType<typeof startEidoAgent>>|undefined;
  let connection:ReturnType<ReturnType<typeof client>['connect']>|undefined;
  try {
    await mkdir(join(dir,'work'));
    await writeFile(join(dir,'settings.json'),JSON.stringify({defaultProvider:'eido-fixture',defaultModel:'scripted',compaction:{enabled:false}}));
    const center=createExtensionCenter(dir);
    await center.execute({operation:'mcp-save',text:JSON.stringify({mcpServers:{remote:{type,url:remote.url,headers:{Authorization:'Bearer fixture-mcp-secret'}}}})});
    const model=await fixtureModel(dir,[()=>call('mcp__remote__ping'),context=>{assert.match(lastToolText(context,'mcp__remote__ping'),new RegExp(`${type} fixture reached`));return 'Remote tool verified.';}]);
    const toAgent=new TransformStream(),toClient=new TransformStream();
    active=await startEidoAgent(dir,join(dir,'sessions'),{readable:toAgent.readable,writable:toClient.writable},model.runtime);
    const permissions:string[]=[],updates:unknown[]=[];
    connection=client({name:'eido-http-mcp-test'})
      .onNotification(methods.client.session.update,({params})=>{updates.push(params);})
      .onRequest(methods.client.session.requestPermission,({params})=>{permissions.push(params.sessionId);return {outcome:{outcome:'selected',optionId:'allow_once'}};})
      .connect({readable:toClient.readable,writable:toAgent.writable});
    await connection.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{}});
    const task=await connection.agent.request(methods.agent.session.new,{cwd:join(dir,'work'),mcpServers:[]});
    assert.equal((await connection.agent.request(methods.agent.session.prompt,{sessionId:task.sessionId,prompt:[{type:'text',text:'Call the remote fixture.'}]})).stopReason,'end_turn');
    assert.equal(remote.calls(),1);assert.equal(remote.denied(),0);assert.deepEqual(permissions,[task.sessionId]);
    assert.doesNotMatch(JSON.stringify(updates),/fixture-mcp-secret/);
    await connection.agent.request(methods.agent.session.close,{sessionId:task.sessionId});
    // Let the peer observe EOF before checking its retained SSE responses.
    for(let i=0;i<20&&remote.streams.size;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(remote.streams.size,0);
    await center.execute({operation:'mcp-toggle',name:'remote',enabled:false});
    const disabled=await connection.agent.request(methods.agent.session.new,{cwd:join(dir,'work'),mcpServers:[]});
    await connection.agent.request(methods.agent.session.close,{sessionId:disabled.sessionId});
    assert.equal(remote.calls(),1);
  } finally {await active?.agent.dispose();connection?.close();active?.connection.close();await remote.close();await rm(dir,{recursive:true,force:true});}
});

import {signIn,credentials,authenticatedMcpFetch} from '../../../scripts/pi-mcp.mjs';
import {configuredMcp} from '../../../scripts/pi-extensions.mjs';
import {oauthFixture} from './fixture-mcp.ts';
import {readFile} from 'node:fs/promises';

test('MCP OAuth uses pi PKCE, refreshes rotating credentials once, and never starts interactive auth on a request',{timeout:20_000},async()=> {
  const remote=await oauthFixture(),dir=await realpath(await mkdtemp(join(tmpdir(),'eido-mcp-oauth-')));
  let active:Awaited<ReturnType<typeof startEidoAgent>>|undefined;
  let connection:ReturnType<ReturnType<typeof client>['connect']>|undefined;
  try {
    const center=createExtensionCenter(dir);
    await center.execute({operation:'mcp-save',text:JSON.stringify({mcpServers:{remote:{url:remote.url}}})});
    let browser:Promise<Response>|undefined;
    await signIn(dir,'remote',{
      showAuthorizationUrl(url){browser=fetch(url);},
      promptForRedirectUrl(signal){return new Promise(resolve=>signal.addEventListener('abort',()=>resolve(undefined),{once:true}));},
    });
    assert.equal((await browser)?.ok,true);
    assert.equal(remote.browserFlows(),1);
    assert.ok(credentials(dir).tokens('remote',remote.url)?.access_token);
    const state=await center.execute();assert.doesNotMatch(JSON.stringify(state),/initial-mcp/);
    assert.equal((state.mcp as {name:string;signedIn:boolean}[]).find(s=>s.name==='remote')?.signedIn,true);
    const [server]=await configuredMcp(dir);assert.ok(server);
    const lane=authenticatedMcpFetch(server,async()=>undefined);
    remote.expire();
    const [a,b]=await Promise.all([lane.fetch(remote.url,{method:'GET'}),lane.fetch(remote.url,{method:'GET'})]);
    assert.equal(a.status,405);assert.equal(b.status,405);assert.equal(remote.refreshes(),1);
    await lane.settled();
    assert.equal(credentials(dir).tokens('remote',remote.url)?.refresh_token,'refreshed-refresh-1');
    await assert.rejects(lane.fetch('http://localhost:9/mcp'),/origin/);
    remote.setMode('scope');await assert.rejects(lane.fetch(remote.url,{method:'GET'}),/authorization requires user interaction/);
    assert.equal(remote.refreshes(),1);assert.equal(remote.browserFlows(),1);
    remote.setMode('normal');
    await mkdir(join(dir,'work'));
    await writeFile(join(dir,'settings.json'),JSON.stringify({defaultProvider:'eido-fixture',defaultModel:'scripted',compaction:{enabled:false}}));
    const model=await fixtureModel(dir,[()=>call('mcp__remote__ping'),context=>{assert.match(lastToolText(context,'mcp__remote__ping'),/OAuth fixture reached/);return 'OAuth verified.';}]);
    const toAgent=new TransformStream(),toClient=new TransformStream();
    active=await startEidoAgent(dir,join(dir,'sessions'),{readable:toAgent.readable,writable:toClient.writable},model.runtime);
    const updates:unknown[]=[];
    connection=client({name:'eido-oauth-test'}).onNotification(methods.client.session.update,({params})=>{updates.push(params);})
      .onRequest(methods.client.session.requestPermission,()=>({outcome:{outcome:'selected',optionId:'allow_once'}}))
      .connect({readable:toClient.readable,writable:toAgent.writable});
    await connection.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{}});
    const task=await connection.agent.request(methods.agent.session.new,{cwd:join(dir,'work'),mcpServers:[]});
    await connection.agent.request(methods.agent.session.prompt,{sessionId:task.sessionId,prompt:[{type:'text',text:'Call the authenticated fixture.'}]});
    assert.equal(remote.calls(),1);assert.doesNotMatch(JSON.stringify(updates),/refreshed-access|refreshed-refresh|code_verifier/);
    await connection.agent.request(methods.agent.session.close,{sessionId:task.sessionId});
    await center.execute({operation:'mcp-signout',name:'remote'});
    assert.equal(credentials(dir).tokens('remote',remote.url),undefined);
    await assert.rejects(lane.fetch(remote.url,{method:'GET'}),/authorization requires user interaction/);
    assert.equal(remote.browserFlows(),1);
    assert.doesNotMatch(await readFile(join(dir,'mcp-auth.json'),'utf8'),/refreshed-access/);
  } finally {await active?.agent.dispose();connection?.close();active?.connection.close();await remote.close();await rm(dir,{recursive:true,force:true});}
});

test('cancelled or superseded MCP sign-in closes its callback and cannot save credentials',{timeout:20_000},async()=> {
  const remote=await oauthFixture(),dir=await realpath(await mkdtemp(join(tmpdir(),'eido-mcp-cancel-')));
  try {
    const center=createExtensionCenter(dir);
    await center.execute({operation:'mcp-save',text:JSON.stringify({mcpServers:{remote:{url:remote.url}}})});
    let callback='';const stop=new AbortController();
    await assert.rejects(signIn(dir,'remote',{
      showAuthorizationUrl(url){callback=url.searchParams.get('redirect_uri')!;stop.abort();},
      async promptForRedirectUrl(){return undefined;},
    },stop.signal));
    await assert.rejects(fetch(callback));
    assert.equal(credentials(dir).tokens('remote',remote.url),undefined);
    let browser:Promise<Response>|undefined;
    await assert.rejects(signIn(dir,'remote',{
      showAuthorizationUrl(url){browser=(async()=>{await center.execute({operation:'mcp-toggle',name:'remote',enabled:false});return fetch(url);})();},
      promptForRedirectUrl(signal){return new Promise(resolve=>signal.addEventListener('abort',()=>resolve(undefined),{once:true}));},
    }),/configuration changed/);
    await browser;
    assert.equal(credentials(dir).tokens('remote',remote.url),undefined);
  } finally {await remote.close();await rm(dir,{recursive:true,force:true});}
});

import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

test('Extensions sign-in helper exits on owner EOF and releases the callback listener',{timeout:15_000},async()=> {
  const remote=await oauthFixture(),dir=await realpath(await mkdtemp(join(tmpdir(),'eido-mcp-owner-')));
  let child:ReturnType<typeof spawn>|undefined;
  try {
    await createExtensionCenter(dir).execute({operation:'mcp-save',text:JSON.stringify({mcpServers:{remote:{url:remote.url}}})});
    child=spawn(process.execPath,['scripts/pi-mcp-auth.mjs','remote'],{cwd:process.cwd(),env:{...process.env,EIDO_PI_CONFIG_DIR:dir},stdio:['pipe','pipe','pipe']});
    const exited=new Promise(resolve=>child!.once('exit',resolve));
    const lines=createInterface({input:child.stdout!});
    let callback='',sawEnd=false;
    for await(const line of lines) {
      const event=JSON.parse(line);
      assert.doesNotMatch(line,/access_token|refresh_token|code_verifier/);
      if(event.url){callback=new URL(event.url).searchParams.get('redirect_uri')!;child.stdin!.end();}
      if(event.ok===false){assert.equal(event.cancelled,true);sawEnd=true;}
    }
    await exited;assert.equal(sawEnd,true);assert.ok(callback);
    await assert.rejects(fetch(callback));
    assert.equal(credentials(dir).tokens('remote',remote.url),undefined);
  } finally {if(child?.exitCode===null)child.kill('SIGKILL');await remote.close();await rm(dir,{recursive:true,force:true});}
});

test('unavailable, unresolved and unsigned-in MCP servers do not block healthy tools or later prompts', {timeout:20_000}, async () => {
  const healthy = await policyRemote(), denied = await policyRemote(), invalid = await policyRemote();
  denied.mode('unauthorized'); invalid.mode('bad-catalog');
  const h = await mcpHarness({mcpServers:{
    absent:{command:'/eido-test-missing-executable', env:{SECRET:'never-display-this-secret'}},
    unresolved:{command:process.execPath, env:{KEY:'${EIDO_FIXTURE_ENV_THAT_DOES_NOT_EXIST}'}},
    denied:{url:denied.url}, invalid:{url:invalid.url}, healthy:{url:healthy.url},
  }}, [context => {
    assert.deepEqual(declaredTools(context).filter(t => t.startsWith('mcp__')), ['mcp__healthy__ping','mcp__healthy__slow','mcp__healthy__progress']);
    return call('mcp__healthy__ping');
  }, () => 'Healthy tool completed.', () => 'Another prompt completed.']);
  try {
    const task = await h.newTask();
    assert.equal((await h.prompt(task.sessionId)).stopReason, 'end_turn');
    const first = JSON.stringify(h.updates);
    assert.match(first, /sign-in required/); assert.match(first, /mcp:unresolved/); assert.match(first, /mcp:invalid/);
    assert.doesNotMatch(first, /never-display-this-secret|EIDO_FIXTURE_ENV/);
    h.updates.length = 0;
    assert.equal((await h.prompt(task.sessionId)).stopReason, 'end_turn');
    assert.doesNotMatch(JSON.stringify(h.updates), /sign-in required/);
    assert.deepEqual(healthy.calls, ['ping']);
  } finally {await h.close(); await healthy.close(); await denied.close(); await invalid.close();}
});

test('MCP per-server deadlines include initialization and tool progress extends the request deadline', {timeout:20_000}, async () => {
  const timed = await policyRemote(), hung = await policyRemote(); hung.mode('hang-open');
  const h = await mcpHarness({mcpServers:{hung:{url:hung.url,timeout:0.2}, timed:{url:timed.url,timeout:0.2}}}, [
    () => call('mcp__timed__progress'), context => {assert.match(lastToolText(context,'mcp__timed__progress'), /progress fixture reached/); return 'Progress completed.';},
    () => call('mcp__timed__slow'), context => {
      const result = context.messages.findLast(m => m.role === 'toolResult' && m.toolName === 'mcp__timed__slow');
      assert.ok(result?.role === 'toolResult' && result.isError); return 'Timeout handled.';
    }, context => {assert.ok(declaredTools(context).every(t => !t.startsWith('mcp__timed__'))); return 'Task still works.';},
  ]);
  try {
    const start = performance.now(), task = await h.newTask();
    assert.ok(performance.now() - start < 3000, 'server initialization uses its configured deadline');
    assert.equal((await h.prompt(task.sessionId)).stopReason,'end_turn');
    assert.equal((await h.prompt(task.sessionId)).stopReason,'end_turn');
    assert.equal((await h.prompt(task.sessionId)).stopReason,'end_turn');
    assert.deepEqual(timed.calls,['progress','slow']); assert.equal(h.model.requests(),5);
    assert.equal(timed.streams.size,0);
  } finally {await h.close(); await timed.close(); await hung.close();}
});

test('cancelling a progressing MCP request releases the stream and allows the next prompt', {timeout:20_000}, async () => {
  const remote = await policyRemote();
  const h = await mcpHarness({mcpServers:{remote:{url:remote.url,timeout:0.2}}}, [
    () => call('mcp__remote__progress'), () => call('mcp__remote__ping'),
    context => {assert.match(lastToolText(context,'mcp__remote__ping'), /ping fixture reached/); return 'Cancellation recovered.';},
  ]);
  try {
    const task = await h.newTask(), running = h.prompt(task.sessionId);
    for (let i = 0; i < 200 && !remote.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(remote.calls,['progress']);
    await h.connection.agent.notify(methods.agent.session.cancel,{sessionId:task.sessionId});
    assert.equal((await running).stopReason,'cancelled');
    for (let i = 0; i < 100 && remote.streams.size; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(remote.streams.size,0);
    assert.equal((await h.prompt(task.sessionId)).stopReason,'end_turn');
    assert.deepEqual(remote.calls,['progress','ping']);
  } finally {await h.close(); await remote.close();}
});
