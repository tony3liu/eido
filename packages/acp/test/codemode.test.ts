import assert from 'node:assert/strict';
import {test} from 'node:test';
import {deflateSync} from 'node:zlib';
import {mkdtemp,realpath,writeFile,mkdir,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {client,methods} from '@agentclientprotocol/sdk';
import {startEidoAgent} from '../src/server.ts';
import {fixtureModel,call,lastToolText} from './fixture-model.ts';
import {replayEntry} from '../adapter/src/replay.js';
import {promptUsage} from '../adapter/src/usage.js';

const crc=(bytes:Buffer)=>{let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;};
const chunk=(type:string,data:Buffer)=>{const body=Buffer.concat([Buffer.from(type),data]),head=Buffer.alloc(4),end=Buffer.alloc(4);head.writeUInt32BE(data.length);end.writeUInt32BE(crc(body));return Buffer.concat([head,body,end]);};
const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0,255]))),chunk('IEND',Buffer.alloc(0))]);
test('official Code Mode reads native image snapshots, persists nested provenance and rolls back failed store writes', {timeout:30000},async()=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'eido-codemode-')));
 await writeFile(join(dir,'sample.png'),png);
 await writeFile(join(dir,'settings.json'),JSON.stringify({defaultProvider:'eido-fixture',defaultModel:'scripted',defaultTools:['read','codemode'],compaction:{enabled:false}}));
 const model=await fixtureModel(dir,[
  ()=>call('codemode',{code:'const result=await tools.read({path:"sample.png"}); image(result); store("stable",42); text(result.type);'}),
  ctx=>{const output=lastToolText(ctx,'codemode');assert.match(output,/image/);const path=/Image saved to (.+) \(image\//.exec(output)?.[1];assert.ok(path);
    return call('codemode',{code:`const saved=await tools.read({path:${JSON.stringify(path)}}); image(saved); store("stable",99); throw new Error("intentional store rollback");`});},
  ctx=>{assert.throws(()=>lastToolText(ctx,'codemode'),/intentional store rollback/);return call('codemode',{code:'text(load("stable")); text(typeof process);'});},
  ctx=>{assert.match(lastToolText(ctx,'codemode'),/42/);assert.match(lastToolText(ctx,'codemode'),/undefined/);return 'Code Mode verified.';},
 ]);
 const a=new TransformStream(),b=new TransformStream();
 const server=await startEidoAgent(dir,join(dir,'sessions'),{readable:a.readable,writable:b.writable},model.runtime);
 const updates:any[]=[];const permissions:any[]=[];let snapshots=0;
 const conn=client({name:'codemode-test'})
  .onNotification(methods.client.session.update,({params})=>{updates.push(params.update);})
  .onRequest(methods.client.session.requestPermission,({params})=>{permissions.push(params.toolCall);return {outcome:{outcome:'selected',optionId:'allow_once'}};})
  .onRequest('_eido/fs/snapshot',{parse:raw=>raw},({params}:any)=>{snapshots++;assert.equal(params.path,join(dir,'sample.png'));return {content:png.toString('base64'),disk:png.toString('base64'),buffer:null};})
  .onRequest(methods.client.fs.readTextFile,()=>{throw new Error('Images must not use text conversion');})
  .connect({readable:b.readable,writable:a.writable});
 try {
  await conn.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{fs:{readTextFile:true}}});
  const task=await conn.agent.request(methods.agent.session.new,{cwd:dir,mcpServers:[]});
  await conn.agent.request(methods.agent.session.prompt,{sessionId:task.sessionId,prompt:[{type:'text',text:'Verify native image reading in Code Mode.'}]});
  assert.equal(snapshots,1);assert.ok(updates.some(u=>JSON.stringify(u).includes('"type":"image"')));
  const nested=updates.find(u=>u.sessionUpdate==='tool_call'&&u._meta?.parentToolCallId);assert.equal(nested._meta.toolName,'read');
  assert.ok(permissions.some(p=>p._meta?.parentToolCallId===nested._meta.parentToolCallId));
  const entries=(await Promise.all((await readdir(join(dir,'sessions'))).filter(n=>n.endsWith('.jsonl')).map(n=>readFile(join(dir,'sessions',n),'utf8')))).flatMap(t=>t.trim().split('\n').map(line=>JSON.parse(line)));
  const history=entries.flatMap(replayEntry);assert.ok(history.some(u=>u.sessionUpdate==='tool_call'&&u._meta?.parentToolCallId===nested._meta.parentToolCallId));
  const paths=updates.flatMap(u=>u.content??[]).map(c=>c.content?.text??'').join('\n').match(/\/[^\s)]+\.png/g)??[];
  for(const p of paths) {if(p.startsWith('/tmp/')||p.startsWith('/var/'))await rm(p,{force:true}).catch(()=>{});}
 }finally{await server.agent.dispose();conn.close();server.connection.close();await rm(dir,{recursive:true,force:true});}
});

test('prompt tokens include Code Mode tool usage once',()=>{
 const usage=(n:number)=>({input:n,output:1,cacheRead:0,cacheWrite:0,totalTokens:n+1});
 assert.equal(promptUsage([{role:'assistant',usage:usage(10)},{role:'toolResult',usage:usage(20)},{role:'user'}]).totalTokens,32);
});
