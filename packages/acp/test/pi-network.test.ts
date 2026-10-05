import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {createConnection} from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gzipSync} from 'node:zlib';

test('pi network startup uses its proxy, env precedence, NO_PROXY and reloaded idle timeout', {timeout:25_000}, async t => {
  const dir = await mkdtemp(join(tmpdir(),'eido-pi-network-'));
  const origin = createServer((req,res) => {
    if (req.url === '/slow') { res.writeHead(200); res.write('start'); return; }
    if (req.url === '/held') { res.writeHead(200); res.write('start'); setTimeout(()=>res.end('end'),150); return; }
    res.writeHead(200, {'content-encoding':'gzip', 'content-type':'application/json'});
    res.end(gzipSync(JSON.stringify({ok:true})));
  });
  const tunnels: {target:string; authorization:string|undefined}[] = [];
  const sockets = new Set<import('node:stream').Duplex>();
  const proxy = createServer();
  proxy.on('connect', (req,client,head) => {
    tunnels.push({target:req.url!, authorization:req.headers['proxy-authorization']});
    assert.match(req.url!, /^(eido-proxy\.invalid|127\.0\.0\.1):\d+$/);
    const upstream = createConnection({host:'127.0.0.1',port:Number(req.url!.split(':').at(-1))});
    for(const socket of [client,upstream]) {sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>socket.destroy());}
    upstream.on('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});
  });
  await new Promise<void>(resolve=>origin.listen(0,'127.0.0.1',resolve));
  await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const socket of sockets)socket.destroy();proxy.closeAllConnections();origin.closeAllConnections();proxy.close();origin.close();await rm(dir,{recursive:true,force:true});});
  const originPort = (origin.address() as import('node:net').AddressInfo).port;
  const proxyPort = (proxy.address() as import('node:net').AddressInfo).port;
  const proxyUrl = `http://fixture-user:fixture-password@127.0.0.1:${proxyPort}`;
  const networkModule = new URL('../src/pi-network.ts',import.meta.url).href;
  const settingsModule = new URL('../node_modules/@earendil-works/pi-coding-agent/dist/index.js',import.meta.url).href;
  const undiciModule = new URL('../node_modules/@earendil-works/pi-coding-agent/node_modules/undici/index.js',import.meta.url).href;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key])=>!['http_proxy','https_proxy','all_proxy','no_proxy'].includes(key.toLowerCase())));
  await writeFile(join(dir,'settings.json'),JSON.stringify({httpProxy:proxyUrl,httpIdleTimeoutMs:1000}));
  const script = `
    import assert from 'node:assert/strict';
    import {writeFile} from 'node:fs/promises';
    import {initializePiNetwork,refreshPiNetwork} from ${JSON.stringify(networkModule)};
    import {SettingsManager} from ${JSON.stringify(settingsModule)};
    import {getGlobalDispatcher} from ${JSON.stringify(undiciModule)};
    const directory = process.env.FIXTURE_DIR;
    initializePiNetwork(directory);
    assert.deepEqual(await (await fetch('http://eido-proxy.invalid:${originPort}/ok')).json(),{ok:true});
    const inFlight=await fetch('http://eido-proxy.invalid:${originPort}/held');
    await writeFile(directory+'/settings.json',JSON.stringify({httpProxy:'http://127.0.0.1:1',httpIdleTimeoutMs:50}));
    const settings=SettingsManager.create(directory,directory,{projectTrusted:false});
    refreshPiNetwork(settings);
    assert.equal(await inFlight.text(),'startend');
    // Changing the configured proxy has no effect before a process restart.
    assert.deepEqual(await (await fetch('http://eido-proxy.invalid:${originPort}/ok')).json(),{ok:true});
    await assert.rejects(async()=>{const response=await fetch('http://eido-proxy.invalid:${originPort}/slow',{signal:AbortSignal.timeout(5000)});await response.text();},error=>error.cause?.code==='UND_ERR_BODY_TIMEOUT');
    await getGlobalDispatcher().close();
  `;
  await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',script],{env:{...env,FIXTURE_DIR:dir},timeout:12_000});
  assert.ok(tunnels.length>=2);
  assert.ok(tunnels.every(tunnel=>tunnel.authorization==='Basic '+Buffer.from('fixture-user:fixture-password').toString('base64')));
  tunnels.length=0;
  // The saved proxy points to a dead port, but explicit environment settings win.
  const override = `
    import assert from 'node:assert/strict';
    import {initializePiNetwork} from ${JSON.stringify(networkModule)};
    import {getGlobalDispatcher} from ${JSON.stringify(undiciModule)};
    initializePiNetwork(process.env.FIXTURE_DIR);
    assert.deepEqual(await (await fetch('http://eido-proxy.invalid:${originPort}/ok')).json(),{ok:true});
    assert.deepEqual(await (await fetch('http://127.0.0.1:${originPort}/ok')).json(),{ok:true});
    await getGlobalDispatcher().close();
  `;
  await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',override],{env:{...env,FIXTURE_DIR:dir,HTTP_PROXY:proxyUrl,HTTPS_PROXY:proxyUrl,NO_PROXY:'127.0.0.1'},timeout:8000});
  assert.equal(tunnels.length,1);
  assert.equal(tunnels[0]!.target,`eido-proxy.invalid:${originPort}`);
});
