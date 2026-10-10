import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {browserDirectory} from '../src/paths.mjs';
import {FastBrowser,StalePage,fingerprint} from '../src/browser/ultrafast/browser.ts';
import {FastAgent} from '../src/browser/ultrafast/agent.ts';
import {startRecording} from '../src/browser/ultrafast/recording.ts';
import {verifyFlights} from '../src/browser/ultrafast/verification.ts';
import {pythonJson} from '../src/browser/ultrafast/json.ts';
process.env.PLAYWRIGHT_BROWSERS_PATH=browserDirectory();
const {chromium}=await import('playwright');
const one=(ids,choice)=>({choice,confidence:1,probabilities:Object.fromEntries(Object.keys(ids).map(k=>[k,Number(k===choice)]))});
function python(input){return new Promise((resolve,reject)=>{
  const child=execFile(process.env.EIDO_TEST_PYTHON??'python3',[fileURLToPath(new URL('./upstream/oracle.py',import.meta.url))],{maxBuffer:4*1024*1024},(error,stdout,stderr)=>error?reject(new Error(stderr)):resolve(JSON.parse(stdout)));
  child.stdin.end(JSON.stringify(input));
});}
async function api(t,policy){
  const requests=[];let index=0;
  const server=createServer(async(req,res)=>{
    let data='';for await(const chunk of req)data+=chunk;const body=JSON.parse(data);requests.push(body);
    let result;
    if(body.messages) result={choices:[{message:{content:'{"text":"book"}'}}]};
    else {
      const selected=policy[index++];assert.ok(selected,'Unexpected extra model call');
      const answers={operation:one(body.questions.operation.criteria,selected.operation)};
      if(selected.target){const head=selected.operation.toLowerCase()+'_target';answers[head]=one(body.questions[head].criteria,selected.target);}
      result={model:'fixture',answers};
    }
    res.setHeader('content-type','application/json');res.end(JSON.stringify(result));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
  return {config:{apiUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture',key:'fixture'},requests};
}
function page(text='Search') {
  const state={url:'https://example.test/',title:'Search',text,scroll:{y:0},actions:[
    {id:'e1',kind:'fill',label:'Search',role:'textbox',value:'',node:10},
    {id:'e2',kind:'click',label:'Open Search',role:'textbox',value:'',node:10},
    {id:'e3',kind:'click',label:'Go',role:'button',value:'',node:20},
    {id:'wait',kind:'wait',label:'Wait'}]};state.fingerprint=fingerprint(state);return state;
}
function normalized(state){
  if(Array.isArray(state))return state.map(normalized);
  if(state&&typeof state==='object')return Object.fromEntries(Object.entries(state).filter(([key])=>!['started_at','elapsed_ms','executed_ms','latency_ms','text_latency_ms'].includes(key)).map(([key,value])=>[key,normalized(value)]));
  return state;
}
for(const [name,input] of Object.entries({
  complete:{pages:[page(),page('Result')],policy:[{operation:'CLICK',target:'2'},{operation:'DONE'}],commands:['predict','act','tick']},
  text_cache:{pages:[page(),page('Result')],policy:[{operation:'TYPE_TEXT',target:'1'},{operation:'TYPE_TEXT',target:'1'},{operation:'DONE'}],acts:['stale',null],commands:['tick','tick','tick']},
  changed_context:{pages:[page(),page('Changed'),page('Result')],policy:[{operation:'TYPE_TEXT',target:'1'},{operation:'TYPE_TEXT',target:'1'}],acts:['stale',null],commands:['tick','tick']},
  stale_terminal:{pages:[page(),page('Changed')],policy:[{operation:'DONE'},{operation:'BLOCKED'}],fresh:[true,false,true,true],commands:['tick','tick']},
  navigating:{pages:[page(),page('Changed')],policy:[{operation:'BLOCKED'}],fresh:['stale',true,true],commands:['tick','tick']},
  post_observe:{pages:[page(),'stale',page('Result')],policy:[{operation:'CLICK',target:'2'},{operation:'DONE'}],commands:['tick','tick']},
  wait:{pages:[page()],policy:Array(5).fill({operation:'WAIT'}),commands:Array(5).fill('tick')},
  no_progress:{pages:[page()],policy:Array(3).fill({operation:'CLICK',target:'2'}),commands:Array(3).fill('tick')},
}))test(`unchanged Python state machine differential: ${name}`,async t=>{
  const expected=await python(input),service=await api(t,input.policy);
  const pages=structuredClone(input.pages),fresh=[...(input.fresh??[])],acts=[...(input.acts??[])],executed=[];let current;
  const browser={observe:async()=>{const next=pages.length?pages.shift():current;if(next==='stale')throw new StalePage('Document changed');current=next;return current;},
    fresh:async()=>{const value=fresh.length?fresh.shift():true;if(value==='stale')throw new StalePage('Document changed');return value;},
    act:async(action,_page,text=null)=>{if(acts.shift()==='stale')throw new StalePage('Document changed');executed.push({id:action.id,text});}};
  const agent=new FastAgent(browser,'Find a book',{signal:new AbortController().signal,decision:service.config,text:service.config});
  await agent.initialize();const states=[],errors=[];
  for(const command of input.commands){try{await agent.command(command,command==='act'?{fingerprint:agent.page.fingerprint}:{});errors.push(null);}catch(e){errors.push(e instanceof StalePage?'StalePage':'ValueError');}states.push(structuredClone(agent.snapshot()));}
  assert.deepEqual(errors,expected.errors);assert.deepEqual(executed,expected.executed);
  assert.deepEqual(normalized(states),normalized(expected.states));assert.deepEqual(service.requests,expected.requests);
});

test('Python fingerprints match Unicode, escaped content, fractional geometry and identity',async t=>{
  const b=await FastBrowser.create('data:text/html,<title>中文 🧭</title><button style="transform:translate(0.23px,0.57px)">Zürich → London</button>',new AbortController().signal);
  t.after(()=>b.close());const actual=await b.observe(false),mutated=structuredClone(actual);mutated.actions[0].node+=1;
  const samples=[actual,mutated,{...page('é 中文 🧭 \u007f\n"\\'),actions:[{...page().actions[0],rect:{x:0.00000123,y:0.5,w:1.25,h:17.2}}]}];
  assert.deepEqual(samples.map(fingerprint),await python({fingerprints:samples}));
  assert.equal(pythonJson({text:'é🧭'}),'{"text": "\\u00e9\\ud83e\\udded"}');
});

test('owned background target, upstream viewport, command API, generator, screenshots and recording',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'eido-record-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const owned=await chromium.launch();t.after(()=>owned.close());const context=await owned.newContext();
  const other=await context.newPage();await other.setContent('<title>User page</title><p>Untouched</p>');
  const fast=await FastBrowser.create('data:text/html,<title>Counter</title><p id="n">0</p><button onclick="n.textContent=1">Increment</button>',new AbortController().signal,{context});
  t.after(()=>fast.close());assert.equal(context.pages().length,2);assert.equal(await other.title(),'User page');
  const observed=await fast.observe();assert.equal(observed.w,1120);assert.equal(observed.h,780);assert.ok(observed.screenshot);
  const service=await api(t,[{operation:'CLICK',target:'1'},{operation:'DONE'}]);
  const agent=new FastAgent(fast,['Increment','Check 1'],{signal:fast.signal,decision:service.config,text:service.config,recordDir:folder});
  await agent.initialize();assert.deepEqual(agent.snapshot().plan,['Increment\nCheck 1']);assert.ok((await readFile(join(folder,'000000.jpg'))).length>500);
  const recording=await startRecording(fast,folder);await fast.evaluate("document.body.style.background='red'");
  await new Promise(r=>setTimeout(r,100));const states=[];for await(const state of agent.run())states.push(structuredClone(state));
  const recorded=await recording.stop();assert.equal(states.at(-1).status,'done');assert.equal(states.at(-1).plan_index,1);assert.ok(recorded.frames>0);assert.deepEqual(recorded.recording_errors,[]);
  assert.equal(states[0].history.length,1);assert.ok(states[0].page.screenshot);assert.ok(states[0].decisions[0].fingerprint);assert.ok(states[0].decisions[0].elapsed_ms>=0);
  assert.ok((await readdir(folder)).filter(p=>p.endsWith('.jpg')).length>=2);
  await assert.rejects(agent.command('act',{fingerprint:agent.page.fingerprint}),/Observe and choose/);
  await fast.close();await fast.close();assert.equal(context.pages().length,1);assert.equal(await other.title(),'User page');
});

test('upstream independent flight verifier rejects all wrong route/date states',()=>{
  const actual={url:'https://www.google.com/travel/flights/search?tfs=example',text:'Track prices from Zürich to London departing 2026-09-20',actions:[
    ['Change ticket type. One way','One way'],['Where from?','Zürich'],['Where to?','London'],['Departure','Sun, Sep 20'],['Nonstop flight on Sunday, September 20. Select flight','']].map(([label,value])=>({label,value}))};
  assert.equal(verifyFlights(actual).passed,true);
  for(const field of ['Departure','Where from?','Where to?']){const changed=structuredClone(actual);changed.actions.find(a=>a.label===field).value='wrong';assert.equal(verifyFlights(changed).passed,false);}
  assert.equal(verifyFlights({...actual,text:actual.text.replace('2026','2027')}).passed,false);
});

test('recording renderer preserves timestamps and exports PNG, MP4 and GIF',async t=>{
  const ffmpeg=process.env.EIDO_TEST_FFMPEG;
  if(!ffmpeg){t.skip('Set EIDO_TEST_FFMPEG to a full FFmpeg encoder for render verification');return;}
  const {writeFile,stat}=await import('node:fs/promises');
  const {renderRecording}=await import('../src/browser/ultrafast/render.ts');
  const folder=await mkdtemp(join(tmpdir(),'eido-render-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const fast=await FastBrowser.create('data:text/html,<h1>Verified fixture</h1>',new AbortController().signal);t.after(()=>fast.close());
  const state=await fast.observe(true);await writeFile(join(folder,'000000.jpg'),Buffer.from(state.screenshot,'base64'));
  await writeFile(join(folder,'state.json'),JSON.stringify({elapsed_ms:100,history:[],decisions:[],text_calls:[],verification:{passed:true}}));
  const output=await renderRecording(folder,ffmpeg,'fixture');assert.equal(output.elapsed_ms,100);assert.equal(output.frames,63);
  for(const file of [output.video,output.gif,output.result])assert.ok((await stat(file)).size>1000);
  await writeFile(join(folder,'state.json'),JSON.stringify({verification:{passed:false}}));
  await assert.rejects(renderRecording(folder,ffmpeg,'fixture'),/verification/);
});
