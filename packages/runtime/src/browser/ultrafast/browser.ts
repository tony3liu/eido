// Adapted from browser-use/jev-ultrafast @ 1231850a0bf1a0c0341fe408ef1668dbbfdfac46.
// Copyright 2026 Browser Use. MIT license in ./LICENSE.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium, type Page, type CDPSession, type BrowserContext} from 'playwright';
import {AFTER_INPUT,TARGET} from './scripts.ts';
import {pythonJson} from './json.ts';
import type {Action,Snapshot} from './types.ts';
export const READ_STATE=readFileSync(new URL('./snapshot.js',import.meta.url),'utf8').trim();
const MARKER=`(() => {const state=${READ_STATE}; return state?.marker ?? null;})()`;
export class StalePage extends Error {}
export class UncertainAction extends Error {}
export function fingerprint(state:Snapshot):string {
  return createHash('sha256').update(pythonJson({url:state.url,text:state.text,actions:state.actions,scroll:state.scroll},true)).digest('hex');
}
export class FastBrowser {
  private afterInput:Action|undefined;
  readonly session:CDPSession;
  signal:AbortSignal;
  page:Page|undefined;
  target:string|null=null;
  private ownedClose:(()=>Promise<void>)|undefined;
  private constructor(session:CDPSession,signal:AbortSignal) {this.session=session;this.signal=signal;}
  static async attach(page:Page,signal:AbortSignal) {
    signal.throwIfAborted();
    const session=await page.context().newCDPSession(page);
    const browser=new FastBrowser(session,signal);
    browser.page=page;
    try {
      await browser.call('Emulation.setDeviceMetricsOverride',{width:1120,height:780,deviceScaleFactor:1,mobile:false});
      await browser.call('Emulation.setFocusEmulationEnabled',{enabled:true});
      browser.target=(await browser.call('Target.getTargetInfo')).targetInfo.targetId;
      return browser;
    } catch(error) {await session.detach().catch(()=>{});throw error;}
  }
  // Owned background target, persistent CDP session, and the upstream navigation policy.
  static async create(url:string,signal:AbortSignal,options:{context?:BrowserContext;headed?:boolean}={}) {
    signal.throwIfAborted();
    const owned=options.context?undefined:await chromium.launch({headless:!options.headed});
    const context=options.context??await owned!.newContext({viewport:{width:1120,height:780}});
    let fast:FastBrowser|undefined;
    let createdPage:Page|undefined;
    try {
      const root=await context.browser()!.newBrowserCDPSession();
      const existing=context.pages()[0], probe=existing??await context.newPage();
      const probeSession=await context.newCDPSession(probe);
      let browserContextId:string;
      try {browserContextId=(await probeSession.send('Target.getTargetInfo')).targetInfo.browserContextId!;}
      finally {await probeSession.detach();if(!existing) await probe.close();}
      try {
        const appeared=context.waitForEvent('page');
        await root.send('Target.createTarget',{url:'about:blank',background:true,browserContextId});
        createdPage=await appeared;
      }
      finally {await root.detach();}
      fast=await FastBrowser.attach(createdPage,signal);
      fast.ownedClose=owned?()=>owned.close():()=>createdPage!.close();
      await fast.navigate(url);return fast;
    } catch(error) {await fast?.detach();await createdPage?.close().catch(()=>{});await owned?.close();throw error;}
  }
  async navigate(url:string) {
    await this.call('Page.navigate',{url});
    const deadline=performance.now()+15_000;
    while(performance.now()<deadline) {
      if(await this.evaluate('document.readyState')==='complete') break;
      await delay(20,undefined,{signal:this.signal});
    }
  }
  async call(method:string,params:Record<string,unknown>={}) {
    this.signal.throwIfAborted();
    // Browser Harness's raw CDP port bounds response waits at five seconds.
    const result=await new Promise<any>((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error(`${method} timed out after 5s waiting for the browser`)),5000);
      (this.session.send as (method:string,params:Record<string,unknown>)=>Promise<any>)(method,params)
        .then(value=>{clearTimeout(timeout);resolve(value);},error=>{clearTimeout(timeout);reject(error);});
    });
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
  async observe(screenshot=true):Promise<Snapshot> {
    if (this.afterInput) {
      const action=this.afterInput;this.afterInput=undefined;
      try {await this.call('Runtime.evaluate',{expression:AFTER_INPUT+JSON.stringify(action)+')',awaitPromise:true,returnByValue:true});}
      catch {this.signal.throwIfAborted();}
    }
    for (let attempt=0;attempt<10;attempt++) {
      try {
        const state=await this.evaluate(READ_STATE) as Snapshot|null;
        if (!state) throw new StalePage('Document is navigating');
        state.fingerprint=fingerprint(state);
        if(screenshot) state.screenshot=(await this.call('Page.captureScreenshot',{format:'jpeg',quality:72})).data;
        return state;
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
  async close() {
    if(!this.target) return;
    this.target=null;
    await this.detach();
    if(this.ownedClose) await this.ownedClose();else await this.page?.close();
  }
}
