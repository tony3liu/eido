import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,readFile,rm,realpath,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {client,methods,type ClientConnection} from '@agentclientprotocol/sdk';
import {startEidoAgent} from '../src/server.ts';
import {NATIVE_UI_ACTION} from '../src/native-ui.ts';
import {SUBAGENT_RUN} from '../src/subagents.ts';
import {call,fixtureModel,lastToolText,type FixtureStep} from './fixture-model.ts';

// External packages are installed separately in an isolated acceptance directory.
// Running this test never installs packages or modifies the user's pi settings.
const pluginRoot=process.env.EIDO_PLUGIN_ROOT;
const packages=[['@juicesharp/rpiv-todo','2.12.0'],['@juicesharp/rpiv-ask-user-question','2.12.0'],['@juicesharp/rpiv-i18n','2.12.0']] as const;

test('real npm plugins preserve main/child state, native questions, widgets and reload', {skip:!pluginRoot,timeout:60_000}, async()=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'eido-ecosystem-')));
  const prior={pi:process.env.PI_CODING_AGENT_DIR,xdg:process.env.XDG_CONFIG_HOME};
  process.env.PI_CODING_AGENT_DIR=dir;process.env.XDG_CONFIG_HOME=join(dir,'xdg');
  const extensions=packages.map(([name])=>resolve(pluginRoot!,name,'index.ts'));
  for(const [name,version] of packages) assert.equal(JSON.parse(await readFile(resolve(pluginRoot!,name,'package.json'),'utf8')).version,version);
  await writeFile(join(dir,'settings.json'),JSON.stringify({defaultProvider:'eido-fixture',defaultModel:'scripted',extensions,compaction:{enabled:false}}));
  await mkdir(join(dir,'agents'));
  await writeFile(join(dir,'agents/plugin-worker.md'),'---\nname: plugin-worker\ndescription: Plugin acceptance worker\ntools: ["tool:todo", "tool:ask_user_question"]\n---\nUse the configured tools.');
  const question={questions:[{question:'Which option should the acceptance fixture choose?',header:'Choice',options:[{label:'First',description:'First option'},{label:'Second',description:'Second option'}]}]};
  const steps:FixtureStep[]=[
    ()=>call('todo',{action:'create',subject:'Parent-only todo'}),
    context=>{assert.match(lastToolText(context,'todo'),/Parent-only todo/);return call('ask_user_question',question);},
    context=>{assert.match(lastToolText(context,'ask_user_question'),/First/);return call('subagent',{agent:'plugin-worker',task:'Create a child-only todo and ask the fixture question.'});},
    ()=>call('todo',{action:'create',subject:'Child-only todo'}),
    context=>{assert.match(lastToolText(context,'todo'),/Child-only todo/);assert.doesNotMatch(lastToolText(context,'todo'),/Parent-only todo/);return call('ask_user_question',question);},
    context=>{assert.match(lastToolText(context,'ask_user_question'),/First/);return 'Child plugin tools verified.';},
    context=>{assert.match(lastToolText(context,'subagent'),/Child plugin tools verified/);return call('todo',{action:'list'});},
    context=>{assert.match(lastToolText(context,'todo'),/Parent-only todo/);assert.doesNotMatch(lastToolText(context,'todo'),/Child-only todo/);return 'Parent plugin state preserved.';},
    ()=>call('todo',{action:'list'}),
    context=>{assert.match(lastToolText(context,'todo'),/Parent-only todo/);return 'Reload restored plugin state.';},
  ];
  const fixture=await fixtureModel(dir,steps);
  const a=new TransformStream(),b=new TransformStream();
  const server=await startEidoAgent(dir,join(dir,'sessions'),{readable:a.readable,writable:b.writable},fixture.runtime);
  const updates:any[]=[],actions:any[]=[],forms:any[]=[],children:string[]=[];
  const connection:ClientConnection=client({name:'ecosystem-acceptance'})
    .onNotification(methods.client.session.update,({params})=>{updates.push(params);})
    .onRequest(methods.client.session.requestPermission,()=>({outcome:{outcome:'selected',optionId:'allow_once'}}))
    .onRequest(methods.client.elicitation.create,({params})=>{
      forms.push(params);const property=(params as any).requestedSchema?.properties?.value;
      return {action:'accept',content:{value:property?.enum?.[0]??'1'}};
    })
    .onRequest(NATIVE_UI_ACTION,{parse:raw=>raw as any},({params})=>{actions.push(params);return {result:{handled:true}};})
    .onRequest(SUBAGENT_RUN,{parse:raw=>raw as any},async({params})=>{
      children.push(params.childSessionId);
      await connection.agent.request(methods.agent.session.load,{sessionId:params.childSessionId,cwd:dir,mcpServers:[]});
      await syncEditor(connection,params.childSessionId);
      return connection.agent.request(methods.agent.session.prompt,{sessionId:params.childSessionId,prompt:[{type:'text',text:params.task}]});
    }).connect({readable:b.readable,writable:a.writable});
  const prompt=(sessionId:string,text:string)=>connection.agent.request(methods.agent.session.prompt,{sessionId,prompt:[{type:'text',text}]});
  try {
    await connection.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{elicitation:{form:{}},_meta:{eidoNativeUi:1,eidoSubagents:1}}});
    const main=await connection.agent.request(methods.agent.session.new,{cwd:dir,mcpServers:[]});
    await syncEditor(connection,main.sessionId);
    await prompt(main.sessionId,'Verify installed plugin interaction.');
    assert.equal(fixture.requests(),8);assert.equal(children.length,1);assert.equal(forms.length,2);
    await prompt(main.sessionId,'/todos');
    await prompt(main.sessionId,'/reload');
    await prompt(main.sessionId,'Check the restored todo list.');
    assert.equal(fixture.requests(),10);
    const widget=actions.filter(a=>a.action==='extension_state'&&a.data.widgets?.['rpiv-todos']);
    assert.ok(widget.length>0,'real plugin widget must reach native UI');
    const errors=updates.filter(e=>JSON.stringify(e).match(/Failed to load|Extension error|stale after session replacement/));
    assert.deepEqual(errors,[]);
  } finally {await server.agent.dispose();connection.close();server.connection.close();await rm(dir,{recursive:true,force:true});restoreEnvironment(prior);}
});

