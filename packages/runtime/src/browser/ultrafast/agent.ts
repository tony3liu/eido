// Adapted from browser-use/jev-ultrafast @ 1231850a0bf1a0c0341fe408ef1668dbbfdfac46.
// Copyright 2026 Browser Use. MIT license in ./LICENSE.
import {isDeepStrictEqual} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {FastBrowser,StalePage} from './browser.ts';
import {actionSpace,choose,fieldContext,fieldText} from './model.ts';
import type {Action,Decision,Helper,History,ModelConfig,Snapshot,TextConfig} from './types.ts';
export interface BrowserPort {
  observe(screenshot?:boolean):Promise<Snapshot>;fresh(page:Snapshot,action?:Action):Promise<boolean>;
  act(action:Action,page:Snapshot,text?:string|null):Promise<unknown>;close?():Promise<void>;
}
export interface RunOptions {
  decision:ModelConfig;text:TextConfig;signal:AbortSignal;maxActions?:number;
  screenshots?:boolean;recordDir?:string;observationBudget?:number;
  progress?:(event:Record<string,unknown>)=>void|Promise<void>;
  barrier?:(page:Snapshot)=>boolean;
}
export class FastAgent {
  browser:BrowserPort;readonly goal:string;readonly options:RunOptions;
  page!:Snapshot;decision:Decision|null=null;status:'ready'|'predicted'|'done'|'blocked'|'needs_user'='ready';
  history:History[]=[];decisions:Decision[]=[];textCalls:Record<string,unknown>[]=[];
  staleRetries=0;started=0;reason='';plan:string[];planIndex=0;elapsedMs=0;
  scenario?:string;
  private initialized=false;
  private pendingText:{context:ReturnType<typeof fieldContext>;text:string;helper:Helper}|undefined;
  constructor(browser:BrowserPort,goals:string|string[],options:RunOptions) {
    const task=(typeof goals==='string'?goals:goals.join('\n')).trim();
    if(!task) throw new Error('Supply a task');
    this.browser=browser;this.goal=task;this.plan=[task];this.options=options;
  }
  static async create(url:string,goals:string|string[],options:RunOptions) {
    // Validate before creating browser resources, as upstream does.
    const task=(typeof goals==='string'?goals:goals.join('\n')).trim();
    if(!task) throw new Error('Supply a task');
    const browser=await FastBrowser.create(url,options.signal);
    const agent=new FastAgent(browser,task,options);
    try {await agent.initialize();return agent;} catch(error) {await browser.close();throw error;}
  }
  get screenshots(){return !!(this.options.screenshots||this.options.recordDir);}
  get elapsed(){return this.started?Math.round(performance.now()-this.started):0;}
  async initialize() {
    if(this.initialized||this.page) return;
    this.page=await this.browser.observe(this.screenshots);
    if(this.options.recordDir) {
      await mkdir(this.options.recordDir,{recursive:true});
      await this.recordFrame(0);
    }
    this.initialized=true;
  }
  private async recordFrame(timestamp:number) {
    if(!this.options.recordDir) return;
    if(!this.page.screenshot) throw new Error('Browser returned no recording frame');
    await writeFile(join(this.options.recordDir,String(timestamp).padStart(6,'0')+'.jpg'),Buffer.from(this.page.screenshot,'base64'));
  }
  snapshot() {
    return {goal:this.goal,page:this.page,decision:this.decision,history:this.history,status:this.status,
      plan:this.plan,plan_index:this.planIndex,decisions:this.decisions,text_calls:this.textCalls,
      elapsed_ms:this.elapsedMs,started_at:this.started?this.started/1000:null,record:!!this.options.recordDir,
      elements:this.page?actionSpace(this.page.actions).elements:[],...(this.scenario?{scenario:this.scenario}:{})};
  }
  async notify(event:Record<string,unknown>){await this.options.progress?.({...event,elapsed_ms:this.elapsed});}
  async predict() {
    this.options.signal.throwIfAborted();await this.initialize();
    this.started ||= performance.now();
    if(!await this.browser.fresh(this.page)) this.page=await this.browser.observe(this.screenshots);
    this.decision=null;
    if(['done','blocked'].includes(this.status)) throw new Error('This run has stopped. Start a fresh demo.');
    if(this.options.barrier?.(this.page)) {this.status='needs_user';this.reason='Verification required. Use browser_takeover, then re-observe.';return;}
    if(this.decisions.length>=2*(this.options.maxActions??60)) throw new Error("Reached the demo's model-call budget");
    await this.notify({phase:'deciding',step:this.history.length+1});
    this.decision=await choose(this.page,this.goal,this.history,this.options.decision,this.options.signal);
    this.options.signal.throwIfAborted();
    this.decisions.push({...this.decision,fingerprint:this.page.fingerprint,elapsed_ms:this.elapsed});this.status='predicted';
  }
  async act(expectedFingerprint:string) {
    this.options.signal.throwIfAborted();
    const decision=this.decision,page=this.page;
    if(!decision||expectedFingerprint!==page.fingerprint) throw new Error('Observe and choose before acting');
    this.decision=null; // Consume before mutation or text generation.
    const selected=decision.choice;
    if(selected==='DONE'||selected==='BLOCKED') {
      if(!await this.browser.fresh(page)) {this.status='ready';throw new StalePage('Page changed since the decision. Choose again.');}
      this.status=selected==='DONE'?'done':'blocked';this.planIndex=Number(selected==='DONE');this.elapsedMs=this.elapsed;return;
    }
    const action=page.actions.find(a=>a.id===selected);
    if(!action) throw new Error('Invalid observed action');
    if(this.history.length>=(this.options.maxActions??60)) {
      this.status='blocked';throw new Error(`Stopped at the ${this.options.maxActions??60}-action demo budget`);
    }
    let text:string|null=null,helper:Helper|null=null;
    if(action.kind==='fill') {
      if(!await this.browser.fresh(page)) throw new StalePage('Page changed before text generation. Choose again.');
      const context=fieldContext(this.goal,action,page,this.history);
      if(this.pendingText&&isDeepStrictEqual(context,this.pendingText.context)) ({text,helper}=this.pendingText);
      else {
        await this.notify({phase:'generating_text',field:action.label});
        ({text,helper}=await fieldText(context,this.options.text,this.options.signal));
        this.pendingText={context,text,helper};this.textCalls.push({...helper,field:action.label,value:text});
      }
    }
    await this.notify({phase:'acting',operation:decision.operation,target:action.label});
    await this.browser.act(action,page,text);this.pendingText=undefined;this.elapsedMs=this.elapsed;
    const item:History={step:this.history.length+1,action:action.label,kind:action.kind,choice:selected,
      probability:decision.probabilities[selected],confidence:decision.confidence,latency_ms:decision.latency_ms,
      text,text_helper:helper?.model??null,text_latency_ms:helper?.latency_ms??0,operation:decision.operation,target:decision.target,
      page_changed:null,url:page.url,usage:decision.usage,executed_ms:this.elapsed,elapsed_ms:this.elapsedMs};
    this.history.push(item); // Execution survives an interrupted post-action observation.
    this.page=await this.browser.observe(this.screenshots);this.elapsedMs=this.elapsed;
    Object.assign(item,{page_changed:this.page.fingerprint!==page.fingerprint,url:this.page.url,elapsed_ms:this.elapsedMs});
    await this.recordFrame(this.elapsedMs);
    const repeated=this.history.slice(-3);
    this.status=repeated.length===3&&repeated.every(h=>h.page_changed===false&&h.kind!=='wait')?'blocked':'ready';
    if(this.status==='blocked') this.reason='Three actions made no observable progress';
    await this.notify({phase:'observed',...item});
  }
  async tick() {
    try {await this.predict();if(this.decision) await this.act(this.page.fingerprint);}
    catch(error) {
      if(!(error instanceof StalePage)) throw error;
      this.decision=null;this.staleRetries++;this.status='ready';
      this.page=await this.browser.observe(this.screenshots);this.elapsedMs=this.elapsed;
      await this.notify({phase:'stale',message:error.message});
    }
  }
  async command(name:string,body:Record<string,unknown>={}) {
    if(name==='predict') await this.predict();
    else if(name==='act') await this.act(body.fingerprint as string);
    else if(name==='tick') await this.tick();
    else throw new Error('Unknown command');
    return this.snapshot();
  }
  // The upstream generator contract; exceptions and budgets remain observable.
  async *run() {
    await this.initialize();let ticks=0;
    while(!['done','blocked','needs_user'].includes(this.status)) {
      if(this.options.observationBudget!==undefined&&ticks++>=this.options.observationBudget) {
        this.status='blocked';this.reason='Page kept changing; reached the observation budget';break;
      }
      yield await this.command('tick');
    }
  }
  // ACP convenience response. It preserves the full state and reports budget stops.
  async *runStates(){yield* this.run();}
  async runToCompletion() {
    try {for await(const _state of this.run()) { /* Each state remains available through run(). */ }}
    catch(error) {
      if(!/demo.*budget|action demo budget/.test(String((error as Error).message))) throw error;
      this.status='blocked';this.reason=(error as Error).message;
    }
    return this.result();
  }
  result() {
    return {status:this.status==='done'?'likely_done':this.status,engine:'ultrafast',reason:this.reason,
      elapsed_ms:this.elapsedMs,actions:this.history.length,model_calls:this.decisions.length,text_calls:this.textCalls.length,stale_retries:this.staleRetries,
      history:this.history,decisions:this.decisions,textCalls:this.textCalls,state:this.snapshot(),
      observation:{url:this.page?.url,title:this.page?.title,text:this.page?.text,omitted_actions:this.page?.omitted_actions},
      verification:'Check the observed page against every requirement. A DONE decision is not independent proof of success.'};
  }
  async close(){await this.browser.close?.();}
  async [Symbol.asyncDispose](){await this.close();}
}
export {FastAgent as Agent};
