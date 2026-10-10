// Adapted from browser-use/jev-ultrafast @ 1231850a0bf1a0c0341fe408ef1668dbbfdfac46.
// Copyright 2026 Browser Use. MIT license in ./LICENSE.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import type {Page, CDPSession} from 'playwright';
import {AFTER_INPUT,TARGET} from './scripts.ts';
import type {Action,Snapshot} from './types.ts';
export const READ_STATE=readFileSync(new URL('./snapshot.js',import.meta.url),'utf8').trim();
const MARKER=`(() => {const state=${READ_STATE}; return state?.marker ?? null;})()`;
export class StalePage extends Error {}
export class UncertainAction extends Error {}
// Canonical content identity (the Python digest uses different JSON whitespace).
const canonical=(v:any):string=>JSON.stringify(v===null||typeof v!=='object'?v:Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])));
export function fingerprint(state:Snapshot):string {
  return createHash('sha256').update(canonical({url:state.url,text:state.text,actions:state.actions,scroll:state.scroll})).digest('hex');
}
export class FastBrowser {
  private afterInput:Action|undefined;
  readonly session:CDPSession;
  readonly signal:AbortSignal;
  private constructor(session:CDPSession,signal:AbortSignal) {this.session=session;this.signal=signal;}
  static async attach(page:Page,signal:AbortSignal) {
    signal.throwIfAborted();
    const session=await page.context().newCDPSession(page);
    const browser=new FastBrowser(session,signal);
    try {
      await browser.call('Emulation.setFocusEmulationEnabled',{enabled:true});
      return browser;
    } catch(error) {await session.detach().catch(()=>{});throw error;}
  }
  async call(method:string,params:Record<string,unknown>={}) {
    this.signal.throwIfAborted();
    const result=await (this.session.send as (method:string,params:Record<string,unknown>)=>Promise<any>)(method,params);
    this.signal.throwIfAborted();return result;
  }
  async evaluate(expression:string,mutating=false):Promise<any> {
    try {
      const response=await this.call('Runtime.evaluate',{expression,returnByValue:true});
      if (response.exceptionDetails) throw new Error('Document changed during evaluation');
      return response.result?.value;
    } catch(error) {
      this.signal.throwIfAborted();
      if (mutating) throw new UncertainAction('Dropdown execution was interrupted; inspect before retrying.');
      if (/context|navigat|Document changed/i.test(String(error))) throw new StalePage('Document changed during evaluation');
      throw error;
    }
  }
  async observe():Promise<Snapshot> {
    if (this.afterInput) {
      const action=this.afterInput;this.afterInput=undefined;
      try {await this.call('Runtime.evaluate',{expression:AFTER_INPUT+JSON.stringify(action)+')',awaitPromise:true,returnByValue:true});}
      catch {this.signal.throwIfAborted();}
    }
    for (let attempt=0;attempt<10;attempt++) {
      try {
        const state=await this.evaluate(READ_STATE) as Snapshot|null;
        if (!state) throw new StalePage('Document is navigating');
        state.fingerprint=fingerprint(state);return state;
      } catch(error) {
        if (!(error instanceof StalePage) || attempt===9) throw error;
        await delay(20,undefined,{signal:this.signal});
      }
    }
    throw new StalePage('Page did not settle');
  }
  async fresh(page:Snapshot,action?:Action) {
    if (action && ['click','select'].includes(action.kind)) {
      if (!Number.isInteger(action.node)) return false;
      const current=await this.evaluate(`(() => {const c=window.__jevFast;return c?[c.pageKey(),c.guard(c.nodes.get(${action.node}))]:null;})()`);
      return isDeepStrictEqual(current,[page.page_key,page.guards[String(action.node)]]);
    }
    return isDeepStrictEqual(await this.evaluate(MARKER),page.marker);
  }
  async act(action:Action,page:Snapshot,text:string|null=null) {
    if (!await this.fresh(page,action)) throw new StalePage('Page changed since this decision. Observe again.');
    if (action.kind==='wait') await delay(100,undefined,{signal:this.signal});
    else if (action.kind==='scroll') await this.call('Input.dispatchMouseEvent',{type:'mouseWheel',x:550,y:650,deltaX:0,deltaY:action.delta});
    else {
      if (!Number.isInteger(action.node)) throw new Error('Invalid observed node');
      const target=await this.evaluate(TARGET+JSON.stringify(action)+')',action.kind==='select');
      if (!target) {
        if (action.kind==='select') throw new UncertainAction('Dropdown execution was not confirmed; inspect before retrying.');
        throw new StalePage('Target changed or is covered. Observe again.');
      }
      if (action.kind!=='select') {
        try {
          for (const type of ['mousePressed','mouseReleased']) await this.call('Input.dispatchMouseEvent',{type,x:target.x,y:target.y,button:'left',clickCount:1});
          if (action.kind==='fill') {
            if (typeof text!=='string') throw new Error('No generated field value');
            const key={key:'a',code:'KeyA',modifiers:process.platform==='darwin'?4:2};
            await this.call('Input.dispatchKeyEvent',{type:'keyDown',...key,commands:['selectAll']});
            await this.call('Input.dispatchKeyEvent',{type:'keyUp',...key});
            await this.call('Input.insertText',{text});
          }
        } catch {this.signal.throwIfAborted();throw new UncertainAction('Input execution was interrupted; inspect before retrying.');}
      }
    }
    this.afterInput=action.kind==='wait'?undefined:action;
    return {executed:action.id};
  }
  async detach() {await this.session.detach().catch(()=>{});}
}
