import {parseArgs} from 'node:util';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {browserDirectory,piDirectory} from '../src/paths.mjs';
import {browserDecisionEnvironment} from '../src/browser/config.mjs';
process.env.PLAYWRIGHT_BROWSERS_PATH??=browserDirectory();
Object.assign(process.env,await browserDecisionEnvironment(piDirectory()));
const {Agent}=await import('../src/browser/ultrafast/agent.ts');
const {startRecording}=await import('../src/browser/ultrafast/recording.ts');
const {FLIGHTS_URL,FLIGHTS_GOAL,verifyFlights,verifyTravel}=await import('../src/browser/ultrafast/verification.ts');
const {values,positionals}=parseArgs({allowPositionals:true,options:{url:{type:'string'},goal:{type:'string',multiple:true},output:{type:'string'},screenshots:{type:'boolean'},'max-actions':{type:'string'},scenario:{type:'string'},ffmpeg:{type:'string'}}});
const mode=positionals[0]??'run';
if(mode==='demo') {
  const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
  const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client=new Client({name:'eido-browser-inspector',version:'1'},{capabilities:{}});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./browser-server.mjs',import.meta.url))],env:{...process.env},stderr:'inherit'});
  await client.connect(transport);
  const result=await client.callTool({name:'browser_inspect',arguments:{port:Number(process.env.TYPESAFE_DEMO_PORT??8766)}});
  console.log(JSON.parse(result.content.find(c=>c.type==='text').text).url);
  await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
  await client.close();process.exit(0);
}
if(mode==='render') {
  const {renderRecording}=await import('../src/browser/ultrafast/render.ts');
  if(!values.output)throw new Error('render needs --output pointing to a verified recording');
  console.log(JSON.stringify(await renderRecording(values.output,values.ffmpeg??'ffmpeg',values.scenario==='travel'?'fixture':'flights')));
  process.exit(0);
}
if(!['run','measure','record','smoke'].includes(mode)) throw new Error('Use demo, run, measure, record, smoke or render');
const url=values.url??(mode==='smoke'?'http://127.0.0.1:8766/fixture.html?scenario=travel':FLIGHTS_URL);
const goals=values.goal??[mode==='smoke'?'Use the destination search and filters to find Design stays in Lisbon with Free cancellation, then open Casa Flora.':FLIGHTS_GOAL];
const maxActions=values['max-actions']?Number(values['max-actions']):60;
if(!Number.isInteger(maxActions)||maxActions<1||maxActions>60)throw new Error('--max-actions must be an integer from 1 to 60');
const signal=new AbortController();process.once('SIGINT',()=>signal.abort());process.once('SIGTERM',()=>signal.abort());
const output=values.output;
if(output)await mkdir(output,{recursive:true});
const agent=await Agent.create(url,goals,{signal:signal.signal,screenshots:!!values.screenshots,
  maxActions,
  decision:{apiUrl:process.env.JEV_API_URL,model:process.env.JEV_MODEL,key:process.env.TYPESAFE_API_KEY},
  text:{apiUrl:process.env.TEXT_MODEL_BASE_URL,model:process.env.TEXT_MODEL,key:process.env.TEXT_MODEL_API_KEY,reasoning:process.env.TEXT_MODEL_REASONING}});
const timings={};const raw=agent.browser.call.bind(agent.browser);
agent.browser.call=async(method,params)=>{const start=performance.now();try{return await raw(method,params);}finally{(timings[method]??=[]).push(performance.now()-start);}};
let recording,error;
try {
  if(mode==='record'){if(!output)throw new Error('record needs --output');recording=await startRecording(agent.browser,output);recording.anchor();}
  for await(const state of agent.run()){
    console.log(`${state.elapsed_ms} ms  ${state.history.length} actions  ${state.status}  ${state.history.at(-1)?.action??''}`);
    if(output&&mode==='smoke')await writeFile(join(output,'state.json'),JSON.stringify(state,null,2));
  }
} catch(failure){error=String(failure.message??failure);}
finally {
  try {
    const measured=Object.fromEntries(Object.entries(timings).map(([method,times])=>[method,{count:times.length,ms:Math.round(times.reduce((a,b)=>a+b,0)*1000)/1000}]));
    const recordingResult=await recording?.stop();
    const final=await agent.browser.observe(mode==='measure');
    const scenario=values.scenario??(mode==='smoke'?'travel':'flights');
    const verification=scenario==='travel'?verifyTravel(final):verifyFlights(final);
    const sourceHashes={};
    for(const name of ['agent.ts','browser.ts','model.ts','questions.ts','snapshot.js']) {
      const file=new URL('../src/browser/ultrafast/'+name,import.meta.url);
      const contents=await readFile(file).catch(()=>readFile(new URL(file.href.replace(/\.ts$/,'.js'))));
      sourceHashes[name]=createHash('sha256').update(contents).digest('hex');
    }
    const state={...agent.snapshot(),source_hashes:sourceHashes,final_page:final,verification,error:error??null,cdp:measured,
      task_hash:createHash('sha256').update(JSON.stringify([url,goals])).digest('hex'),
      configuration:{TYPESAFE_MODEL:process.env.JEV_MODEL,TEXT_MODEL:process.env.TEXT_MODEL,TEXT_MODEL_BASE_URL:process.env.TEXT_MODEL_BASE_URL,TEXT_MODEL_REASONING:process.env.TEXT_MODEL_REASONING},
      browser_version:(await agent.browser.call('Browser.getVersion')).product,...recordingResult};
    if(output){await writeFile(join(output,'state.json'),JSON.stringify(state,null,2));await writeFile(join(output,'session.json'),JSON.stringify({target:agent.browser.target,session:'owned-persistent-cdp'}));}
    console.log(JSON.stringify({verified:verification.passed,error:error??null,elapsed_ms:state.elapsed_ms}));
    if(error||(['measure','record','smoke'].includes(mode)&&!verification.passed))process.exitCode=1;
  } finally {await agent.close();}
}
