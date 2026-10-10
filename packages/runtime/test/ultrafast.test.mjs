import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {browserDirectory} from '../src/paths.mjs';
import {FastBrowser,StalePage,UncertainAction,fingerprint} from '../src/browser/ultrafast/browser.ts';
import {FastAgent} from '../src/browser/ultrafast/agent.ts';
import {actionSpace,choiceRequest,choose,validateChoice,fieldContext,fieldText} from '../src/browser/ultrafast/model.ts';
process.env.PLAYWRIGHT_BROWSERS_PATH=browserDirectory();
const {chromium}=await import('playwright');
const one=(ids,choice)=>({choice,confidence:1,probabilities:Object.fromEntries(Object.keys(ids).map(k=>[k,k===choice?1:0]))});
async function service(t,respond) {
  const requests=[];
  const server=createServer(async(req,res)=>{
    let data='';for await(const chunk of req)data+=chunk;
    const body=JSON.parse(data);requests.push(body);
    try {const result=await respond(body,requests.length,req);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));}
    catch {res.writeHead(503);res.end('{}');}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
  return {config:{apiUrl:`http://127.0.0.1:${server.address().port}`,model:'fixture',key:'fixture-key'},requests};
}
async function browser(t,html) {
  const owned=await chromium.launch({headless:true});
  t.after(()=>owned.close());
  const page=await owned.newPage({viewport:{width:1120,height:780}});await page.setContent(html);
  const controller=new AbortController();const fast=await FastBrowser.attach(page,controller.signal);
  t.after(()=>fast.detach());return {owned,page,fast,controller};
}
const fixture=`<title>Booking fixture</title><form><label>Destination <input id="field" aria-label="Destination"></label>
<select id="select" aria-label="Cabin"><option value="economy">Economy</option><option value="business">Business</option><optgroup disabled><option>Hidden choice</option></optgroup></select>
<button type="button" id="button" onclick="document.querySelector('#result').textContent='Submitted '+document.querySelector('#field').value">Search</button>
<input id="check" type="checkbox" aria-label="Nonstop"><p id="result">Ready</p></form><aside id="aside">Weather</aside>`;

test('one indexed node has compatible heads; only selected head is validated', async t=>{
  const {fast}=await browser(t,fixture);const page=await fast.observe(false);
  const {elements,targets}=actionSpace(page.actions);
  const field=elements.find(e=>e.label==='Destination');assert.deepEqual(field.operations,['TYPE_TEXT','CLICK']);
  const select=elements.find(e=>e.label==='Cabin');assert.equal(select.options.length,1);
  const index=Object.keys(targets.CLICK).find(k=>targets.CLICK[k].label==='Search');
  const api=await service(t,body=>({model:'fixture',answers:{operation:one(body.questions.operation.criteria,'CLICK'),
    click_target:one(body.questions.click_target.criteria,index),type_text_target:{choice:'malicious',confidence:100},select_target:null}}));
  const decision=await choose(page,'Search',[],api.config);
  assert.equal(api.requests.length,1);assert.equal(decision.choice,targets.CLICK[index].id);
  assert.equal(api.requests[0].state.elements.length,elements.length);
  assert.ok(!JSON.stringify(api.requests[0]).includes('screenshot'));
  for(const invalid of [{}, {choice:'a',confidence:true,probabilities:{a:1}}, {choice:'a',confidence:1,probabilities:{a:0.1,b:0.9}},
    {choice:'a',confidence:1,probabilities:{a:1,b:0}}, {choice:'a',confidence:NaN,probabilities:{a:1}}, {choice:'__proto__',confidence:1,probabilities:{a:1}}])
    assert.throws(()=>validateChoice(invalid,{a:'a'}),/Invalid TypeSafe/);
});

