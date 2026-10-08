import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {AgentSession} from '@earendil-works/pi-coding-agent';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import type {McpClientHandle, McpSessionBinding} from '../adapter/src/mcp-bridge.js';
import {computerUse, computerGuidance} from '../src/computer-use.ts';
import {mkdtemp, realpath, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {client, methods} from '@agentclientprotocol/sdk';
import {startEidoAgent} from '../src/server.ts';
import {fixtureModel, call as modelCall, lastToolText, type FixtureStep} from './fixture-model.ts';

const text = (r: CallToolResult) => r.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
const observationId = (r: CallToolResult) => /Eido observation ([\w-]+)\./.exec(text(r))![1]!;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lpEAAAAASUVORK5CYII=';
async function fixture() {
  let vision = true, blocked = false, rich = false, clock = 1000, snapshot = 0;
  let failure: string | undefined, abortAction: (() => void) | undefined, mismatched = false, missing = false, menuOnly = false;
  const calls: {name: string; args: Record<string, unknown>}[] = [];
  const pi = {get model() {return {provider: 'fixture', id: vision ? 'vision' : 'text', input: vision ? ['text','image'] : ['text']};},
    settingsManager: {getBlockImages: () => blocked}} as unknown as AgentSession;
  const raw: McpClientHandle = {
    async listTools() {return {tools: ['get_window_state','get_desktop_state','click','type_text','type_text_chars','press_key','hotkey','set_value','end_session','bring_to_front','list_windows'].map(name => ({name,inputSchema:{type:'object',properties:{session:{type:'string'}}}}))};},
    async callTool(name, value, signal) {
      const args = value as Record<string, unknown>; calls.push({name,args});
      if (name === failure) return {isError: true, content: [{type:'text',text:'Intentional driver failure'}]};
      if (name === 'press_key' && abortAction) {abortAction();signal.throwIfAborted();}
      if (name === 'get_window_state' || name === 'get_desktop_state') {
        snapshot++;
        const content: CallToolResult['content'] = [{type:'text',text:rich?'Recipient: Local group. Input: Test phrase':'Window and menu chrome only'}];
        if (args.include_screenshot !== false && !menuOnly && !missing) content.push({type:'image',mimeType:'image/png',data:png});
        return {content,structuredContent:{pid:args.pid,window_id:mismatched ? 999 : args.window_id,window_title:'Generic window',capture_id:`frame-${snapshot}`,screenshot_frame_valid:true,
          ...(missing ? {background_input:{exact_window:{pid:args.pid,window_id:args.window_id,status:'not_found'}},screenshot_frame_valid:false} : {}),
          elements:[{role:'AXWindow',depth:0,label:'Generic window'},...(rich?[{role:'AXTextField',depth:1,label:'Test phrase',element_token:`s${snapshot.toString(16).padStart(8,'0')}:0`}]:[]),
            {role:'AXStaticText',depth:1,label:'Generic window'},{role:'AXButton',subrole:'AXCloseButton',depth:1,label:'Close'},
            ...(menuOnly ? [{role:'AXMenuBar',depth:0},{role:'AXMenuBarItem',depth:1,label:'Help'},
              {role:'AXMenu',depth:2},{role:'AXTextField',depth:3,label:'Search',element_token:'help-search'}] : [])]}};
      }
      return {content:[{type:'text',text:'Input delivered'}],structuredContent:{effect:'unverifiable'}};
    },
    async close() {calls.push({name:'close',args:{}});},
  };
  const computer = computerUse(raw, {sessionId:'local-task',getPi:()=>pi} as McpSessionBinding, () => clock);
  const signal = new AbortController();
  const listed = await computer.handle.listTools(undefined,signal.signal,1000);
  const call = (name: string, args: Record<string, unknown> = {}) => computer.handle.callTool(name,args,signal.signal,1000);
  return {computer,pi,calls,listed,signal,call,observe:()=>call('get_window_state',{pid:7,window_id:10}),
    vision:(v:boolean)=>{vision=v;},blocked:(v:boolean)=>{blocked=v;},rich:(v:boolean)=>{rich=v;},
    advance:()=>{clock+=61000;},fail:(name?:string)=>{failure=name;},mismatch:()=>{mismatched=true;},
    missing:()=>{missing=true;},menuOnly:()=>{menuOnly=true;},onAction:(f:()=>void)=>{abortAction=f;}};
}

test('weak AX automatically gets pixels; inputs require a current exact target and return new evidence',async()=>{
  const f=await fixture();
  assert.ok(f.listed.tools.find(t=>t.name==='press_key')?.inputSchema.properties?.eido_observation);
  const observed=await f.call('get_window_state',{pid:7,window_id:10,include_screenshot:false});
  assert.equal(f.calls.filter(c=>c.name==='get_window_state').length,2);
  assert.equal(observed.content.filter(c=>c.type==='image').length,1);
  const id=observationId(observed);
  assert.equal((await f.call('press_key',{pid:7,window_id:11,key:'return',eido_observation:id})).isError,true);
  assert.equal((await f.call('press_key',{pid:7,window_id:10,key:'return'})).isError,true);
  assert.equal((await f.call('type_text_chars',{pid:7,window_id:10,text:'Must not bypass observation'})).isError,true);
  const after=await f.call('press_key',{pid:7,window_id:10,key:'return',eido_observation:id});
  assert.notEqual(after.isError,true);assert.match(text(after),/Post-action observation/);
  assert.notEqual(observationId(after),id);
  assert.equal((await f.call('press_key',{pid:7,window_id:10,key:'return',eido_observation:id})).isError,true);
  assert.equal(f.calls.filter(c=>c.name==='press_key').length,1,'uncertain sends must not be replayed from old evidence');
  await f.computer.finishTurn();
});

test('text-only, image-blocked and changed models cannot use old visual evidence; current guidance follows pi',async()=>{
  const f=await fixture();const initial=await f.observe();
  f.vision(false);assert.match(computerGuidance(f.pi),/fixture\/text.*declared text-only/);
  assert.equal((await f.call('click',{pid:7,window_id:10,x:20,y:30,eido_observation:observationId(initial)})).isError,true);
  const blind=await f.observe();assert.equal(blind.content.some(c=>c.type==='image'),false);
  assert.equal((await f.call('press_key',{pid:7,window_id:10,key:'return',eido_observation:observationId(blind)})).isError,true);
  f.vision(true);assert.match(computerGuidance(f.pi),/fixture\/vision.*accepts images/);
  f.blocked(true);assert.match(computerGuidance(f.pi),/Images are blocked/);
  assert.equal((await f.observe()).content.some(c=>c.type==='image'),false);
  f.blocked(false);const visible=await f.observe();
  assert.notEqual((await f.call('click',{pid:7,window_id:10,x:20,y:30,eido_observation:observationId(visible)})).isError,true);
  const actual=f.calls.find(c=>c.name==='click');assert.ok(actual?.args.capture_id);
  assert.equal(actual.args.eido_observation,undefined,'Eido evidence fields must not be sent to Cua Driver');
  await f.computer.finishTurn();
});

test('text models retain semantic AX controls, but pixel input and expired observations are refused',async()=>{
  const f=await fixture();f.vision(false);f.rich(true);
  const observed=await f.observe();const token=(observed.structuredContent!.elements as {element_token?:string}[])[1]!.element_token;
  assert.notEqual((await f.call('set_value',{element_token:token,value:'Known field'})).isError,true);
  const latest=await f.observe();
  assert.equal((await f.call('click',{pid:7,window_id:10,x:1,y:2,eido_observation:observationId(latest)})).isError,true);
  f.advance();assert.equal((await f.call('press_key',{pid:7,window_id:10,key:'return',eido_observation:observationId(latest)})).isError,true);
  await f.computer.finishTurn();
});

test('failed post-action capture prevents replay and cleanup uses a task-owned label',async()=>{
  const f=await fixture();const observed=await f.observe();f.fail('get_window_state');
  const after=await f.call('press_key',{pid:7,window_id:10,key:'return',session:'someone-else',eido_observation:observationId(observed)});
  assert.equal(after.isError,true);
  assert.equal((await f.call('press_key',{pid:7,window_id:10,key:'return',eido_observation:observationId(observed)})).isError,true);
  await Promise.all([f.computer.finishTurn(),f.computer.finishTurn()]);
  assert.equal(f.calls.filter(c=>c.name==='press_key').length,1);
  assert.equal(f.calls.filter(c=>c.name==='end_session').length,1);
  const labels=new Set(f.calls.map(c=>c.args.session));assert.equal(labels.size,1);assert.ok(!labels.has('someone-else'));
  f.fail();await f.observe();assert.equal(new Set(f.calls.map(c=>c.args.session)).size,2,'next turn owns a new desktop session');
  await f.computer.handle.close();
});

test('a capture for a different window invalidates earlier evidence',async()=>{
  const f=await fixture();const old=await f.observe();f.mismatch();
  const wrong=await f.observe();assert.equal(wrong.isError,true);assert.match(text(wrong),/did not confirm/);
  assert.equal((await f.call('press_key',{pid:7,window_id:10,key:'return',eido_observation:observationId(old)})).isError,true);
  assert.equal((await f.call('press_key',{pid:7,window_id:10,key:'return',eido_observation:observationId(wrong)})).isError,true);
  assert.equal(f.calls.filter(c=>c.name==='press_key').length,0);
  await f.computer.finishTurn();
});

test('a disappeared window and menu search fields cannot authorize application input',async()=>{
  const f=await fixture();const old=await f.observe();f.missing();
  const missing=await f.observe();assert.equal(missing.isError,true);
  assert.equal((await f.call('press_key',{pid:7,window_id:10,key:'return',eido_observation:observationId(old)})).isError,true);
  assert.equal(f.calls.filter(c=>c.name==='press_key').length,0);
  await f.computer.finishTurn();
  const g=await fixture();g.menuOnly();
  const help=await g.observe();assert.match(text(help),/Application content is not observable/);
  assert.equal((await g.call('type_text',{pid:7,window_id:10,text:'Recipient',element_token:'help-search'})).isError,true);
  assert.equal(g.calls.filter(c=>c.name==='type_text').length,0);
  await g.computer.finishTurn();
});

test('zoom coordinates and debug image requests keep the driver coordinate contract',async()=>{
  const f=await fixture();
  for(const extra of [{from_zoom:true},{debug_image_out:'/tmp/eido-click-check.png'}]) {
    const obs=await f.observe();
    assert.notEqual((await f.call('click',{pid:7,window_id:10,x:20,y:30,...extra,eido_observation:observationId(obs)})).isError,true);
    assert.equal(f.calls.filter(c=>c.name==='click').at(-1)!.args.capture_id,undefined);
  }
  await f.computer.finishTurn();
});

test('cancellation still ends the owned desktop session with a live cleanup signal',async()=>{
  const f=await fixture();const obs=await f.observe();f.onAction(()=>f.signal.abort());
  await assert.rejects(f.call('press_key',{pid:7,window_id:10,key:'return',eido_observation:observationId(obs)}));
  await f.computer.finishTurn();assert.equal(f.calls.filter(c=>c.name==='end_session').length,1);
  const g=await fixture();await g.observe();g.fail('end_session');
  await assert.rejects(g.computer.finishTurn(),/cleanup failed/);
  await assert.rejects(g.computer.handle.close(),/cleanup failed/);
  assert.equal(g.calls.at(-1)?.name,'close','transport closes even when driver cleanup fails');
});

test('ACP and Code Mode share desktop guards and release sessions after success, model failure and cancellation',{timeout:30000},async()=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'eido-desktop-acp-'))),driver=join(dir,'driver.mjs'),log=join(dir,'calls.jsonl');
  await writeFile(driver,`#!${process.execPath}
import {createInterface} from 'node:readline'; import {appendFileSync} from 'node:fs';
let snapshot=0;
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if(m.id===undefined)return;
 let result={};
 if(m.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'Local desktop fixture',version:'1'}};
 if(m.method==='tools/list')result={tools:['get_window_state','press_key','end_session'].map(name=>({name,inputSchema:{type:'object',properties:{session:{type:'string'}},additionalProperties:true},...(name==='end_session'?{outputSchema:{type:'object',anyOf:[{required:['session','active'],properties:{session:{type:'string'},active:{const:false}}},{required:['status']}]}}:{})}))};
 if(m.method==='tools/call'){
  const {name,arguments:a}=m.params;appendFileSync(${JSON.stringify(log)},JSON.stringify({name,args:a})+'\\n');
  if(name==='get_window_state')result={content:[{type:'image',mimeType:'image/png',data:${JSON.stringify(png)}}],structuredContent:{pid:a.pid,window_id:a.window_id,capture_id:'capture-'+(++snapshot),screenshot_frame_valid:true,elements:[]}};
  else if(name==='press_key'&&a.key==='wait')return;
  else if(name==='end_session')result={content:[{type:'text',text:'Desktop session ended'}],structuredContent:{session:a.session,active:false}};
  else result={content:[{type:'text',text:'Driver action returned'}],structuredContent:{effect:'unverifiable'}};
 }
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`,{mode:0o755});
  await writeFile(join(dir,'settings.json'),JSON.stringify({defaultProvider:'eido-fixture',defaultModel:'scripted',defaultTools:['codemode'],retry:{enabled:false},compaction:{enabled:false},eido:{computerUse:{enabled:true,path:driver}}}));
  const steps:FixtureStep[]=[];const model=await fixtureModel(dir,steps);
  const a=new TransformStream(),b=new TransformStream();
  const server=await startEidoAgent(dir,join(dir,'sessions'),{readable:a.readable,writable:b.writable},model.runtime);
  const updates:any[]=[];
  const conn=client({name:'desktop-lifecycle-test'}).onNotification(methods.client.session.update,({params})=>{updates.push(params.update);})
    .onRequest(methods.client.session.requestPermission,()=>({outcome:{outcome:'selected',optionId:'allow_once'}}))
    .connect({readable:b.readable,writable:a.writable});
  const rows=async()=> (await readFile(log,'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  try {
    await conn.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{}});
    const task=await conn.agent.request(methods.agent.session.new,{cwd:dir,mcpServers:[]});
    assert.match(JSON.stringify(task.configOptions),/Vision/);
    const prompt=()=>conn.agent.request(methods.agent.session.prompt,{sessionId:task.sessionId,prompt:[{type:'text',text:'Verify the isolated desktop fixture.'}]});
    const observe:FixtureStep=ctx=>{assert.match(JSON.stringify(ctx),/current pi model accepts images/);return modelCall('mcp__eido_computer__get_window_state',{pid:7,window_id:10});};
    steps.push(observe,ctx=>{
      const id=/Eido observation ([\w-]+)\./.exec(lastToolText(ctx,'mcp__eido_computer__get_window_state'))![1]!;
      return modelCall('codemode',{code:`const r=await tools.mcp__eido_computer__press_key({pid:7,window_id:10,key:"return",eido_observation:${JSON.stringify(id)}}); for(const c of r.content ?? []){if(c.type==="image")image(c);else if(c.type==="text")text(c.text);}`});
    },ctx=>{assert.match(lastToolText(ctx,'codemode'),/Post-action observation/);return 'Verified fixture.';});
    assert.equal((await prompt()).stopReason,'end_turn');
    assert.equal((await rows()).filter(r=>r.name==='end_session').length,1);
    assert.ok(updates.some(u=>u._meta?.parentToolCallId&&u._meta?.toolName==='mcp__eido_computer__press_key'));
    steps.push(observe,()=>{throw new Error('Intentional model failure after desktop use');});
    await assert.rejects(prompt());
    assert.equal((await rows()).filter(r=>r.name==='end_session').length,2);
    steps.push(observe,ctx=>{
      const id=/Eido observation ([\w-]+)\./.exec(lastToolText(ctx,'mcp__eido_computer__get_window_state'))![1]!;
      return modelCall('mcp__eido_computer__press_key',{pid:7,window_id:10,key:'wait',eido_observation:id});
    });
    const running=prompt();
    for(let i=0;i<100&&!((await rows()).some(r=>r.args.key==='wait'));i++)await new Promise(r=>setTimeout(r,10));
    assert.ok((await rows()).some(r=>r.args.key==='wait'));
    await conn.agent.notify(methods.agent.session.cancel,{sessionId:task.sessionId});
    assert.equal((await running).stopReason,'cancelled');
    const final=await rows();assert.equal(final.filter(r=>r.name==='end_session').length,3);
    assert.equal(new Set(final.filter(r=>r.name==='end_session').map(r=>r.args.session)).size,3);
    steps.push(observe,()=>modelCall('mcp__eido_computer__end_session',{}),ctx=>{
      assert.match(lastToolText(ctx,'mcp__eido_computer__end_session'),/"active":false/);
      return modelCall('mcp__eido_computer__end_session',{});
    },ctx=>{assert.match(lastToolText(ctx,'mcp__eido_computer__end_session'),/already_ended/);return 'Explicit cleanup verified.';});
    assert.equal((await prompt()).stopReason,'end_turn');
    assert.equal((await rows()).filter(r=>r.name==='end_session').length,4,'explicit and finalizer cleanup must not end a session twice');
  }finally{await server.agent.dispose();conn.close();server.connection.close();await rm(dir,{recursive:true,force:true});}
});
