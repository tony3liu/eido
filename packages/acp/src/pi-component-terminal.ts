import {createServer, type Socket} from 'node:net';
import {chmod, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {methods, type AgentContext, type SessionUpdate} from '@agentclientprotocol/sdk';
import {StringDecoder} from 'node:string_decoder';
import {StdinBuffer, TuiMainScreen, type Component, type Terminal} from '@earendil-works/pi-tui';
import type {AgentSession, ExtensionUIContext, Theme} from '@earendil-works/pi-coding-agent';
import {KeybindingsManager} from '../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js';

const helper = fileURLToPath(new URL('../../../scripts/pi-component-terminal.mjs', import.meta.url));

/** Run the plugin's real TUI in Zed's existing terminal, without starting another harness. */
export async function showPiComponent<T>(pi: AgentSession, client: AgentContext, theme: Theme, agentDir: string,
  factory: Parameters<ExtensionUIContext['custom']>[0], options: Parameters<ExtensionUIContext['custom']>[1],
  emit: (update: SessionUpdate) => void, signal?: AbortSignal): Promise<T> {
  const directory = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'eido-pi-ui-'));
  await chmod(directory, 0o700);
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\eido-pi-ui-${randomUUID()}` : join(directory, 'view.sock');
  const server = createServer();
  let socket: Socket | undefined, terminalId: string | undefined, component: (Component & {dispose?():void}) | undefined;
  let onInput: (data: string) => void = () => {};
  let onResize: () => void = () => {};
  let columns = 80, rows = 24;
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve,reject) => {resolveReady=resolve; rejectReady=reject;});
  // Attach a rejection observer while terminal/create is still in flight.
  void ready.catch(() => {});
  let settled = false, closing = false, started = false;
  let resolveDone!: (result:T) => void, rejectDone!: (error:Error) => void;
  const done = new Promise<T>((resolve,reject) => {resolveDone=resolve; rejectDone=reject;});
  void done.catch(() => {});
  const fail = (error:Error) => {rejectReady(error); if (!settled) {settled=true; rejectDone(error);}};
  const finish = (result:unknown) => {if (!settled) {settled=true; resolveDone(result as T);}};
  const abort = () => fail(new Error('Extension interface cancelled.'));
  const write = (data:string) => {socket?.write(data);};
  const input = new StdinBuffer();
  const decoder = new StringDecoder('utf8');
  input.on('data', data => {try {if (data === '\x03') abort(); else onInput(data);} catch (error) {fail(asError(error));}});
  input.on('paste', data => {try {onInput(`\x1b[200~${data}\x1b[201~`);} catch (error) {fail(asError(error));}});
  const terminal: Terminal = {
    start(input, resize) {onInput=input; onResize=resize; write('\x1b[?2004h');},
    stop() {onInput=()=>{}; onResize=()=>{}; write('\x1b[?2004l');},
    drainInput: async () => {}, write,
    get columns() {return columns;}, get rows() {return rows;}, get kittyProtocolActive() {return false;},
    moveBy: lines => write(`\x1b[${Math.abs(lines)}${lines > 0 ? 'B':'A'}`),
    hideCursor: () => write('\x1b[?25l'), showCursor: () => write('\x1b[?25h'),
    clearLine: () => write('\x1b[2K'), clearFromCursor: () => write('\x1b[J'), clearScreen: () => write('\x1b[2J\x1b[H'),
    setTitle: title => write(`\x1b]0;${title.replace(/[\x00-\x1f\x7f]/g, '')}\x07`), setProgress() {},
  };
  // Renderer exceptions must fail this view instead of crashing the shared ACP process.
  class ComponentScreen extends TuiMainScreen {
    protected override doRender() {try {super.doRender();} catch (error) {fail(asError(error));}}
  }
  const tui = new ComponentScreen(terminal, true);
  const callId = `pi-ui-${randomUUID()}`;
  const timeout = setTimeout(() => fail(new Error('Extension terminal did not become ready.')), 15_000);
  server.on('error', fail);
  server.on('connection', connection => {
    if (socket) {connection.destroy(); return;}
    socket=connection;
    let buffered='';
    connection.setEncoding('utf8');
    connection.on('error', fail);
    connection.on('close', () => fail(new Error('Extension terminal closed.')));
    connection.on('data', chunk => {
      buffered += chunk;
      if (buffered.length > 4 * 1024 * 1024) {fail(new Error('Extension terminal input is too large.')); connection.destroy(); return;}
      let newline:number;
      while (!closing && (newline=buffered.indexOf('\n')) >= 0) {
        const line=buffered.slice(0,newline); buffered=buffered.slice(newline+1);
        try {
          const event=JSON.parse(line);
          if (event.type==='resize' && Number.isInteger(event.columns) && Number.isInteger(event.rows)) {
            columns=Math.max(10, Math.min(event.columns, 1000)); rows=Math.max(3,Math.min(event.rows,500));
            clearTimeout(timeout); resolveReady(); onResize();
          } else if (event.type==='input' && typeof event.data==='string') {
            const decoded=decoder.write(Buffer.from(event.data,'base64'));
            if (decoded) input.process(decoded);
          }
        } catch (error) {fail(error instanceof Error ? error : new Error(String(error)));}
      }
    });
  });
  signal?.addEventListener('abort', abort, {once:true});
  let success=false;
  let operationError: unknown;
  const exitWatch = new AbortController();
  const release = (id:string) => client.request(methods.client.terminal.release,
    {sessionId:pi.sessionId,terminalId:id},{cancellationSignal:AbortSignal.timeout(5000)});
  try {
    signal?.throwIfAborted();
    await new Promise<void>((resolve,reject) => {server.once('error',reject); server.listen(socketPath, () => {server.off('error',reject); resolve();});});
    if (process.platform !== 'win32') await chmod(socketPath, 0o600);
    emit({sessionUpdate:'tool_call', toolCallId:callId, title:'Extension interface', kind:'other', status:'in_progress',
      content:[{type:'content',content:{type:'text',text:'Use the embedded terminal to interact with this pi extension. Ctrl+C closes it.'}}]});
    // Own a late response as well, so cancellation never leaks the terminal process.
    const creatingTerminal=client.request(methods.client.terminal.create,{sessionId:pi.sessionId,command:process.execPath,
      args:[helper,socketPath],cwd:pi.sessionManager.getCwd(),outputByteLimit:256*1024,_meta:{eidoPiComponent:true}})
      .then(async created => {
        if (closing) {await release(created.terminalId); return;}
        terminalId=created.terminalId;
      });
    void creatingTerminal.catch(error => {if (closing) console.error('Late extension terminal cleanup failed', error);});
    await Promise.race([creatingTerminal, done]);
    if (!terminalId) throw new Error('Extension terminal creation was interrupted.');
    void client.request(methods.client.terminal.waitForExit,{sessionId:pi.sessionId,terminalId},
      {cancellationSignal:exitWatch.signal}).then(() => {
        if (!closing) fail(new Error('Extension terminal closed.'));
      }, error => {if (!closing) fail(asError(error));});
    emit({sessionUpdate:'tool_call_update',toolCallId:callId,content:[{type:'terminal',terminalId}]});
    signal?.throwIfAborted();
    await ready;
    tui.start(); started=true;
    const creating=Promise.resolve(factory(tui,theme,KeybindingsManager.create(agentDir),finish));
    const interrupted=done.then(result => ({result}));
    let outcome: {component: Component & {dispose?():void}} | {result:T};
    try {outcome=await Promise.race([creating.then(component => ({component})),interrupted]);}
    catch (error) {void creating.then(late => late.dispose?.()).catch(() => {}); throw error;}
    if ('result' in outcome) {
      void creating.then(late => late.dispose?.()).catch(error => console.error('Late extension component cleanup failed', error));
      success=true;
      return outcome.result;
    }
    component=outcome.component;
    if (!settled) {
      if (options?.overlay) {
        const overlay=tui.showOverlay(component,typeof options.overlayOptions==='function' ? options.overlayOptions():options.overlayOptions);
        options.onHandle?.(overlay);
      } else {tui.addChild(component); tui.setFocus(component);}
      tui.requestRender();
    }
    const result=await done;
    success=true;
    return result;
  } catch (error) {operationError=error; throw error;}
  finally {
    settled=true; closing=true; exitWatch.abort();
    clearTimeout(timeout);
    signal?.removeEventListener('abort',abort);
    let cleanupError: unknown;
    try {component?.dispose?.();} catch (error) {cleanupError=error;}
    try {if (started) tui.stop();} catch (error) {cleanupError??=error;}
    input.destroy();
    socket?.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (terminalId) {
      try {await release(terminalId);}
      catch (error) {cleanupError??=error;}
    }
    await rm(directory,{recursive:true,force:true});
    emit({sessionUpdate:'tool_call_update',toolCallId:callId,status:success && !cleanupError?'completed':'failed'});
    if (cleanupError) throw operationError ? new AggregateError([operationError,cleanupError], 'Extension interface and cleanup failed.') : cleanupError;
  }
}

function asError(error:unknown):Error {return error instanceof Error ? error : new Error(String(error));}