test('real powerline plugin mounts its editor/footer and releases renderer processes on reload and close', {skip:!pluginRoot,timeout:60_000}, async()=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'eido-powerline-')));
  const prior={pi:process.env.PI_CODING_AGENT_DIR,xdg:process.env.XDG_CONFIG_HOME};
  process.env.PI_CODING_AGENT_DIR=dir;process.env.XDG_CONFIG_HOME=join(dir,'xdg');
  const extension=resolve(pluginRoot!,'pi-powerline-footer/index.ts');
  assert.equal(JSON.parse(await readFile(resolve(pluginRoot!,'pi-powerline-footer/package.json'),'utf8')).version,'0.19.1');
  await writeFile(join(dir,'settings.json'),JSON.stringify({defaultProvider:'eido-fixture',defaultModel:'scripted',extensions:[extension]}));
  const fixture=await fixtureModel(dir,[]);
  const a=new TransformStream(),b=new TransformStream();
  const server=await startEidoAgent(dir,join(dir,'sessions'),{readable:a.readable,writable:b.writable},fixture.runtime);
  let draft='',revision=1;
  const actions:any[]=[],updates:any[]=[],terminals=new Map<string,{child:ChildProcessWithoutNullStreams;exit:Promise<unknown>;released:boolean;output:string}>();
  const connection=client({name:'powerline-acceptance'})
    .onNotification(methods.client.session.update,({params})=>{updates.push(params);})
    .onRequest(methods.client.elicitation.create,()=>({action:'cancel'}))
    .onRequest(NATIVE_UI_ACTION,{parse:raw=>raw as any},({params})=>{actions.push(params);if(params.action==='set_editor'){draft=params.data.text;revision++;}return {result:{handled:true,editor:{instance:params.sessionId,revision,text:draft,toolsExpanded:false}}};})
    .onRequest(methods.client.terminal.create,({params})=>{
      assert.equal(params._meta?.eidoPiComponent,true);
      const child=spawn(params.command,params.args??[],{cwd:dir,stdio:'pipe'}),id=crypto.randomUUID();
      const terminal={child,exit:once(child,'exit'),released:false,output:''};terminals.set(id,terminal);
      child.stdout.on('data',data=>{terminal.output+=data.toString();});child.stderr.on('data',data=>{terminal.output+=data.toString();});
      return {terminalId:id};
    })
    .onRequest(methods.client.terminal.waitForExit,async({params})=>{await terminals.get(params.terminalId)!.exit;return {exitCode:0};})
    .onRequest(methods.client.terminal.release,async({params})=>{const t=terminals.get(params.terminalId)!;t.child.kill('SIGTERM');await t.exit;t.released=true;return {};})
    .connect({readable:b.readable,writable:a.writable});
  try {
    await connection.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{terminal:true,elicitation:{form:{}},_meta:{eidoNativeUi:1}}});
    const task=await connection.agent.request(methods.agent.session.new,{cwd:dir,mcpServers:[]});
    await syncEditor(connection,task.sessionId);
    for(const text of ['/session','/reload','/session']) await connection.agent.request(methods.agent.session.prompt,{sessionId:task.sessionId,prompt:[{type:'text',text}]});
    for(let attempt=0;attempt<100&&!actions.some(a=>a.action==='mount_editor');attempt++) await delay(20);
    assert.ok(actions.some(a=>a.action==='mount_editor'),JSON.stringify(updates.filter(e=>e.update.sessionUpdate==='agent_message_chunk'),null,2));
    assert.ok(actions.some(a=>a.action==='extension_state'&&a.data.footer),'Powerline footer was rendered');
    for(let attempt=0;attempt<100&&![...terminals.values()].some(t=>t.output.length>50);attempt++) await delay(20);
    assert.ok([...terminals.values()].some(t=>t.output.length>50));
    const mounted=actions.findLast(a=>a.action==='mount_editor');
    terminals.get(mounted.data.terminalId)!.child.stdin.write('\x1b[200~中文 draft\x1b[201~');
    for(let attempt=0;attempt<100&&!draft.includes('中文 draft');attempt++) await delay(20);
    assert.equal(draft,'中文 draft');
    await connection.agent.request(methods.agent.session.close,{sessionId:task.sessionId});
    assert.ok([...terminals.values()].every(t=>t.released&&t.child.exitCode!==null));
    const errors=updates.filter(e=>JSON.stringify(e).match(/Failed to load|Extension error|is not a function/));
    assert.deepEqual(errors,[]);assert.equal(fixture.requests(),0);
  } finally {
    await server.agent.dispose();connection.close();server.connection.close();
    for(const t of terminals.values()){t.child.kill('SIGTERM');await t.exit;}
    await rm(dir,{recursive:true,force:true});restoreEnvironment(prior);
  }
});

async function syncEditor(connection:ClientConnection,sessionId:string) {
  await connection.agent.request('_eido/ui/state',{sessionId,instance:sessionId,revision:1,text:'',toolsExpanded:false,columns:100,appearance:'light'});
}
function restoreEnvironment(prior:{pi:string|undefined;xdg:string|undefined}) {
  if(prior.pi===undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR=prior.pi;
  if(prior.xdg===undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME=prior.xdg;
}
