import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { JevBrowser } from 'jev-browser';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const text = value => ({ content: [{type:'text', text:typeof value === 'string' ? value : JSON.stringify(value)}] });
const barrier = page => /captcha|verify you are human|security verification|安全验证|人机验证/i.test(`${page.title} ${page.text}`);

// Eido owns transport, serialization and handoff. All page interpretation and
// browser actions use JevBrowser's published API; neither pi nor Jev is patched.
export async function serveBrowser() {
  const server = new McpServer({name:'eido-browser', version:'0.0.1'});
  let launch, tail = Promise.resolve(), owner = 'agent', handoffEpoch = 0;
  const executable = chromium.executablePath();
  async function browser() {
    if (!existsSync(executable)) throw new Error(`Bundled browser unavailable at ${executable}. Reinstall Eido with its matching browser resources; do not install packages into the running app.`);
    launch ??= JevBrowser.launch({headed:process.env.JEV_BROWSER_HEADED !== '0', highlight:process.env.JEV_BROWSER_HEADED !== '0'})
      .catch(error => {launch=undefined;throw error;});
    return launch;
  }
  async function close() {
    handoffEpoch++;
    const pending = launch;
    launch = undefined;
    owner = 'agent';
    await (await pending?.catch(()=>undefined))?.close();
  }
  async function observe(b) {
    const snapshot = await b.snapshotText();
    const page = b.lastPage;
    return {url:page.url, title:page.title, status:barrier(page)?'needs_user':'ready',
      ...(barrier(page)?{message:'User verification required. Use browser_takeover and wait for the user; re-observe before continuing.'}:{}), snapshot};
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
    const b=await browser();await b.open(url);return text(await observe(b));
  });
  register('browser_snapshot','Re-observe the current page and numbered elements before acting, especially after navigation, errors or user takeover.',{},async()=>text(await observe(await browser())));
  register('browser_act','Act on an element from the latest snapshot. Actions serialize even when Code Mode calls them in parallel. Re-observe after every action.',{
    action:z.enum(['click','type','press_enter','press_key','select','hover','right_click','drag','upload','scroll','back']),
    element:z.number().int().optional(),value:z.string().optional(),key:z.string().optional(),destination:z.number().int().optional(),accept_dialog:z.boolean().optional(),
  },async ({accept_dialog,...args})=>{
    const b=await browser();const action=await b.actOn({...args,acceptDialog:!!accept_dialog});return text({...action,...await observe(b)});
  });
  register('browser_do','Work toward one observable outcome using the configured Jev decision service. Put every string to type in values. Verify likely_done results; use browser_takeover for login or verification barriers.',{
    goal:z.string(),values:z.record(z.string(),z.string()).optional(),max_actions:z.number().int().min(1).max(30).optional(),allow_irreversible:z.boolean().optional(),explain:z.boolean().optional(),
  },async ({goal,values,max_actions,allow_irreversible,explain})=>{
    const b=await browser(),before=await observe(b);
    if(before.status==='needs_user')return text(before);
    const r=await b.do(goal,{values:values??{},maxActions:max_actions??10,allowIrreversible:!!allow_irreversible});
    return text({...r,...(!explain?{rounds:undefined}:{}),observation:await observe(b)});
  });
  register('browser_check','Ask a yes/no question with the configured Jev service. Probabilities between 0.15 and 0.85 require direct observation.',{question:z.string()},async ({question})=>text({question,p_yes:await (await browser()).check(question)}));
  register('browser_choose','Choose between supplied options using the configured Jev service.',{question:z.string(),options:z.array(z.string()).min(2).max(255)},async ({question,options})=>text(await (await browser()).choose(question,options)));
  register('browser_screenshot','Capture the actual browser viewport as an image. A vision-capable conversation model is needed to interpret it.',{full_page:z.boolean().optional()},async ({full_page})=>{
    const data=await (await browser()).screenshot({fullPage:!!full_page});return {content:[{type:'image',data:data.toString('base64'),mimeType:'image/png'}]};
  });
  register('browser_takeover','Pause task browser automation while the user handles login, verification or another manual step in the visible browser. Wait for their response and return a fresh observation. No actions run while the user owns the browser.',{reason:z.string().min(1).max(500)},async ({reason},extra)=>{
    const b=await browser();await b.page.bringToFront();owner='user';handoffEpoch++;
    try {
      const token=extra._meta?.progressToken;
      let progress=0;
      const timer=setInterval(()=>{
        if(token !== undefined) void server.server.notification({method:'notifications/progress',params:{progressToken:token,progress:++progress,message:'Waiting for the user to finish the browser step'}}).catch(()=>{});
      },10000);
      let response;
      try { response=await server.server.elicitInput({mode:'form',message:`Browser paused: ${reason}\nComplete the step in the task browser, then confirm to return control to the agent.`,
        requestedSchema:{type:'object',properties:{done:{type:'boolean',title:'I have finished the manual step',default:false}},required:['done']}},{signal:extra.signal,timeout:30*60*1000}); } finally {clearInterval(timer);}
      extra.signal.throwIfAborted();
      if(response.action!=='accept'||response.content?.done!==true)return text({status:'needs_user',message:'Manual step was not confirmed. Stop and report the blocked task.',observation:await observe(b)});
      return text({status:'resumed',observation:await observe(b)});
    } finally {owner='agent';handoffEpoch++;}
  });
  register('browser_status','Check browser resources and input ownership without launching a browser.',{},async()=>text({browserPath:executable,available:existsSync(executable),open:!!launch,owner}),true);
  register('browser_close','Close the task browser. The next browser call opens an independent session.',{},async()=>{await close();return text({closed:true});},true);
  const shutdown=async()=>{await close();await server.close();};
  process.once('SIGINT',()=>{void shutdown().finally(()=>process.exit(0));});
  process.once('SIGTERM',()=>{void shutdown().finally(()=>process.exit(0));});
  process.stdin.once('end',()=>{void shutdown().finally(()=>process.exit(0));});
  await server.connect(new StdioServerTransport());
}
