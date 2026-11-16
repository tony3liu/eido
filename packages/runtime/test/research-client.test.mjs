import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {ResearchClient,searchInput,fetchInput} from '../src/research/client.mjs';
import {parseOcrResponse} from '../src/research/ocr.mjs';
import {ResearchUsage} from '../src/research/usage.mjs';

async function setup(t,handler,limits={}) {
  const directory=await mkdtemp(join(tmpdir(),'eido-research-http-')),requests=[];
  const server=createServer(async(req,res)=>{const chunks=[];for await(const part of req)chunks.push(part);requests.push({url:req.url,headers:req.headers,body:Buffer.concat(chunks)});handler(req,res,requests);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await writeFile(join(directory,'settings.json'),JSON.stringify({eido:{research:{schemaVersion:1,enabled:true,revision:1,baseUrl:`http://127.0.0.1:${server.address().port}/v1`,limits}}}));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
  let auth=0,settled=0;
  const client=new ResearchClient({directory,modelRuntime:{async getAuth(provider){assert.equal(provider,'deepseek');auth++;return {auth:{apiKey:'local-fixture-token'}};},async settleCredentialWrites(){settled++;}}});
  return {client,directory,requests,auth:()=>auth,settled:()=>settled,context:{ownerSession:'test-task',turnId:'turn',operationId:'op'}};
}
test('Search and Fetch use independent Bearer auth, bounded retry and exact accounting',async t=>{
  const f=await setup(t,(_req,res,requests)=>{res.setHeader('Content-Type','application/json');if(requests.length===1){res.statusCode=429;res.end('{"error":"rate"}');}else if(requests.at(-1).url.endsWith('search'))res.end(JSON.stringify({results:[{title:'Docs',url:'https://example.com',summary:'Summary only'}]}));else res.end(JSON.stringify({title:'Docs',content:'Actual original 😀 body'}));});
  const search=await f.client.request('search',{query:'资料 😀',count:5},f.context);assert.equal(search.attempts.length,2);assert.equal(search.data.results.length,1);
  const fetched=await f.client.request('fetch',{url:'https://example.com'},{...f.context,operationId:'op-2'});assert.match(fetched.data.content,/original/);
  assert.equal(f.requests.length,3);assert.equal(f.auth(),3);assert.equal(f.settled(),3);
  assert.deepEqual(JSON.parse(f.requests[0].body),{query:'资料 😀',count:5,need_content:false});assert.equal(f.requests[0].headers.authorization,'Bearer local-fixture-token');
  const usage=await new ResearchUsage(f.directory).summary();assert.equal(usage.global.attempts,3);assert.equal(usage.global.successful,2);assert.equal(usage.global.estimatedCny,.01);
  const persisted=await readFile(join(f.directory,'research/v1/usage.json'),'utf8');assert.doesNotMatch(persisted,/token|资料|example.com/);
});
test('HTTP 200 errors, no results and missing credentials never become read sources',async t=>{
  const f=await setup(t,(_req,res,requests)=>res.end(requests.length===1?'{"error":{"message":"private-token-must-not-escape"}}':'{"results":[]}'));
  await assert.rejects(f.client.request('search',{query:'one'},f.context),error=>error.code==='service_error'&&!error.message.includes('private-token'));
  await f.client.request('search',{query:'none'},{...f.context,operationId:'none'});
  const usage=await new ResearchUsage(f.directory).summary();assert.equal(usage.global.estimatedCny,0);assert.equal(usage.global.attempts,2);
  const client=new ResearchClient({directory:f.directory});await assert.rejects(client.request('fetch',{url:'https://example.com'},f.context),{code:'not_configured'});assert.equal(f.requests.length,2);
});
test('OCR multipart accepts newline keepalive; unknown disconnect has no automatic retry',async t=>{
  const f=await setup(t,(_req,res,requests)=>{if(requests.length===1){res.write('\n\n');res.end(JSON.stringify({page_count:1,pages:[{index:0,text:'<｜ref｜>中文😀<｜/ref｜><｜box｜>[[10,20,300,400]]<｜/box｜>',finish_reason:'length'}]}));}else res.destroy();});
  const png=Buffer.from([137,80,78,71,13,10,26,10]);
  const first=await f.client.request('ocr',{png},f.context);assert.equal(first.partial,true);const form=f.requests[0].body.toString();assert.match(form,/name="file"; filename="page.png"/);assert.match(form,/name="purpose"\r\n\r\ntext_recognition/);assert.doesNotMatch(form,/name="(model|prompt)"/);
  await assert.rejects(f.client.request('ocr',{png},{...f.context,operationId:'unknown'}),{code:'unavailable'});assert.equal(f.requests.length,2);
  const usage=await new ResearchUsage(f.directory).summary();assert.equal(usage.global.unknown,1);assert.equal(usage.global.unknownMaximumCny,.0015);assert.equal(usage.global.ocrPages,2);
});
test('response limit and timeout are unknown, invalid input dispatches nothing',async t=>{
  const f=await setup(t,(_req,res,requests)=>{if(requests.length===1)res.end('x'.repeat(1100));},{responseBytes:1024,searchTimeoutMs:1000});
  await assert.rejects(f.client.request('search',{query:'x'},f.context),{code:'response_limit'});
  await assert.rejects(f.client.request('fetch',{url:'https://example.com'},{...f.context,operationId:'timeout'}),{code:'interrupted_unknown'});
  assert.throws(()=>searchInput({query:'😀'.repeat(129)}));assert.throws(()=>fetchInput({url:'https://user:secret@example.com'}));assert.equal(searchInput({query:'😀'.repeat(128)}).count,5);assert.equal(f.requests.length,2);
});
for(const boundary of ['caller cancellation','deadline','deadline then caller cancellation','unavailable'])test(`before dispatch: ${boundary} preserves its cause and releases the reservation`,async t=>{
  const f=await setup(t,(_req,res)=>res.end('{"results":[]}'),{searchTimeoutMs:1000});
  const controller=new AbortController();let fetchCalls=0;
  const fetchImpl=f.client.fetch;f.client.fetch=(...args)=>{fetchCalls++;return fetchImpl(...args);};
  await assert.rejects(f.client.request('search',{query:'reserved'},{...f.context,signal:controller.signal,onAttempt:async attempt=>{
    assert.equal(attempt.status,'reserved');
    if(boundary==='caller cancellation')controller.abort();
    else if(boundary==='unavailable')throw new Error('local notification failed');
    else {await delay(1100);if(boundary==='deadline then caller cancellation')controller.abort();}
  }}),{code:boundary==='caller cancellation'?'cancelled_local':boundary==='unavailable'?'unavailable':'interrupted_unknown'});
  assert.equal(fetchCalls,0);assert.equal(f.requests.length,0);
  const ledger=JSON.parse(await readFile(join(f.directory,'research/v1/usage.json'),'utf8'));
  assert.equal(ledger.attempts.length,1);assert.equal(ledger.attempts[0].status,'cancelled_local');assert.equal(ledger.attempts[0].billingState,'not_dispatched');assert.equal(ledger.attempts[0].dispatchedAt,undefined);
  const usage=await new ResearchUsage(f.directory).summary();assert.equal(usage.global.attempts,0);assert.equal(usage.global.unknown,0);assert.equal(usage.global.estimatedCny,0);assert.equal(usage.global.unknownMaximumCny,null);
});
test('caller cancellation after dispatch stays unknown and never retries',async t=>{
  const controller=new AbortController();
  const f=await setup(t,()=>controller.abort());
  await assert.rejects(f.client.request('search',{query:'dispatched'},{...f.context,signal:controller.signal}),{code:'interrupted_unknown'});
  assert.equal(f.requests.length,1);
  const ledger=JSON.parse(await readFile(join(f.directory,'research/v1/usage.json'),'utf8'));
  assert.equal(ledger.attempts.length,1);assert.equal(ledger.attempts[0].status,'interrupted_unknown');assert.equal(ledger.attempts[0].billingState,'unknown');assert.ok(ledger.attempts[0].dispatchedAt);
  const usage=await new ResearchUsage(f.directory).summary();assert.equal(usage.global.attempts,1);assert.equal(usage.global.unknown,1);assert.equal(usage.global.unknownMaximumCny,.005);
});
test('OCR mappings are exact UTF-8 offsets and invalid/unknown boxes remain unlocated',()=>{
  const parse=(text,finish_reason='stop')=>parseOcrResponse({page_count:1,pages:[{index:0,text,finish_reason}]},2);
  const page=parse('前\n<｜ref｜>标题😀<｜/ref｜><｜box｜>[[52,40,948,96]]<｜/box｜>\n后');
  assert.equal(page.text,'前\n标题😀\n后');assert.equal(page.regions[1].start,Buffer.byteLength('前\n'));assert.equal(page.regions[1].end,Buffer.byteLength('前\n标题😀'));assert.equal(page.regions[1].pageIndex,2);
  assert.equal(parse('<｜ref｜>x<｜/ref｜><｜box｜>[[1001,0,3,4]]<｜/box｜>').regionState,'unlocated');
  assert.equal(parse('<det>0 0 10 10</det>x').regionState,'unlocated');
  assert.throws(()=>parseOcrResponse({page_count:1,pages:[{index:1,text:'x',finish_reason:'stop'}]},0),{code:'invalid_response'});
  assert.throws(()=>parseOcrResponse({page_count:2,pages:[{index:0,text:'x',finish_reason:'stop'},{index:0,text:'x',finish_reason:'stop'}]},0));
});
