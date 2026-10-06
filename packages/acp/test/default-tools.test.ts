import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, writeFile, readFile, rm, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {client, methods} from '@agentclientprotocol/sdk';
import {startEidoAgent} from '../src/server.ts';
import {fixtureModel} from './fixture-model.ts';

const native = ['read', 'edit', 'write', 'find', 'grep', 'ls', 'bash'];

test('pi defaultTools controls native declarations, modifiers, reload and delayed plugin registrations', {timeout: 30_000}, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'eido-default-tools-')));
  const settingsPath = join(dir, 'settings.json');
  const configure = async (defaultTools?: string[]) => {
    await writeFile(settingsPath, JSON.stringify({defaultProvider: 'eido-fixture', defaultModel: 'scripted',
      ...(defaultTools === undefined ? {} : {defaultTools})}));
  };
  await configure();
  await mkdir(join(dir, 'extensions'));
  await writeFile(join(dir, 'extensions/tools.js'), `export default pi => {
    const register = (name, defaultActive) => pi.registerTool({name, label:name, description:name,
      defaultActive, parameters:{type:'object',properties:{}}, execute:async()=>({content:[{type:'text',text:name}]})});
    register('regular',true); register('dormant',false);
    pi.registerCommand('active',{handler:async(_args,ctx)=>ctx.ui.notify('active:'+JSON.stringify(pi.getActiveTools()))});
    pi.registerCommand('disable-read',{handler:async()=>pi.setActiveTools(pi.getActiveTools().filter(name=>name!=='read'))});
    pi.registerCommand('register-late',{handler:async()=>{register('late',true);register('late_dormant',false);}});
  };`);
  const model = await fixtureModel(dir, []);
  const toAgent = new TransformStream(), toClient = new TransformStream();
  const server = await startEidoAgent(dir, join(dir, 'sessions'), {readable:toAgent.readable,writable:toClient.writable}, model.runtime);
  let active: string[] = [];
  const connection = client({name:'default-tools-test'})
    .onNotification(methods.client.session.update, ({params}) => {
      const u = params.update;
      if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text' && u.content.text.startsWith('active:')) {
        active = JSON.parse(u.content.text.slice(7));
      }
    }).connect({readable:toClient.readable,writable:toAgent.writable});
  const send = (sessionId: string, command: string) => connection.agent.request(methods.agent.session.prompt,
    {sessionId,prompt:[{type:'text',text:command}]});
  const inspect = async (id: string) => {await send(id, '/active'); assert.ok(!active.includes('powershell')); return active;};
  const newTask = () => connection.agent.request(methods.agent.session.new,{cwd:dir,mcpServers:[]});
  try {
    await connection.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{elicitation:{form:{}}}});
    for (const [configured, expected, dormant, codemode] of [
      [undefined,native,false,false], [[],[],false,false], [['read'],['read'],false,false],
      [['+codemode','-edit'],['read','write','bash'],false,true], [['read','dormant'],['read'],true,false],
    ] as [string[]|undefined,string[],boolean,boolean][]) {
      await configure(configured);
      const saved = await readFile(settingsPath,'utf8');
      const task = await newTask(); await inspect(task.sessionId);
      assert.deepEqual(active.filter(name=>native.includes(name)).sort(), [...expected].sort());
      assert.ok(active.includes('regular')); assert.equal(active.includes('dormant'),dormant);
      assert.equal(active.includes('codemode'),codemode);
      assert.equal(await readFile(settingsPath,'utf8'),saved,'task creation must not rewrite user defaults');
      await connection.agent.request(methods.agent.session.close,{sessionId:task.sessionId});
    }
    await configure(['read']);
    const task = await newTask();
    await send(task.sessionId,'/disable-read'); await send(task.sessionId,'/reload'); await inspect(task.sessionId);
    assert.ok(!active.includes('read'),'unchanged defaults cannot resurrect a disabled native tool');
    await configure(['read','write','codemode']);
    await send(task.sessionId,'/reload'); await inspect(task.sessionId);
    assert.ok(active.includes('write') && active.includes('codemode') && !active.includes('read'));
    await configure([]); await send(task.sessionId,'/reload'); await inspect(task.sessionId);
    assert.ok(active.includes('write'),'removing a default preserves pi current-session semantics');
    await send(task.sessionId,'/register-late'); await inspect(task.sessionId);
    assert.ok(active.includes('late')); assert.ok(!active.includes('late_dormant'));
    await connection.agent.request(methods.agent.session.close,{sessionId:task.sessionId});

    await configure(['+late_dormant']);
    const delayed = await newTask();
    await send(delayed.sessionId,'/register-late'); await inspect(delayed.sessionId);
    assert.ok(active.includes('late_dormant'),'explicit defaults survive delayed registration');
    await connection.agent.request(methods.agent.session.close,{sessionId:delayed.sessionId});
    const disabled = await newTask();
    await send(disabled.sessionId,'/disable-read'); await send(disabled.sessionId,'/register-late'); await inspect(disabled.sessionId);
    assert.ok(!active.includes('late_dormant'),'explicit deactivation clears the pending loadout');
    await configure(['read','late_dormant','new_pending']);
    await send(disabled.sessionId,'/reload'); await send(disabled.sessionId,'/register-late'); await inspect(disabled.sessionId);
    assert.ok(!active.includes('late_dormant'),'unchanged default must not reactivate a disabled pending tool');
    assert.equal(model.requests(),0);
  } finally {await server.agent.dispose(); connection.close(); server.connection.close(); await rm(dir,{recursive:true,force:true});}
});
