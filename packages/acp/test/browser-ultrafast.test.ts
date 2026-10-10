import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {client,methods} from '@agentclientprotocol/sdk';
import {startEidoAgent} from '../src/server.ts';
import {fixtureModel,call,lastToolText} from './fixture-model.ts';
const tool=(name:string)=>`mcp__eido_browser__browser_${name}`;
const one=(ids:Record<string,unknown>,choice:string)=>({choice,confidence:1,probabilities:Object.fromEntries(Object.keys(ids).map(k=>[k,Number(k===choice)]))});
test('bundled pi ACP executes the complete fast goal, propagates full trace and closes after completion, failure and cancel',async()=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),'eido-acp-ultrafast-')));
  let invalid=false,held=false,notifyHeld:()=>void=()=>{};let requests=0;
  const website=createServer(async(req,res)=>{
    if(req.method==='GET') {res.setHeader('content-type','text/html');res.end('<title>Counter</title><p id="value">Count: 0</p><button onclick="document.querySelector(\'#value\').textContent=\'Count: 1\'">Increment</button>');return;}
    let data='';for await(const chunk of req)data+=chunk;const body=JSON.parse(data);requests++;
    if(held){notifyHeld();return;}
    const op=body.state.page.text.includes('Count: 1')?'DONE':'CLICK';
    const answers:Record<string,unknown>={operation:one(body.questions.operation.criteria,op)};
    if(op==='CLICK')answers.click_target=one(body.questions.click_target.criteria,Object.keys(body.questions.click_target.criteria)[0]!);
    res.setHeader('content-type','application/json');res.end(JSON.stringify({model:'fixture',answers:invalid?{}:answers}));
  });
  await new Promise<void>(resolve=>website.listen(0,'127.0.0.1',resolve));const port=(website.address() as {port:number}).port,url=`http://127.0.0.1:${port}`;
  await writeFile(join(directory,'settings.json'),JSON.stringify({defaultProvider:'eido-fixture',defaultModel:'scripted',defaultThinkingLevel:'off',retry:{enabled:false},eido:{fullAccess:true,browserDecision:{apiUrl:url,model:'fixture',engine:'ultrafast'}}}));
  await writeFile(join(directory,'auth.json'),JSON.stringify({'eido-jev':{type:'api_key',key:'fixture'}}));
  const fixture=await fixtureModel(directory,[
    ()=>call(tool('open'),{url}),()=>call(tool('do'),{goal:'Click Increment and verify Count: 1',explain:true}),
    context=>{const trace=JSON.parse(lastToolText(context,tool('do')));assert.equal(trace.status,'likely_done');assert.equal(trace.state.status,'done');assert.equal(trace.state.plan_index,1);assert.equal(trace.history.length,1);assert.match(trace.state.page.text,/Count: 1/);assert.equal(requests,2);return 'Observed Count: 1.';},
    ()=>call(tool('status')),context=>{assert.equal(JSON.parse(lastToolText(context,tool('status'))).open,false);invalid=true;return call(tool('open'),{url});},
    ()=>call(tool('do'),{goal:'Click Increment',explain:true}),context=>{const result=context.messages.findLast(m=>m.role==='toolResult'&&m.toolName===tool('do'));assert.ok(result?.role==='toolResult'&&result.isError);return call(tool('status'));},
    context=>{assert.equal(JSON.parse(lastToolText(context,tool('status'))).open,false);invalid=false;return 'Invalid decision failed and closed the browser.';},
    ()=>call(tool('open'),{url}),()=>{held=true;return call(tool('do'),{goal:'Click Increment'});},
    ()=>call(tool('status')),context=>{assert.equal(JSON.parse(lastToolText(context,tool('status'))).open,false);return 'Cancelled browser cleaned up.';},
  ]);
  const input=new TransformStream(),output=new TransformStream();const updates:unknown[]=[];
  const server=await startEidoAgent(directory,join(directory,'sessions'),{readable:input.readable,writable:output.writable},fixture.runtime);
  const connection=client({name:'ultrafast-acp'})
    .onRequest(methods.client.session.requestPermission,()=>({outcome:{outcome:'selected',optionId:'allow_once'}}))
    .onNotification(methods.client.session.update,({params})=>{updates.push(params.update);})
    .connect({readable:output.readable,writable:input.writable});
  try {
    await connection.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{}});
    const session=await connection.agent.request(methods.agent.session.new,{cwd:directory,mcpServers:[{name:'eido_browser',command:process.execPath,
      args:[fileURLToPath(new URL('../../runtime/bin/browser-server.mjs',import.meta.url))],env:[{name:'JEV_BROWSER_HEADED',value:'0'}]}]});
    const prompt=()=>connection.agent.request(methods.agent.session.prompt,{sessionId:session.sessionId,prompt:[{type:'text',text:'Verify full browser execution.'}]});
    assert.equal((await prompt()).stopReason,'end_turn');assert.equal((await prompt()).stopReason,'end_turn');
    const received=new Promise<void>(resolve=>notifyHeld=resolve),pending=prompt();await received;
    await connection.agent.notify(methods.agent.session.cancel,{sessionId:session.sessionId});assert.equal((await pending).stopReason,'cancelled');
    assert.equal((await prompt()).stopReason,'end_turn');assert.match(JSON.stringify(updates),/"status":"failed"/);
  } finally {await server.agent.dispose();connection.close();server.connection.close();website.closeAllConnections();await new Promise<void>(resolve=>website.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});
