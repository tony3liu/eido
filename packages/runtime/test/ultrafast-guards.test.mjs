import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {browserDirectory} from '../src/paths.mjs';
process.env.PLAYWRIGHT_BROWSERS_PATH=browserDirectory();
const {chromium}=await import('playwright');
test('unchanged upstream check_guards.py passes all 21 real browser guards',async t=>{
  const browser=await chromium.launch();t.after(()=>browser.close());const context=await browser.newContext();
  const placeholder=await context.newPage(),probe=await context.newCDPSession(placeholder);
  const contextId=(await probe.send('Target.getTargetInfo')).targetInfo.browserContextId;await probe.detach();
  const root=await browser.newBrowserCDPSession();t.after(()=>root.detach().catch(()=>{}));let page,session;
  const child=spawn(process.env.EIDO_TEST_PYTHON??'python3',[fileURLToPath(new URL('./upstream/live_guards.py',import.meta.url))],{stdio:['pipe','pipe','pipe']});
  t.after(()=>child.kill());let error='',messages=[];child.stderr.on('data',chunk=>error+=chunk);
  const finished=new Promise(resolve=>child.once('exit',code=>resolve(code)));
  const lines=createInterface({input:child.stdout});
  for await(const line of lines) {
    if(!line.startsWith('{')){messages.push(line);continue;}
    const request=JSON.parse(line);let response;
    try {
      if(request.method==='Target.createTarget') {
        const appears=context.waitForEvent('page');response=await root.send(request.method,{...request.params,browserContextId:contextId});page=await appears;
      } else if(request.method==='Target.attachToTarget') {session=await context.newCDPSession(page);response={sessionId:'fixture-session'};}
      else response=await (request.method==='Target.closeTarget'?root:session).send(request.method,request.params);
      child.stdin.write(JSON.stringify({result:response})+'\n');
    } catch(e) {child.stdin.write(JSON.stringify({error:e.message})+'\n');}
  }
  assert.equal(await finished,0,error);assert.match(messages.at(-1),/^PASS: \d+ browser guard checks; no model calls$/);
  assert.ok(messages.length>=21);console.log(messages.at(-1));
});
