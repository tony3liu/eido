import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBrowserTextModel} from '../src/browser/text-model.mjs';
import {browserTextSettings,browserDecisionEnvironment} from '../src/browser/config.mjs';
import {fieldText} from '../src/browser/ultrafast/model.ts';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileURLToPath} from 'node:url';
const context={goal:'Search for 凡人修仙传',field:{label:'Search'},page:{title:'Search',text:'Search'},recent_actions:[]};
const choice=(ids,selected)=>({choice:selected,confidence:1,probabilities:Object.fromEntries(Object.keys(ids).map(k=>[k,Number(k===selected)]))});
const parsed=r=>JSON.parse(r.content.find(c=>c.type==='text').text);
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'eido-shared-browser-text-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const requests=[];let output={text:'凡人修仙传'},fail=false,hold=false,held;
 const site=createServer(async(req,res)=>{
  if(req.method==='GET'){res.setHeader('content-type','text/html; charset=utf-8');res.end('<title>Search fixture</title><input aria-label="Search"><button onclick="document.querySelector(\'#result\').textContent=\'Result: \'+document.querySelector(\'input\').value">Search</button><p id="result"></p>');return;}
  let data='';for await(const chunk of req)data+=chunk;const body=JSON.parse(data);requests.push({path:req.url,authorization:req.headers.authorization,body});
  if(body.questions){
   const op=body.state.page.text.includes('Result: 凡人修仙传')?'DONE':body.state.elements.some(e=>e.value==='凡人修仙传')?'CLICK':'TYPE_TEXT';
   const answers={operation:choice(body.questions.operation.criteria,op)};
   if(op!=='DONE'){const head=op.toLowerCase()+'_target',targets=body.questions[head].criteria;answers[head]=choice(targets,Object.keys(targets).find(k=>op!=='CLICK'||targets[k].role==='button')??Object.keys(targets)[0]);}
   res.setHeader('content-type','application/json');res.end(JSON.stringify({model:'fixture',answers}));return;
  }
  if(hold){held?.();return;}if(fail){res.writeHead(401);res.end('secret provider response');return;}
  res.setHeader('content-type','text/event-stream');
  const emit=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta,finish_reason}]})+'\n\n');
  emit({role:'assistant',content:JSON.stringify(output)});emit({},'stop');res.end('data: [DONE]\n\n');
 });
 await new Promise(r=>site.listen(0,'127.0.0.1',r));t.after(()=>{site.closeAllConnections();return new Promise(r=>site.close(r));});
 const url=`http://127.0.0.1:${site.address().port}`;
 await writeFile(join(directory,'settings.json'),JSON.stringify({defaultProvider:'main-fixture',defaultModel:'main-model',eido:{browserDecision:{apiUrl:url+'/jev',model:'fixture'}}}));
 await writeFile(join(directory,'models.json'),JSON.stringify({providers:{'main-fixture':{api:'openai-completions',baseUrl:url+'/custom/v1',models:[{id:'main-model',name:'Main',reasoning:false,contextWindow:32000,maxTokens:2048}]}}}));
 await writeFile(join(directory,'auth.json'),JSON.stringify({'main-fixture':{type:'api_key',key:'main-secret'},'eido-jev':{type:'api_key',key:'jev-secret'}}));
 return {directory,url,requests,output:v=>output=v,fail:v=>fail=v,hold:v=>hold=v,held:fn=>held=fn};
}
test('browser text reuses the main pi provider/auth and custom endpoint without exporting its key',async t=>{
 const f=await fixture(t),status=await browserTextSettings(f.directory);
 assert.equal(status.source,'pi');assert.equal(status.model,'main-model');assert.equal(status.credential,'configured');assert.ok(!JSON.stringify(status).includes('main-secret'));
 const env=await browserDecisionEnvironment(f.directory);assert.equal(env.TEXT_MODEL_SOURCE,'pi');assert.equal(env.TEXT_MODEL_API_KEY,'');assert.ok(!JSON.stringify(env).includes('main-secret'));
 const text=await createBrowserTextModel(f.directory),result=await fieldText(context,text);
 assert.equal(result.text,'凡人修仙传');assert.equal(result.helper.model,'main-model');
 const req=f.requests.at(-1);assert.equal(req.path,'/custom/v1/chat/completions');assert.equal(req.authorization,'Bearer main-secret');assert.equal(req.body.model,'main-model');assert.ok(req.body.messages.some(m=>{try{return JSON.parse(m.content).goal===context.goal;}catch{return false;}}));assert.equal(req.body.tools,undefined);
 f.output({text:'',extra:true});await assert.rejects(fieldText(context,text),/no valid field value/);
 f.fail(true);await assert.rejects(fieldText(context,text),e=>/main language model/.test(e.message)&&!e.message.includes('secret'));
 f.fail(false);f.hold(true);const ctrl=new AbortController(),held=new Promise(r=>f.held(r)),pending=fieldText(context,text,ctrl.signal);await held;ctrl.abort(new Error('User cancelled'));await assert.rejects(pending,/User cancelled/);
});
test('MCP Ultrafast uses the shared main model only for TYPE_TEXT and verifies real page input', {timeout:30000},async t=>{
 const f=await fixture(t);
 // Include a final-result prefix so the independent fixture decision is unambiguous.
 // The result marker is written by the button, not by the service response.
 const transport=new StdioClientTransport({command:process.env.EIDO_BROWSER_TEST_NODE??process.execPath,args:[process.env.EIDO_BROWSER_TEST_ENTRY??fileURLToPath(new URL('../bin/browser-server.mjs',import.meta.url))],env:{...process.env,EIDO_PI_CONFIG_DIR:f.directory,JEV_BROWSER_HEADED:'0'},stderr:'pipe'});
 transport.stderr?.on('data',()=>{});const client=new Client({name:'shared-text-check',version:'1'});t.after(()=>client.close());await client.connect(transport);
 const call=(name,args={})=>client.callTool({name:'browser_'+name,arguments:args});
 assert.equal(parsed(await call('open',{url:f.url})).execution.text_model_source,'pi');
 const result=await call('do',{goal:'Enter 凡人修仙传 in Search, click Search, and verify Result: 凡人修仙传.',explain:true});
 assert.notEqual(result.isError,true,JSON.stringify(result));const value=parsed(result);
 assert.equal(value.status,'likely_done');assert.equal(value.textCalls.length,1);assert.match(value.state.page.text,/Result: 凡人修仙传/);
 assert.equal(f.requests.filter(r=>r.body.messages).length,1);assert.equal(f.requests.filter(r=>r.body.questions).length,3);
 assert.equal(f.requests.find(r=>r.body.messages).authorization,'Bearer main-secret');
 await call('close');assert.equal(parsed(await call('status')).open,false);
});
