import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {client, methods} from '@agentclientprotocol/sdk';
import {startEidoAgent} from '../src/server.ts';
import {sessionOwners} from '../src/session-owner.ts';
import {fixtureModel} from './fixture-model.ts';

test('two ACP owners cannot reopen or replay the same task until cleanup; failures release the claim', {timeout:30_000}, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'eido-task-owner-')));
  await writeFile(join(dir, 'settings.json'), JSON.stringify({defaultProvider:'eido-fixture',defaultModel:'scripted',compaction:{enabled:false}}));
  const fixture = await fixtureModel(dir, [() => 'Exactly one delivery.', () => 'Continued after handoff.']);
  async function endpoint() {
    const a = new TransformStream(), b = new TransformStream();
    const server = await startEidoAgent(dir, join(dir,'sessions'), {readable:a.readable,writable:b.writable}, fixture.runtime);
    const output: string[] = [];
    const connection = client({name:'owner-test'}).onNotification(methods.client.session.update, ({params}) => {
      const u=params.update;if(u.sessionUpdate==='agent_message_chunk' && u.content.type==='text')output.push(u.content.text);
    }).connect({readable:b.readable,writable:a.writable});
    await connection.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{}});
    return {server, connection, output};
  }
  const a = await endpoint(), b = await endpoint();
  try {
    const task = await a.connection.agent.request(methods.agent.session.new,{cwd:dir,mcpServers:[]});
    const prompt={sessionId:task.sessionId,prompt:[{type:'text' as const,text:'Once'}]};
    await a.connection.agent.request(methods.agent.session.prompt,prompt);
    const load={sessionId:task.sessionId,cwd:dir,mcpServers:[]};
    await assert.rejects(b.connection.agent.request(methods.agent.session.load,load));
    assert.equal(b.output.length,0);
    await assert.rejects(b.connection.agent.request(methods.agent.session.prompt,prompt));
    assert.equal(fixture.requests(),1);
    await a.connection.agent.request(methods.agent.session.close,{sessionId:task.sessionId});
    await b.connection.agent.request(methods.agent.session.load,load);
    assert.match(b.output.join(''),/Exactly one delivery/);
    await assert.rejects(a.connection.agent.request(methods.agent.session.load,load));
    await b.connection.agent.request(methods.agent.session.prompt,prompt);
    assert.equal(fixture.requests(),2);
    await b.connection.agent.request(methods.agent.session.close,{sessionId:task.sessionId});
    // A loader failure after claiming must not permanently strand a task.
    await writeFile(join(dir,'settings.json'),'invalid settings');
    await assert.rejects(a.connection.agent.request(methods.agent.session.load,load));
    await writeFile(join(dir,'settings.json'),JSON.stringify({defaultProvider:'eido-fixture',defaultModel:'scripted'}));
    await a.connection.agent.request(methods.agent.session.load,load);
    await a.connection.agent.request(methods.agent.session.close,{sessionId:task.sessionId});
    // Fail after creating Pi but before constructing its published wrapper.
    // A failed abort must retain ownership until the hidden cleanup retries.
    const deps=(a.server.agent as any).deps;
    const create=deps.createAgentSession;
    deps.createAgentSession=async (...args:unknown[])=>{
      const result=await create(...args);
      const abort=result.session.abort.bind(result.session);
      let failed=false;
      result.session.abort=async()=>{if(!failed){failed=true;throw new Error('Injected abort failure');}await abort();};
      result.session.subscribe=()=>{throw new Error('Injected wrapper construction failure');};
      return result;
    };
    await assert.rejects(a.connection.agent.request(methods.agent.session.load,load));
    await assert.rejects(b.connection.agent.request(methods.agent.session.load,load));
    deps.createAgentSession=create;
    await a.connection.agent.request(methods.agent.session.close,{sessionId:task.sessionId});
    await b.connection.agent.request(methods.agent.session.load,load);
  } finally {
    for (const e of [a,b]) {await e.server.agent.dispose();e.connection.close();e.server.connection.close();}
    assert.deepEqual(await readdir(join(dir,'session-owners')),[]);
    await rm(dir,{recursive:true,force:true});
  }
});

test('ownership survives contention and recovers only after a crashed process is dead', {timeout:30_000}, async () => {
  const dir=await realpath(await mkdtemp(join(tmpdir(),'eido-owner-crash-')));
  const module=new URL('../src/session-owner.ts',import.meta.url).href;
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',
    `import {sessionOwners} from ${JSON.stringify(module)}; await sessionOwners(process.argv[1])('task'); process.stdout.write('owned\\n'); setInterval(()=>{},1000);`,dir],
    {stdio:['ignore','pipe','pipe']});
  try {
    await once(child.stdout,'data');
    const first=sessionOwners(dir),second=sessionOwners(dir);
    await assert.rejects(first('task'),/already open/);
    const exited=once(child,'exit');child.kill('SIGKILL');await exited;
    const [a,b]=await Promise.allSettled([first('task'),second('task')]);
    assert.equal([a,b].filter(r=>r.status==='fulfilled').length,1);
    const claim=a.status==='fulfilled'?a:b;
    assert.equal(claim.status,'fulfilled');if(claim.status!=='fulfilled')throw new Error('Missing claim');
    await claim.value();await claim.value();
    const release=await second('task');
    const file=(await readdir(join(dir,'session-owners'))).find(n=>n.endsWith('.json'))!;
    assert.equal(JSON.parse(await readFile(join(dir,'session-owners',file),'utf8')).pid,process.pid);
    await release();
  } finally {child.kill('SIGKILL');await rm(dir,{recursive:true,force:true});}
});
