import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {postJson,fieldText} from '../src/browser/ultrafast/model.ts';
async function server(t,handle){
  const requests=[];const owned=createServer(async(req,res)=>{
    let data='';for await(const chunk of req)data+=chunk;requests.push(JSON.parse(data));await handle(req,res,requests);
  });
  await new Promise(r=>owned.listen(0,'127.0.0.1',r));
  t.after(()=>{owned.closeAllConnections();return new Promise(r=>owned.close(r));});
  return {config:{apiUrl:`http://127.0.0.1:${owned.address().port}`,model:'fixture',key:'private-fixture-key'},requests};
}
test('HTTP retries only upstream transient status codes, three attempts with 500/1000ms delay',async t=>{
  for(const status of [429,529,503]) {
    const api=await server(t,(_req,res,requests)=>{res.statusCode=requests.length===3?200:status;res.end('{}');});
    const start=performance.now();await postJson(api.config,{});assert.equal(api.requests.length,3);assert.ok(performance.now()-start>=1490);
  }
});
test('provider and connection errors never echo credentials or response secrets; other codes never retry',async t=>{
  for(const status of [400,401,451,500]) {
    const api=await server(t,(_req,res)=>{res.statusCode=status;res.end('private-fixture-key and private-response');});
    await assert.rejects(postJson(api.config,{}),error=>error.message===`Model provider returned HTTP ${status}; no action executed.`);assert.equal(api.requests.length,1);
  }
  const api=await server(t,(req)=>req.socket.destroy());
  await assert.rejects(postJson(api.config,{}),/Model connection failed; no action executed/);assert.equal(api.requests.length,1);
});
test('text helper reasoning and Unicode limits match upstream provider semantics',async t=>{
  const context={goal:'Enter a city',field:{label:'City',role:'textbox',value:''},page:{title:'City',text:''},recent_actions:[]};
  let content=JSON.stringify({text:'🧭'.repeat(2000)});
  const api=await server(t,(_req,res)=>res.end(JSON.stringify({choices:[{message:{content}}]})));
  assert.equal([...(await fieldText(context,api.config)).text].length,2000);
  assert.deepEqual(api.requests[0].reasoning,{effort:'low'});
  await fieldText(context,{...api.config,reasoning:'none'});assert.deepEqual(api.requests[1].reasoning,{enabled:false});
  assert.equal(api.requests[1].max_tokens,1024);assert.deepEqual(api.requests[1].response_format,{type:'json_object'});
  content=JSON.stringify({text:'🧭'.repeat(2001)});await assert.rejects(fieldText(context,api.config),/nothing typed/);
});
