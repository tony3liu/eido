import {createServer, type ServerResponse} from 'node:http';
import {mkdtemp, mkdir, writeFile, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {client, methods} from '@agentclientprotocol/sdk';
import {startEidoAgent} from '../src/server.ts';
import {fixtureModel, type FixtureStep} from './fixture-model.ts';
import {createExtensionCenter} from '../../runtime/src/pi/extensions.mjs';

/** Real HTTP transport; scripted responses never leave the loopback interface. */
export async function policyRemote() {
  const streams = new Set<ServerResponse>();
  const timers = new Set<ReturnType<typeof setInterval>>();
  const calls: string[] = [];
  let mode: 'normal'|'unauthorized'|'bad-catalog'|'hang-open' = 'normal';
  let names = ['ping', 'slow', 'progress'];
  let initialized = 0;
  let announceTools = false;
  const http = createServer(async (req, res) => {
    if (mode === 'unauthorized') {res.writeHead(401, {'www-authenticate':'Bearer'}).end(); return;}
    if (req.method === 'GET') {res.writeHead(405).end(); return;}
    if (req.method === 'DELETE') {res.writeHead(200).end(); return;}
    let body = ''; for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) {res.writeHead(202).end(); return;}
    if (mode === 'hang-open' && message.method === 'initialize') {streams.add(res); res.on('close', () => streams.delete(res)); return;}
    let result: unknown = {};
    if (message.method === 'initialize') {initialized++; result = {protocolVersion:'2025-03-26', capabilities:{tools:{listChanged:true}}, serverInfo:{name:'Eido policy fixture', version:'1'}, instructions:'Use these local fixtures for policy tests.'};}
    if (message.method === 'tools/list') result = {tools: (mode === 'bad-catalog' ? ['ping','ping'] : names).map(name => ({name, description:`${name} fixture marker`, inputSchema:{type:'object', properties:{}}}))};
    if (message.method === 'tools/call') {
      calls.push(message.params.name);
      result = {content:[{type:'text', text:`${message.params.name} fixture reached`}]};
      if (announceTools) {
        announceTools = false;
        res.writeHead(200, {'content-type':'text/event-stream'});
        res.write(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',method:'notifications/tools/list_changed'})}\n\n`);
        res.end(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',id:message.id,result})}\n\n`);
        return;
      }
      if (['slow','progress'].includes(message.params.name)) {
        res.writeHead(200, {'content-type':'text/event-stream', 'cache-control':'no-cache'});
        res.write(': waiting\n\n'); streams.add(res);
        let tick = 0;
        const timer = setInterval(() => {
          if (++tick === 8) {
            clearInterval(timer); timers.delete(timer);
            res.end(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0', id:message.id, result})}\n\n`);
          } else if (message.params.name === 'progress') {
            res.write(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0', method:'notifications/progress', params:{progressToken:message.params._meta?.progressToken, progress:tick, total:8}})}\n\n`);
          }
        }, 75);
        timers.add(timer);
        res.on('close', () => {clearInterval(timer); timers.delete(timer); streams.delete(res);});
        return;
      }
    }
    res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0', id:message.id, result}));
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  return {
    url:`http://127.0.0.1:${address.port}/mcp`, calls, streams, initialized:()=>initialized,
    mode(value:typeof mode) {mode = value;}, tools(value:string[]) {names = value;},
    changeTools(value:string[]) {names = value; announceTools = true;},
    async close() {for (const timer of timers) clearInterval(timer); for (const stream of streams) stream.end(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));},
  };
}

export async function mcpHarness(config: unknown, steps: FixtureStep[], extension?: string) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'eido-mcp-policy-')));
  const toAgent = new TransformStream(), toClient = new TransformStream();
  await mkdir(join(dir, 'work'));
  await writeFile(join(dir, 'settings.json'), JSON.stringify({defaultProvider:'eido-fixture', defaultModel:'scripted', compaction:{enabled:false}}));
  await writeFile(join(dir, 'mcp.json'), JSON.stringify(config));
  if (extension) {await mkdir(join(dir, 'extensions')); await writeFile(join(dir, 'extensions/fixture.js'), extension);}
  const model = await fixtureModel(dir, steps);
  const release = await createExtensionCenter(dir).acquireRuntime();
  const active = await startEidoAgent(dir, join(dir, 'sessions'), {readable:toAgent.readable, writable:toClient.writable}, model.runtime);
  const updates: unknown[] = [], permissions: string[] = [];
  let reject: string|undefined;
  const connection = client({name:'eido-mcp-policy-test'})
    .onNotification(methods.client.session.update, ({params}) => {updates.push(params);})
    .onRequest(methods.client.session.requestPermission, ({params}) => {
      const name = String(params.toolCall._meta?.toolName); permissions.push(name);
      return {outcome:{outcome:'selected', optionId: name === reject ? 'reject_once' : 'allow_once'}};
    }).connect({readable:toClient.readable, writable:toAgent.writable});
  await connection.agent.request(methods.agent.initialize, {protocolVersion:1, clientCapabilities:{}});
  return {
    dir, active, connection, updates, permissions, model,
    reject(name: string|undefined) {reject = name;},
    newTask: () => connection.agent.request(methods.agent.session.new, {cwd:join(dir, 'work'), mcpServers:[]}),
    prompt: (sessionId:string, text = 'Run the policy check.') => connection.agent.request(methods.agent.session.prompt, {sessionId, prompt:[{type:'text', text}]}),
    async close() {await active.agent.dispose(); connection.close(); active.connection.close(); await release(); await rm(dir, {recursive:true, force:true});},
  };
}
