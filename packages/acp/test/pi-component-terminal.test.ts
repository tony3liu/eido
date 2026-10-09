import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {once} from 'node:events';
import {access} from 'node:fs/promises';
import {dirname} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {methods, type AgentContext, type SessionUpdate} from '@agentclientprotocol/sdk';
import type {AgentSession} from '@earendil-works/pi-coding-agent';
import {getThemeByName} from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import {showPiComponent} from '../src/pi-component-terminal.ts';

function transport(options: {createError?:boolean; delayCreate?:number; exitEarly?:boolean} = {}) {
  let process: ChildProcessWithoutNullStreams | undefined;
  let exited: Promise<unknown> | undefined;
  let path: string | undefined;
  let released = 0;
  let output = '';
  const updates: SessionUpdate[] = [];
  const client = {request: async (method: string, params: any) => {
    if (method === methods.client.terminal.create) {
      path = params.args[1];
      assert.equal(params._meta.eidoPiComponent, true);
      if (options.createError) throw new Error('Cannot create fixture terminal');
      if (options.delayCreate) await delay(options.delayCreate);
      process = spawn(params.command, params.args, {cwd:params.cwd, stdio:'pipe'});
      exited = once(process, 'exit');
      process.stdout.on('data', data => {output += data;});
      if (options.exitEarly) setTimeout(() => process?.kill(), 40);
      return {terminalId:'fixture-terminal'};
    }
    if (method === methods.client.terminal.waitForExit) {await exited;return {exitCode:0};}
    assert.equal(method, methods.client.terminal.release);
    released++;
    process?.kill();
    await exited;
    return {};
  }} as unknown as AgentContext;
  const pi = {sessionId:'fixture-task', sessionManager:{getCwd:() => processCwd}} as unknown as AgentSession;
  const run: typeof showPiComponent = (...args) => showPiComponent(...args);
  const start = <T>(factory: Parameters<typeof showPiComponent<T>>[4], options?: Parameters<typeof showPiComponent<T>>[5], signal?:AbortSignal) =>
    run<T>(pi, client, getThemeByName('dark')!, processCwd, factory, options, update => updates.push(update), signal);
  return {start, updates, send:(input:string|Buffer) => process!.stdin.write(input),
    waitFor:async (text:string) => {
      for(let i=0;i<200;i++) {if(output.includes(text)) return; await delay(10);}
      assert.fail(`Missing terminal output ${text}: ${output}`);
    },
    clean:async (expectedReleases=1) => {
      await exited;
      assert.equal(released,expectedReleases);
      assert.equal(process?.exitCode !== null || process?.signalCode !== null,true);
      if(path) await assert.rejects(access(dirname(path)));
    },
  };
}
const processCwd = process.cwd();

test('real component terminal handles split UTF-8, arrow keys and paste, then releases its process', {timeout:10_000}, async () => {
  const t=transport();
  let disposed=0;
  const input:string[]=[];
  const result=t.start<string>((tui,_theme,_keys,done) => {
    tui.terminal.setProgramStatus({state:'working'});
    return ({
    render:() => ['PI COMPONENT READY'], invalidate() {}, dispose() {disposed++;},
    handleInput(data) {input.push(data); if(data==='\r') done('accepted'); else tui.requestRender();},
  });});
  await t.waitFor('PI COMPONENT READY');
  const bytes=Buffer.from('蓝');
  t.send(bytes.subarray(0,1)); await delay(5); t.send(bytes.subarray(1));
  t.send('\x1b['); await delay(5); t.send('B');
  t.send('\x1b[200~multiline\ntext\x1b[201~'); t.send('\r');
  assert.equal(await result,'accepted');
  assert.deepEqual(input,['蓝','\x1b[B','\x1b[200~multiline\ntext\x1b[201~','\r']);
  assert.equal(disposed,1);
  assert.equal(t.updates.at(-1)?.sessionUpdate,'tool_call_update');
  await t.clean();
});

test('overlay exposes a real handle and returns the plugin result', {timeout:10_000}, async () => {
  const t=transport(); let handle=false;
  const result=t.start<number>((_tui,_theme,_keys,done) => ({render:()=>['OVERLAY READY'],invalidate(){},handleInput(){done(7);}}),
    {overlay:true,overlayOptions:()=>({width:40}),onHandle:value=>{handle=value.isFocused();}});
  await t.waitFor('OVERLAY READY'); t.send('x');
  assert.equal(await result,7); assert.equal(handle,true); await t.clean();
});

test('Ctrl+C cancels an interface and disposes it', {timeout:10_000}, async () => {
  const t=transport(); let disposed=0;
  const result=t.start(()=>({render:()=>['CANCEL READY'],invalidate(){},dispose(){disposed++;}}));
  const rejected=assert.rejects(result,/cancelled/);
  await t.waitFor('CANCEL READY'); t.send('\x03'); await rejected;
  assert.equal(disposed,1); await t.clean();
});

test('aborting during an async component factory disposes its late result', {timeout:10_000}, async () => {
  const t=transport(), controller=new AbortController(); let entered!:()=>void, complete!:()=>void, disposed=0;
  const began=new Promise<void>(resolve=>{entered=resolve;});
  const gate=new Promise<void>(resolve=>{complete=resolve;});
  const result=t.start(async()=>{entered(); await gate; return {render:()=>[],invalidate(){},dispose(){disposed++;}};},undefined,controller.signal);
  const rejected=assert.rejects(result,/cancelled/);
  await began; controller.abort(); await rejected; complete(); await delay(10);
  assert.equal(disposed,1); await t.clean();
});

test('a factory may call done before its async result resolves', {timeout:10_000}, async () => {
  const t=transport(); let complete!:()=>void, disposed=0;
  const gate=new Promise<void>(resolve=>{complete=resolve;});
  const result=t.start<string>(async(_tui,_theme,_keys,done)=>{done('early'); await gate; return {render:()=>[],invalidate(){},dispose(){disposed++;}};});
  assert.equal(await result,'early'); complete(); await delay(10);
  assert.equal(disposed,1); await t.clean();
});

test('terminal creation and rendering failures clean up and do not kill the harness', {timeout:10_000}, async () => {
  const failed=transport({createError:true});
  await assert.rejects(failed.start(()=>({render:()=>[],invalidate(){}})),/Cannot create/);
  await failed.clean(0);
  const broken=transport();
  await assert.rejects(broken.start(()=>({render(){throw new Error('Plugin render failed');},invalidate(){}})),/Plugin render failed/);
  await broken.clean();
});

test('cancellation while terminal creation is pending releases the late terminal', {timeout:10_000}, async () => {
  const t=transport({delayCreate:100}),controller=new AbortController();
  const result=t.start(()=>({render:()=>[],invalidate(){}}),undefined,controller.signal);
  const rejected=assert.rejects(result,/cancelled/);
  await delay(25); controller.abort(); await rejected; await delay(200); await t.clean();
});

test('helper exit interrupts an unfinished interface and frees its socket', {timeout:10_000}, async () => {
  const t=transport({exitEarly:true});
  await assert.rejects(t.start(()=>({render:()=>['WAIT'],invalidate(){}})),/closed/); await t.clean();
});
