import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {ElicitRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const text=r=>JSON.parse(r.content.find(c=>c.type==='text').text);
const one=(ids,choice)=>({choice,confidence:1,probabilities:Object.fromEntries(Object.keys(ids).map(k=>[k,k===choice?1:0]))});
test('MCP fast loop executes, reports progress, invalidates a closed session and closes on errors', {timeout:30000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'eido-fast-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let hold=false,invalid=false,notifyHold;let received;
  const website=createServer(async(req,res)=>{
    if(req.method==='GET') {res.setHeader('content-type','text/html');res.end('<title>Counter</title><p id="value">Count: 0</p><button onclick="document.getElementById(\'value\').textContent=\'Count: 1\'">Increment</button>');return;}
    let data='';for await(const chunk of req)data+=chunk;
    const body=JSON.parse(data);if(hold){notifyHold?.();return;}
    const op=body.state.page.text.includes('Count: 1')?'DONE':'CLICK';
    const answers={operation:one(body.questions.operation.criteria,op)};
    if(op==='CLICK')answers.click_target=one(body.questions.click_target.criteria,Object.keys(body.questions.click_target.criteria)[0]);
    res.setHeader('content-type','application/json');res.end(JSON.stringify({model:'fixture',answers:invalid?{}:answers}));
  });
  await new Promise(r=>website.listen(0,'127.0.0.1',r));t.after(()=>{website.closeAllConnections();return new Promise(r=>website.close(r));});
  const url=`http://127.0.0.1:${website.address().port}`;
  await writeFile(join(dir,'settings.json'),JSON.stringify({eido:{browserDecision:{apiUrl:url,model:'fixture',engine:'ultrafast'}}}));
  await writeFile(join(dir,'auth.json'),JSON.stringify({'eido-jev':{type:'api_key',key:'fixture-key'}}));
  const transport=new StdioClientTransport({command:process.env.EIDO_BROWSER_TEST_NODE??process.execPath,args:[process.env.EIDO_BROWSER_TEST_ENTRY??fileURLToPath(new URL('../bin/browser-server.mjs',import.meta.url))],env:{...process.env,EIDO_PI_CONFIG_DIR:dir,JEV_BROWSER_HEADED:'0'},stderr:'pipe'});
  transport.stderr?.on('data',()=>{});
  const client=new Client({name:'fast-mcp-test',version:'1'},{capabilities:{elicitation:{form:{}}}});t.after(()=>client.close());await client.connect(transport);
  const call=(name,args={},options={})=>client.callTool({name:'browser_'+name,arguments:args},undefined,options);
  await call('open',{url});
  const progress=[];const result=await call('do',{goal:'Click Increment and observe Count: 1',explain:true},{onprogress:p=>progress.push(p)});
  assert.equal(result.isError,undefined);assert.equal(text(result).status,'likely_done');assert.equal(text(result).actions,1);assert.ok(progress.length>0);
  assert.match(text(await call('snapshot')).snapshot,/Count: 1/);
  // Taking over interrupts a model request, preserves the browser, and discards the decision.
  await call('open',{url});hold=true;received=new Promise(r=>notifyHold=r);
  const stopped=call('do',{goal:'Click Increment'});await received;
  let finishTakeover,openedTakeover;const asked=new Promise(r=>openedTakeover=r);
  client.setRequestHandler(ElicitRequestSchema,()=>{openedTakeover();return new Promise(r=>finishTakeover=r);});
  const takeover=call('takeover',{reason:'Inspect the current page manually'});await asked;
  assert.equal(text(await stopped).status,'needs_user');assert.equal(text(await call('status')).owner,'user');
  assert.equal((await call('act',{action:'click',element:0})).isError,true);
  hold=false;finishTakeover({action:'accept',content:{done:true}});assert.equal(text(await takeover).status,'resumed');
  assert.match(text(await call('snapshot')).snapshot,/Count: 0/);
  // Closing must abort a pending model call and invalidate every response for that browser.
  await call('open',{url});hold=true;received=new Promise(r=>notifyHold=r);
  const pending=call('do',{goal:'Click Increment'});await received;await call('close');
  assert.equal((await pending).isError,true);assert.equal(text(await call('status')).open,false);
  hold=false;await call('open',{url});assert.match(text(await call('snapshot')).snapshot,/Count: 0/);
  invalid=true;assert.equal((await call('do',{goal:'Click Increment'})).isError,true);assert.equal(text(await call('status')).open,false);
  invalid=false;await call('open',{url});const ctrl=new AbortController();hold=true;received=new Promise(r=>notifyHold=r);
  const cancelled=call('do',{goal:'Click Increment'},{signal:ctrl.signal});await received;ctrl.abort();await assert.rejects(cancelled,/abort/i);
  for(let n=0;n<20;n++){if(!text(await call('status')).open)break;await new Promise(r=>setTimeout(r,25));}
  assert.equal(text(await call('status')).open,false);
});
