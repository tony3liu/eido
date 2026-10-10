import { existsSync } from 'node:fs';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import { chromium } from 'playwright';
import { JevBrowser,formatPage } from 'jev-browser';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { computerSettings } from '../computer.mjs';
import { FastBrowser } from './ultrafast/browser.ts';
import { FastAgent } from './ultrafast/agent.ts';
import { startInspector,inspectorState } from './ultrafast/inspector.ts';
import { FLIGHTS_URL,verifyFlights,verifyTravel } from './ultrafast/verification.ts';
import { startRecording } from './ultrafast/recording.ts';
import { piDirectory } from '../paths.mjs';

const text = value => ({ content: [{type:'text', text:typeof value === 'string' ? value : JSON.stringify(value)}] });
const barrier = page => /captcha|verify you are human|security verification|安全验证|人机验证/i.test(`${page.title} ${page.text}`);

// Eido owns transport, serialization and handoff. All page interpretation and
// legacy actions use JevBrowser's public API; the fast loop uses the same page via CDP.
export async function serveBrowser() {
  const server = new McpServer({name:'eido-browser', version:'0.0.1'});
  let launch, tail = Promise.resolve(), owner = 'agent', handoffEpoch = 0, lifetime = new AbortController(), inputLifetime = new AbortController();
  const engine=process.env.EIDO_BROWSER_ENGINE ?? 'ultrafast';
  const fastOperations=new Set(['click','type','select','scroll']);
  let activeAgent=null,activeFast=null,inspector=null;
  const executable = chromium.executablePath();
  async function browser() {
    if (!existsSync(executable)) throw new Error(`Bundled browser unavailable at ${executable}. Reinstall Eido with its matching browser resources; do not install packages into the running app.`);
    launch ??= (async()=>{
      const b=await JevBrowser.launch({headed:process.env.JEV_BROWSER_HEADED !== '0',highlight:engine==='legacy'&&process.env.JEV_BROWSER_HEADED !== '0',
        ...(engine==='ultrafast'?{viewport:{width:1120,height:780}}:{})});
      if(engine==='ultrafast') {
        try {
          const initial=b.page,fast=await FastBrowser.create('about:blank',lifetime.signal,{context:b.context});
          b.page=fast.page;await initial.close();await fast.detach();
        } catch(error) {await b.close();throw error;}
      }
      return b;
    })()
      .catch(error => {launch=undefined;throw error;});
    return launch;
  }
  async function close() {
    handoffEpoch++;
    lifetime.abort(new Error('Browser session closed'));
    lifetime = new AbortController();
    const pending = launch;
    launch = undefined;
    owner = 'agent';
    activeAgent=null;
    const fast=activeFast;activeFast=null;
    await fast?.detach();
    await (await pending?.catch(()=>undefined))?.close();
  }
  async function observe(b) {
    const snapshot = engine==='legacy'?await b.snapshotText():formatPage(b.shown=await b.snapshot());
    const page = b.lastPage;
    return {url:page.url, title:page.title, status:barrier(page)?'needs_user':'ready',
      execution:{engine,next_tool:process.env.TYPESAFE_API_KEY?'browser_do':'browser_act',
        text_model_configured:!!process.env.TEXT_MODEL_API_KEY},
      ...(barrier(page)?{message:'Verification required. Use browser_takeover to let the user choose Manual Takeover or Use Computer Use. Wait for their choice and re-observe before continuing.'}:{}), snapshot};
  }
  async function recordingDirectory() {
    const root=join(piDirectory(),'artifacts','browser');await mkdir(root,{recursive:true});
    return mkdtemp(join(root,'ultrafast-'));
  }
  function agentOptions(signal,extra={}) {
    return {signal,barrier,...extra,
      decision:{apiUrl:process.env.JEV_API_URL,model:process.env.JEV_MODEL,key:process.env.TYPESAFE_API_KEY},
      text:{apiUrl:process.env.TEXT_MODEL_BASE_URL,model:process.env.TEXT_MODEL,key:process.env.TEXT_MODEL_API_KEY,reasoning:process.env.TEXT_MODEL_REASONING}};
  }
  async function agentCommand(name,body,origin,requestSignal) {
    if(engine!=='ultrafast') throw new Error('Select Ultrafast in global browser settings to use the inspector.');
    if(owner==='user') throw new Error('Browser input is paused for user takeover.');
    if(name==='reset') {
      const scenario=body.scenario??'flights',goal=(body.goal??'').trim();
      if(!['travel','research','flights'].includes(scenario)) throw new Error('Unknown demo scenario');
      if(!goal||[...goal].length>2000) throw new Error('Enter 1–2,000 characters');
      if(!body.url&&scenario!=='flights'&&!origin) throw new Error('Open browser_inspect first to use the local scenarios.');
      await close();const b=await browser();
      const signal=AbortSignal.any([lifetime.signal,inputLifetime.signal,...(requestSignal?[requestSignal]:[])]);
      try {
        activeFast=await FastBrowser.attach(b.page,signal);
        await activeFast.navigate(body.url??(scenario==='flights'?FLIGHTS_URL:`${origin}/fixture.html?scenario=${scenario}`));
        activeAgent=new FastAgent(activeFast,goal,agentOptions(signal,{screenshots:body.screenshots??true,recordDir:body.record?await recordingDirectory():undefined}));
        activeAgent.scenario=scenario;await activeAgent.initialize();
      } catch(error) {await close();throw error;}
    } else {
      if(!activeAgent) throw new Error('Start a demo first');
      const b=await browser();
      const signal=AbortSignal.any([lifetime.signal,inputLifetime.signal,...(requestSignal?[requestSignal]:[])]);
      if(!activeFast) activeFast=await FastBrowser.attach(b.page,signal);
      else activeFast.signal=signal;
      activeAgent.browser=activeFast;activeAgent.options.signal=signal;
      try {await activeAgent.command(name,body);}
      catch(error) {
        if(owner==='user') {if(activeAgent) activeAgent.decision=null;throw new Error('Browser automation stopped for user takeover. Observe again.');}
        if(!/Observe and choose|stopped|budget|Page changed|Target changed|Document changed|Unknown command/.test(error.message)) await close();
        throw error;
      }
      if(activeAgent.options.recordDir) await writeFile(join(activeAgent.options.recordDir,'state.json'),JSON.stringify(activeAgent.snapshot(),null,2));
    }
    return inspectorState(activeAgent,process.env.TEXT_MODEL??'deepseek-chat');
  }
  function register(name, description, schema, execute, concurrent = false) {
    server.registerTool(name,{description,inputSchema:schema},async (args, extra) => {
      const admittedEpoch = handoffEpoch;
      if (owner === 'user' && !['browser_close','browser_status'].includes(name)) {
        return {isError:true,...text({status:'needs_user',message:'The user owns the browser. Wait for browser_takeover to finish, then re-observe before acting.'})};
      }
      const run = async () => {
        extra.signal.throwIfAborted();
        if (!concurrent && admittedEpoch !== handoffEpoch) return {isError:true,...text({status:'stale',message:'Browser input ownership changed. Re-observe before retrying this call.'})};
        const cancel = () => {void close().catch(()=>{});};
        extra.signal.addEventListener('abort',cancel,{once:true});
        try {return await execute(args,extra);}
        catch(error) {
          return {isError:true,...text({status:extra.signal.aborted?'cancelled':'error',
            message:String(error?.message??error).slice(0,1200),browserPath:executable,
            recovery:'Re-observe with browser_snapshot or reopen after checking the error. Never repeat an unconfirmed action with side effects.'})};
        } finally {extra.signal.removeEventListener('abort',cancel);}
      };
      if (concurrent) return run();
      const pending = tail.then(run,run);
      tail = pending.catch(()=>{});
      return pending;
    });
  }
  register('browser_open','Open a URL in the task browser. Returns the observed page and any user verification barrier.',{url:z.string().url()},async ({url})=>{
    const b=await browser();activeAgent=null;await activeFast?.detach();activeFast=null;
    if(engine==='legacy') await b.open(url);
    else {
      const fast=await FastBrowser.attach(b.page,lifetime.signal);
      try {await fast.navigate(url);} catch(error){await close();throw error;} finally{await fast.detach();}
    }
    return text(await observe(b));
  });
  register('browser_snapshot','Re-observe the current page and numbered elements before acting, especially after navigation, errors or user takeover.',{},async()=>text(await observe(await browser())));
  register('browser_act','Direct browser fallback for a specific observed element. Use browser_do for complete goals. With a configured Ultrafast engine, click/type/select/scroll require fallback_reason explaining why the fast loop cannot perform this step. press_enter and press_key require element. Re-observe after errors or ownership changes.',{
    action:z.enum(['click','type','press_enter','press_key','select','hover','right_click','drag','upload','scroll','back']),
    element:z.number().int().optional(),value:z.string().optional(),key:z.string().optional(),destination:z.number().int().optional(),accept_dialog:z.boolean().optional(),
    fallback_reason:z.string().trim().min(1).max(500).optional().describe('Explain the unsupported control, failed fast run, unavailable service, or explicit user request requiring direct input. This is recorded in the result; it does not switch the global engine.'),
  },async ({accept_dialog,fallback_reason,...args})=>{
    if(engine==='ultrafast'&&process.env.TYPESAFE_API_KEY&&fastOperations.has(args.action)&&!fallback_reason) {
      return {isError:true,...text({status:'use_browser_do',engine,
        message:'Use browser_do with the entire browser goal and required field values. No action was executed. Direct click/type/select/scroll need a fallback_reason explaining why Ultrafast cannot perform this step.',
        recovery:'Call browser_do first. For unsupported controls or an unavailable service, supply a specific fallback_reason. Do not replay any already completed action.'})};
    }
    const b=await browser();const action=await b.actOn({...args,acceptDialog:!!accept_dialog});
    return text({...action,...await observe(b),execution:{engine:'direct',decision_service:false,...(fallback_reason?{fallback_reason}:{})}});
  });
  register('browser_do','Run the complete browser goal using the globally selected Jev execution loop. Supply the entire goal and required field values in the goal. Ultrafast makes one decision request per step and generates text only for TYPE_TEXT; it does not need screenshots. Legacy uses the optional values map. Check likely_done against actual page evidence. Use browser_takeover for verification barriers; do not repeat uncertain side effects.',{
    goal:z.string(),values:z.record(z.string(),z.string()).optional(),max_actions:z.number().int().min(1).max(60).optional(),allow_irreversible:z.boolean().optional().describe('Legacy only: allow its irreversible-action guard. Ultrafast executes the supported operations under the agent access policy.'),explain:z.boolean().optional(),
    screenshots:z.boolean().optional(),record:z.boolean().optional(),screencast:z.boolean().optional(),
  },async ({goal,values,max_actions,allow_irreversible,explain,screenshots,record,screencast},extra)=>{
    const b=await browser();
    if(engine==='legacy') {
      const before=await observe(b);if(before.status==='needs_user')return text(before);
      const r=await b.do(goal,{values:values??{},maxActions:max_actions??10,allowIrreversible:!!allow_irreversible});
      return text({...r,engine,...(!explain?{rounds:undefined}:{}),observation:await observe(b)});
    }
    const signal=AbortSignal.any([extra.signal,lifetime.signal,inputLifetime.signal]);
    let fast;
    let progress=0;
    let agent;
    let recording;
    let recordDir;
    try {
      await activeFast?.detach();activeFast=null;
      fast=await FastBrowser.attach(b.page,signal);activeFast=fast;
      recordDir=record||screencast?await recordingDirectory():undefined;
      agent=new FastAgent(fast,goal+(values&&Object.keys(values).length?'\nRequired field values: '+JSON.stringify(values):''),agentOptions(signal,{
      maxActions:max_actions??60,screenshots,recordDir:record?recordDir:undefined,observationBudget:240,
      progress:async event=>{
        const token=extra._meta?.progressToken;
        if(token!==undefined) await server.server.notification({method:'notifications/progress',params:{progressToken:token,progress:++progress,
          message:event.phase==='acting'?`${event.operation}: ${event.target}`:event.phase==='generating_text'?`Preparing text: ${event.field}`:
            event.phase==='stale'?'Page changed; observing again':event.phase==='observed'?`Observed after ${event.action}`:'Choosing the next browser action'}}).catch(()=>{});
      },
    }));
      activeAgent=agent;
      await agent.initialize();
      if(screencast) {recording=await startRecording(fast,recordDir);recording.anchor();}
      const result=await agent.runToCompletion();
      const recordingResult=await recording?.stop();
      if(recordDir) await writeFile(join(recordDir,'state.json'),JSON.stringify(agent.snapshot(),null,2));
      return text({...result,...(recordDir?{record_dir:recordDir}:{}),...(recordingResult?{recording:recordingResult}:{}),...(!explain?{decisions:undefined,textCalls:undefined,state:undefined}:{}),
        ...(result.status==='blocked'?{recovery:'Inspect the page. For unsupported controls, choose Legacy in global browser settings for a new run. Completed actions are never replayed automatically.'}:{})});
    } catch(error) {
      const trace=agent?.result()??{history:[]};
      if(recordDir&&agent) await writeFile(join(recordDir,'state.json'),JSON.stringify({...agent.snapshot(),error:error.message},null,2)).catch(()=>{});
      if(owner==='user' && !extra.signal.aborted) return text({status:'needs_user',engine,history:trace.history,
        message:'Browser automation stopped for user takeover. The pending decision was discarded; re-observe before continuing.'});
      await close();
      return {isError:true,...text({status:signal.aborted&&extra.signal.aborted?'cancelled':'error',engine,
        message:String(error?.message??error).slice(0,1200),...(!explain?{history:trace.history}:{trace}),
        recovery:'The task browser was closed. Inspect the trace before retrying any action with side effects.'})};
    } finally {await recording?.stop().catch(()=>{});await fast?.detach();if(activeFast===fast) activeFast=null;}
  });
  register('browser_check','Ask a yes/no question with the configured Jev service. Probabilities between 0.15 and 0.85 require direct observation.',{question:z.string()},async ({question})=>text({question,p_yes:await (await browser()).check(question)}));
  register('browser_choose','Choose between supplied options using the configured Jev service.',{question:z.string(),options:z.array(z.string()).min(2).max(255)},async ({question,options})=>text(await (await browser()).choose(question,options)));
  register('browser_screenshot','Capture the actual browser viewport as an image. A vision-capable conversation model is needed to interpret it.',{full_page:z.boolean().optional()},async ({full_page})=>{
    const data=await (await browser()).screenshot({fullPage:!!full_page});return {content:[{type:'image',data:data.toString('base64'),mimeType:'image/png'}]};
  });
  register('browser_agent_state','Inspect the full Ultrafast run state: page, indexed elements, pending decision, plan, operation/target probabilities, history, text calls and timestamps.',{},async()=>text(inspectorState(activeAgent,process.env.TEXT_MODEL??'deepseek-chat')));
  register('browser_agent_command','Use the complete Ultrafast command interface. reset starts a run; predict chooses without acting; act consumes the pending decision once and requires its observed fingerprint; tick chooses and acts. Screenshot/record options are independent of model input.',{
    command:z.enum(['reset','predict','act','tick']),goal:z.string().optional(),url:z.string().url().optional(),scenario:z.enum(['flights','travel','research']).optional(),
    fingerprint:z.string().optional(),screenshots:z.boolean().optional(),record:z.boolean().optional(),
  },async({command,...body},extra)=>text(await agentCommand(command,body,inspector?.url,extra.signal)));
  register('browser_inspect','Open the loopback Ultrafast inspector for this task browser. Includes live screenshots, indexed target overlays, operation/target rankings, separate Choose/Execute, auto-run/pause, travel/research scenarios and trace export. Uses global model settings and the existing browser ownership controls.',{port:z.number().int().min(0).max(65535).optional()},async({port})=>{
    inspector??=await startInspector({state:()=>inspectorState(activeAgent,process.env.TEXT_MODEL??'deepseek-chat'),
      command:(name,body,origin)=>{
        const epoch=handoffEpoch;
        const pending=tail.then(async()=>{
          if(epoch!==handoffEpoch||owner==='user') throw new Error('Browser input ownership changed. Observe again.');
          return agentCommand(name,body,origin);
        });tail=pending.catch(()=>{});return pending;
      }},port??0);
    return text({url:inspector.url,message:'Open this URL to inspect and control the task browser. Model credentials come from global settings.'});
  });
  register('browser_verify','Run the upstream independent result verifier on a fresh page, with an optional final screenshot. The flights verifier checks the original Zürich → London September 20, 2026 benchmark; travel checks the inspector scenario.',{
    scenario:z.enum(['flights','travel']),screenshot:z.boolean().optional(),
  },async({scenario,screenshot},extra)=>{
    const b=await browser(),fast=await FastBrowser.attach(b.page,AbortSignal.any([extra.signal,lifetime.signal]));
    try {
      const page=await fast.observe(!!screenshot),verification=scenario==='flights'?verifyFlights(page):verifyTravel(page);
      return {...text({verification,page:{...page,screenshot:undefined}}),...(screenshot?{content:[...text({verification,page:{...page,screenshot:undefined}}).content,{type:'image',data:page.screenshot,mimeType:'image/jpeg'}]}:{})};
    } finally {await fast.detach();}
  });
  register('browser_takeover','Pause task browser automation. For a verification barrier, let the user choose Manual Takeover or Use Computer Use for this page. Other manual steps use Manual Takeover. Wait for their response; a Computer Use choice is permission to try, not proof of success. No browser actions run while the user chooses or handles the step.',{reason:z.string().min(1).max(500)},async ({reason},extra)=>{
    const b=await browser();owner='user';handoffEpoch++;
    const takeoverSignal=AbortSignal.any([extra.signal,lifetime.signal]);
    inputLifetime.abort(new Error('Browser input paused for takeover'));inputLifetime=new AbortController();
    if(activeAgent) activeAgent.decision=null;
    // Drain the interrupted action before the user can interact with this window.
    try {
      await tail.catch(()=>{});takeoverSignal.throwIfAborted();
      await b.page.bringToFront();
      const token=extra._meta?.progressToken;
      let progress=0;
      const timer=setInterval(()=>{
        if(token !== undefined) void server.server.notification({method:'notifications/progress',params:{progressToken:token,progress:++progress,message:'Waiting for the user to choose or finish the browser step'}}).catch(()=>{});
      },10000);
      const ask=async(message,requestedSchema)=>{
        const response=await server.server.elicitInput({mode:'form',message,requestedSchema},{signal:takeoverSignal,timeout:30*60*1000});
        takeoverSignal.throwIfAborted();
        return response;
      };
      try {
        const before=await observe(b);
        if(before.status==='needs_user') {
          const choice=await ask(`Verification required on ${new URL(before.url).origin}\n${reason}\nChoose how to handle this step in the current browser window.`,
            {type:'object',properties:{method:{type:'string',title:'How would you like to continue?',oneOf:[
              {const:'manual',title:'Manual Takeover',description:'Complete the verification yourself, then return control to the agent.'},
              {const:'computer_use',title:'Use Computer Use',description:'Let the agent attempt this verification in the current window using Computer Use.'},
            ]}},required:['method']});
          if(choice.action!=='accept'||!['manual','computer_use'].includes(choice.content?.method))return text({status:'needs_user',message:'No verification method was confirmed. Stop and report the blocked task.',observation:await observe(b)});
          if(choice.content.method==='computer_use') {
            const config=await computerSettings(piDirectory());
            if(!config.enabled||!config.executable)return text({status:'needs_user',method:'computer_use',message:'Computer Use is unavailable. Enable it in global settings and check its connection in Extensions, or call browser_takeover again to choose Manual Takeover.',observation:await observe(b)});
            const observation=await observe(b);
            return text({status:'computer_use_requested',method:'computer_use',target:{url:before.url,title:before.title},observation,
              message:'The user selected Computer Use for this verification step only. Use the enabled eido_computer tools to observe and identify this existing browser window by its title and URL before acting. If the tools or exact window are unavailable, stop and offer Manual Takeover. Do not open another browser or switch profiles. Do not run Browser Use and Computer Use inputs in parallel. The choice does not confirm verification success. After the attempt, end the desktop session and use browser_snapshot to check the actual page before continuing the original task. If verification remains, call browser_takeover again; do not retry indefinitely.'});
          }
        }
        const response=await ask(`Browser paused: ${reason}\nComplete the step in the task browser, then confirm to return control to the agent.`,
          {type:'object',properties:{done:{type:'boolean',title:'I have finished the manual step',default:false}},required:['done']});
        if(response.action!=='accept'||response.content?.done!==true)return text({status:'needs_user',message:'Manual step was not confirmed. Stop and report the blocked task.',observation:await observe(b)});
        return text({status:'resumed',method:'manual',observation:await observe(b)});
      } finally {clearInterval(timer);}
    } finally {owner='agent';handoffEpoch++;}
  },true);
  register('browser_status','Check browser resources and input ownership without launching a browser.',{},async()=>text({browserPath:executable,available:existsSync(executable),open:!!launch,owner,engine}),true);
  register('browser_close','Close the task browser. The next browser call opens an independent session.',{},async()=>{await close();return text({closed:true});},true);
  const shutdown=async()=>{await close();await inspector?.close();await server.close();};
  process.once('SIGINT',()=>{void shutdown().finally(()=>process.exit(0));});
  process.once('SIGTERM',()=>{void shutdown().finally(()=>process.exit(0));});
  process.stdin.once('end',()=>{void shutdown().finally(()=>process.exit(0));});
  await server.connect(new StdioServerTransport());
}