test('real DOM guards reject changed meaning, form state, replacement, visibility and occlusion', async t=>{
  const {page,fast}=await browser(t,fixture);
  for(const mutation of [
    "button.setAttribute('aria-label','Delete')", "field.value='Paris'", "check.checked=true", "button.disabled=true",
    "field.readOnly=true", "button.style.visibility='hidden'", "button.outerHTML=button.outerHTML",
    "select.options[1].textContent='Premium'", "document.querySelector('#result').textContent='Price changed'",
  ]) {
    await page.setContent(fixture);const snapshot=await fast.observe(false),action=snapshot.actions.find(a=>a.label==='Search');
    await page.evaluate(mutation);assert.equal(await fast.fresh(snapshot,action),false,mutation);
    await assert.rejects(fast.act(action,snapshot),StalePage);
  }
  await page.setContent(fixture);let snapshot=await fast.observe(false),action=snapshot.actions.find(a=>a.label==='Search');
  await page.evaluate("button.style.transform='translateX(130px)'");
  assert.equal(await fast.fresh(snapshot,action),true);await fast.act(action,snapshot);
  assert.match(await page.locator('#result').innerText(),/Submitted/,'click resolves current geometry');
  await page.setContent(fixture);snapshot=await fast.observe(false);action=snapshot.actions.find(a=>a.label==='Search');
  await page.evaluate("document.querySelector('#aside').textContent='Weather changed'");
  assert.equal(await fast.fresh(snapshot,action),true);assert.equal(await fast.fresh(snapshot),false);
  snapshot=await fast.observe(false);action=snapshot.actions.find(a=>a.label==='Search');
  await page.evaluate("const cover=document.createElement('div');cover.style='position:fixed;inset:0;z-index:99999';document.body.append(cover)");
  assert.equal(await fast.fresh(snapshot),true,'textless overlay is caught by hit test, not semantics');
  await assert.rejects(fast.act(action,snapshot),StalePage);
  await page.goto('data:text/html,<h1>New document</h1>');assert.equal(await fast.fresh(snapshot),false);
});

test('atomic snapshot excludes unsafe inputs; native select, fill and autocomplete change real state', async t=>{
  const {page,fast}=await browser(t,fixture+`<input type="password" value="private-secret"><input type="file"><input type="hidden" value="hidden-secret">`);
  const calls=[];const send=fast.session.send.bind(fast.session);fast.session.send=(name,args)=>{calls.push(name);return send(name,args);};
  let state=await fast.observe(false);assert.deepEqual(calls,['Runtime.evaluate']);
  assert.ok(!JSON.stringify(state).includes('private-secret'));assert.ok(!JSON.stringify(state).includes('hidden-secret'));
  await fast.act(state.actions.find(a=>a.kind==='select'),state);assert.equal(await page.locator('#select').inputValue(),'business');
  state=await fast.observe(false);await fast.act(state.actions.find(a=>a.kind==='fill'),state,'London');assert.equal(await page.locator('#field').inputValue(),'London');
  await page.setContent(`<input id="field" role="combobox" aria-label="City" aria-controls="options" oninput="setTimeout(()=>document.querySelector('#options').innerHTML='<div role=option>London</div>',60)"><div id="options"></div>`);
  state=await fast.observe(false);await fast.act(state.actions.find(a=>a.kind==='fill'),state,'London');
  state=await fast.observe(false);assert.ok(state.actions.some(a=>a.role==='option'&&a.label==='London'));
  assert.ok(!calls.some(name=>name.includes('Screenshot')));
});

test('full goal uses helper only for TYPE_TEXT, traces before observing, and consumes a decision once', async t=>{
  const {page,fast,controller}=await browser(t,fixture);
  const api=await service(t,body=>{
    if(body.messages) {assert.deepEqual(Object.keys(JSON.parse(body.messages[1].content)),['goal','field','page','recent_actions']);return {choices:[{message:{content:'{"text":"London"}'}}]};}
    const op=body.state.page.text.includes('Submitted London')?'DONE':body.state.elements.some(e=>e.label==='Destination'&&e.value==='London')?'CLICK':'TYPE_TEXT';
    const answers={operation:one(body.questions.operation.criteria,op)};
    if(op!=='DONE') {const head=op.toLowerCase()+'_target',criteria=body.questions[head].criteria;
      const id=Object.keys(criteria).find(k=>op==='CLICK'?criteria[k].element.includes('Search'):criteria[k].element.includes('Destination'));
      answers[head]=one(criteria,id);}
    return {model:'fixture',answers};
  });
  const agent=new FastAgent(fast,'Enter "London" and click Search',{decision:api.config,text:api.config,signal:controller.signal});
  const result=await agent.runToCompletion();assert.equal(result.status,'likely_done');assert.equal(result.actions,2);assert.equal(result.model_calls,3);assert.equal(result.text_calls,1);
  assert.match(await page.locator('#result').innerText(),/Submitted London/);
  assert.equal(api.requests.filter(r=>r.messages).length,1);assert.equal(agent.history[0].text,'London');
  await assert.rejects(agent.act(agent.page.fingerprint),/Observe and choose/);
  const before=agent.history.length;agent.status='predicted';agent.decision={...agent.decisions[1],choice:agent.page.actions.find(a=>a.label==='Search').id};
  const observe=fast.observe.bind(fast);fast.observe=async()=>{throw new StalePage('Interrupted after click');};
  await assert.rejects(agent.act(agent.page.fingerprint),StalePage);assert.equal(agent.history.length,before+1);assert.equal(agent.history.at(-1).page_changed,null);
  fast.observe=observe;
});

