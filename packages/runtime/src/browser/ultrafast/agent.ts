// Adapted from browser-use/jev-ultrafast @ 1231850a0bf1a0c0341fe408ef1668dbbfdfac46.
// Copyright 2026 Browser Use. MIT license in ./LICENSE.
import {isDeepStrictEqual} from 'node:util';
import {StalePage} from './browser.ts';
import {choose,fieldContext,fieldText} from './model.ts';
import type {Action,Decision,Helper,History,ModelConfig,Snapshot,TextConfig} from './types.ts';
export interface BrowserPort {
  observe():Promise<Snapshot>;fresh(page:Snapshot,action?:Action):Promise<boolean>;
  act(action:Action,page:Snapshot,text?:string|null):Promise<unknown>;
}
export interface RunOptions {
  decision:ModelConfig;text:TextConfig;signal:AbortSignal;maxActions?:number;
  progress?:(event:Record<string,unknown>)=>void|Promise<void>;
  barrier?:(page:Snapshot)=>boolean;
}
export class FastAgent {
  readonly browser:BrowserPort; readonly goal:string; readonly options:RunOptions;
  page!:Snapshot; decision:Decision|null=null; status:'ready'|'predicted'|'done'|'blocked'|'needs_user'='ready';
  history:History[]=[]; decisions:Decision[]=[]; textCalls:Record<string,unknown>[]=[];
  staleRetries=0; started=0; reason='';
  private pendingText:{context:ReturnType<typeof fieldContext>;text:string;helper:Helper}|undefined;
  constructor(browser:BrowserPort,goal:string,options:RunOptions) {
    if (!goal.trim()) throw new Error('Supply a browser goal');
    this.browser=browser;this.goal=goal.trim();this.options=options;
  }
  get elapsed() {return this.started?Math.round(performance.now()-this.started):0;}
  async notify(event:Record<string,unknown>) {await this.options.progress?.({...event,elapsed_ms:this.elapsed});}
  async predict() {
    this.options.signal.throwIfAborted();
    this.started ||= performance.now();
    if (!['ready','predicted'].includes(this.status)) throw new Error('This run has stopped. Start a new browser goal.');
    this.decision=null;
    if (!await this.browser.fresh(this.page)) this.page=await this.browser.observe();
    if (this.options.barrier?.(this.page)) {this.status='needs_user';this.reason='Verification required. Use browser_takeover, then re-observe.';return;}
    if (this.decisions.length>=2*(this.options.maxActions??60)) {this.status='blocked';this.reason='Reached the model-call budget';return;}
    await this.notify({phase:'deciding',step:this.history.length+1});
    this.decision=await choose(this.page,this.goal,this.history,this.options.decision,this.options.signal);
    this.options.signal.throwIfAborted();
    this.decisions.push(this.decision);this.status='predicted';
  }
  async act(expectedFingerprint:string) {
    this.options.signal.throwIfAborted();
    const decision=this.decision,page=this.page;
    if (!decision || expectedFingerprint!==page.fingerprint) throw new Error('Observe and choose before acting');
    this.decision=null; // Consume before mutation or text generation.
    const selected=decision.choice;
    if (selected==='DONE'||selected==='BLOCKED') {
      if (!await this.browser.fresh(page)) throw new StalePage('Page changed since the decision. Choose again.');
      this.status=selected==='DONE'?'done':'blocked';return;
    }
    const action=page.actions.find(a=>a.id===selected);
    if (!action) throw new Error('Invalid observed action');
    if (this.history.length>=(this.options.maxActions??60)) {this.status='blocked';this.reason='Reached the action budget';return;}
    let text:string|null=null, helper:Helper|null=null;
    if (action.kind==='fill') {
      if (!await this.browser.fresh(page)) throw new StalePage('Page changed before text generation. Choose again.');
      const context=fieldContext(this.goal,action,page,this.history);
      if (this.pendingText && isDeepStrictEqual(context,this.pendingText.context)) ({text,helper}=this.pendingText);
      else {
        await this.notify({phase:'generating_text',field:action.label});
        ({text,helper}=await fieldText(context,this.options.text,this.options.signal));
        this.pendingText={context,text,helper};this.textCalls.push({...helper,field:action.label,value:text});
      }
    }
    await this.notify({phase:'acting',operation:decision.operation,target:action.label});
    await this.browser.act(action,page,text);
    this.pendingText=undefined;
    const item:History={step:this.history.length+1,action:action.label,kind:action.kind,choice:selected,
      probability:decision.probabilities[selected],confidence:decision.confidence,latency_ms:decision.latency_ms,
      text,text_helper:helper?.model??null,text_latency_ms:helper?.latency_ms??0,operation:decision.operation,target:decision.target,
      page_changed:null,url:page.url,usage:decision.usage,executed_ms:this.elapsed,elapsed_ms:this.elapsed};
    this.history.push(item); // Keep execution even if post-action observation is interrupted.
    this.page=await this.browser.observe();
    Object.assign(item,{page_changed:this.page.fingerprint!==page.fingerprint,url:this.page.url,elapsed_ms:this.elapsed});
    const repeated=this.history.slice(-3);
    this.status=repeated.length===3&&repeated.every(h=>h.page_changed===false&&h.kind!=='wait')?'blocked':'ready';
    if (this.status==='blocked') this.reason='Three actions made no observable progress';
    await this.notify({phase:'observed',...item});
  }
  async tick() {
    try {await this.predict();if (this.decision) await this.act(this.page.fingerprint);}
    catch(error) {
      this.decision=null;
      if (!(error instanceof StalePage)) throw error;
      this.staleRetries++;this.status='ready';this.page=await this.browser.observe();
      await this.notify({phase:'stale',message:error.message});
    }
  }
  async run() {
    this.page=await this.browser.observe();
    // Bound pre-prediction navigation failures too, which spend no model budget.
    for (let ticks=0;ticks<(this.options.maxActions??60)*4;ticks++) {
      await this.tick();
      if (['done','blocked','needs_user'].includes(this.status)) return this.result();
    }
    this.status='blocked';this.reason='Page kept changing; reached the observation budget';return this.result();
  }
  result() {
    return {status:this.status==='done'?'likely_done':this.status,engine:'ultrafast',reason:this.reason,
      elapsed_ms:this.elapsed,actions:this.history.length,model_calls:this.decisions.length,text_calls:this.textCalls.length,stale_retries:this.staleRetries,
      history:this.history,decisions:this.decisions,textCalls:this.textCalls,
      observation:{url:this.page?.url,title:this.page?.title,text:this.page?.text,omitted_actions:this.page?.omitted_actions},
      verification:'Check the observed page against every requirement. A DONE decision is not independent proof of success.'};
  }
}
