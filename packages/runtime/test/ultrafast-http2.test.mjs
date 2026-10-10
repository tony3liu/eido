import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSecureServer} from 'node:http2';
import {execFileSync,spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
test('model transport negotiates HTTP2 and reuses one persistent TLS connection',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'eido-h2-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const key=join(dir,'key.pem'),cert=join(dir,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-subj','/CN=localhost','-days','1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
  let sessions=0,streams=0;
  const server=createSecureServer({key:await readFile(key),cert:await readFile(cert),allowHTTP1:true});
  server.on('session',session=>{sessions++;t.after(()=>session.destroy());});
  server.on('stream',(stream,headers)=>{streams++;assert.equal(headers.authorization,'Bearer fixture');stream.on('data',()=>{});stream.on('end',()=>{stream.respond({':status':200});stream.end('{}');});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`https://127.0.0.1:${server.address().port}`;
  const module=fileURLToPath(new URL('../src/browser/ultrafast/model.ts',import.meta.url));
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',
    `const {postJson}=await import(${JSON.stringify(module)});await postJson({apiUrl:${JSON.stringify(url)},model:'fixture',key:'fixture'},{});await postJson({apiUrl:${JSON.stringify(url)},model:'fixture',key:'fixture'},{});process.exit(0);`],
    {env:{...process.env,NODE_EXTRA_CA_CERTS:cert,NO_PROXY:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
  let error='';child.stderr.on('data',chunk=>error+=chunk);assert.equal(await new Promise(resolve=>child.once('exit',resolve)),0,error);
  assert.equal(streams,2);assert.equal(sessions,1);
});