test('text output is strict, cancellation aborts HTTP, and missing helper configuration never types', async t=>{
  const {fast,controller}=await browser(t,fixture);const page=await fast.observe(false),action=page.actions.find(a=>a.kind==='fill');
  const context=fieldContext('Enter London',action,page,[]);
  await assert.rejects(fieldText(context,{apiUrl:'',key:'',model:''}),/Configure the main language model/);
  for(const content of ['null','{}','{"text":null}','{"text":""}','{"text":"ok","action":"click"}','{"text":123}','not json']) {
    const api=await service(t,()=>({choices:[{message:{content}}]}));await assert.rejects(fieldText(context,api.config),/no valid field value/);
  }
  let entered;const started=new Promise(r=>entered=r);
  const api=await service(t,()=>{entered();return new Promise(()=>{});});
  const pending=choose(page,'Search',[],api.config,controller.signal);await started;controller.abort();
  await assert.rejects(pending,/abort/i);
});

test('stale helper is reused only when the complete input is identical', async t=>{
  const {page,fast,controller}=await browser(t,fixture);
  const api=await service(t,body=>body.messages?{choices:[{message:{content:'{"text":"London"}'}}]}:{model:'fixture',answers:{
    operation:one(body.questions.operation.criteria,'TYPE_TEXT'),type_text_target:one(body.questions.type_text_target.criteria,Object.keys(body.questions.type_text_target.criteria)[0])}});
  const agent=new FastAgent(fast,'Enter London',{decision:api.config,text:api.config,signal:controller.signal});
  agent.page=await fast.observe(false);await agent.predict();
  const act=fast.act.bind(fast);fast.act=async()=>{throw new StalePage('Covered after helper');};
  await assert.rejects(agent.act(agent.page.fingerprint),StalePage);assert.equal(agent.textCalls.length,1);
  agent.status='ready';await agent.predict();await assert.rejects(agent.act(agent.page.fingerprint),StalePage);assert.equal(agent.textCalls.length,1);
  await page.evaluate("document.querySelector('#aside').textContent='New visible context'");
  agent.status='ready';await agent.predict();await assert.rejects(agent.act(agent.page.fingerprint),StalePage);assert.equal(agent.textCalls.length,2);
  fast.act=act;
});

test('WAIT is bounded without false no-progress; uncertain select is never retried as stale', async t=>{
  const {fast,controller}=await browser(t,fixture);const page=await fast.observe(false);
  const api=await service(t,body=>({model:'fixture',answers:{operation:one(body.questions.operation.criteria,'WAIT')}}));
  const agent=new FastAgent(fast,'Wait',{decision:api.config,text:api.config,signal:controller.signal,maxActions:3});
  const result=await agent.runToCompletion();assert.equal(result.actions,3);assert.equal(result.status,'blocked');assert.equal(result.stale_retries,0);
  const send=fast.session.send.bind(fast.session);fast.session.send=async(name,args)=>{
    if(name==='Runtime.evaluate'&&args.expression.includes("e.value=action.value"))return {exceptionDetails:{text:'Interrupted'}};
    return send(name,args);
  };
  await assert.rejects(fast.act(page.actions.find(a=>a.kind==='select'),page),UncertainAction);
});
