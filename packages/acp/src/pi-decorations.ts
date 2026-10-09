import {TuiMainScreen, type Component, type Terminal, type TUI} from '@earendil-works/pi-tui';
import type {AgentSession, ExtensionUIContext, Theme} from '@earendil-works/pi-coding-agent';
import {FooterDataProvider} from '../node_modules/@earendil-works/pi-coding-agent/dist/core/footer-data-provider.js';
import type {createPiUIState} from './pi-ui-state.ts';

type DisposableComponent = Component & {dispose?():void};
type Factory = (tui:TUI, theme:Theme) => DisposableComponent;
type Placement = 'aboveEditor' | 'belowEditor' | 'header' | 'footer';

/** Render passive pi components into native text surfaces, retaining ANSI colors and cell layout. */
export function createPiDecorations(pi:AgentSession, state:ReturnType<typeof createPiUIState>,
  theme:()=>Theme, report:(text:string)=>void) {
  const views = new Map<string, {factory:Factory; placement:Placement; component:DisposableComponent;
    screen:TuiMainScreen; timer?:ReturnType<typeof setTimeout>; last:string; closed:boolean}>();
  const statuses = new Map<string,string>();
  let footer:FooterDataProvider|undefined;
  let closed=false;
  const publish=(key:string,lines:string[]|undefined,placement:Placement)=>{
    if(placement==='header'||placement==='footer')state.setDecoration(placement,lines);
    else state.setComponentWidget(key.slice('widget:'.length),lines,placement);
  };
  const remove=(key:string)=>{
    const view=views.get(key); if(!view)return;
    views.delete(key); view.closed=true; clearTimeout(view.timer);
    try {view.component.dispose?.();} catch(error){report(`Extension component cleanup: ${String(error)}`);}
    view.screen.clear();
    publish(key,undefined,view.placement);
  };
  const set=(key:string,factory:Factory|undefined,placement:Placement)=>{
    remove(key); if(!factory||closed)return;
    const render=()=>{
      const view=views.get(key); if(!view||view.closed)return;
      view.timer=undefined;
      try {
        const lines=view.component.render(state.columns());
        if(lines.length>512||lines.join('\n').length>262_144)throw new Error('Extension component exceeds the native display limit.');
        const signature=JSON.stringify(lines);
        if(view.last!==signature){view.last=signature;publish(key,lines,placement);}
      }catch(error){remove(key);report(`Extension component: ${String(error)}`);}
    };
    const request=()=>{
      const view=views.get(key);
      if(view&&!view.closed&&!view.timer)view.timer=setTimeout(render,32);
    };
    const terminal:Terminal={
      start(){},stop(){},drainInput:async()=>{},write(){},
      get columns(){return state.columns();},rows:24,kittyProtocolActive:false,
      moveBy(){},hideCursor(){},showCursor(){},clearLine(){},clearFromCursor(){},clearScreen(){},setTitle(){},setProgress(){},setProgramStatus(){},
    };
    class NativeComponentScreen extends TuiMainScreen {
      override requestRender(){request();}
      override renderNow(){render();}
    }
    const screen=new NativeComponentScreen(terminal);
    const component=factory(screen,theme());
    views.set(key,{factory,placement,component,screen,last:'',closed:false});
    render();
  };
  const refresh=()=>{for(const view of views.values())view.screen.requestRender();};
  const stopLayout=state.onLayout(refresh);
  const stopEvents=pi.subscribe(refresh);
  return {
    setWidget(key:string,content:Factory|string[]|undefined,options?:{placement?:'aboveEditor'|'belowEditor'}){
      if(typeof content==='function')set(`widget:${key}`,content,options?.placement??'aboveEditor');
      else {remove(`widget:${key}`);state.setTextWidget(key,content,options?.placement);}
    },
    setHeader:(factory:Parameters<ExtensionUIContext['setHeader']>[0])=>set('header',factory,'header'),
    setFooter(factory:Parameters<ExtensionUIContext['setFooter']>[0]){
      remove('footer');footer?.dispose();footer=undefined;
      if(!factory||closed)return;
      const provider=new FooterDataProvider(pi.sessionManager.getCwd());footer=provider;
      for(const[key,value]of statuses)provider.setExtensionStatus(key,value);
      provider.setAvailableProviderCount(new Set(pi.modelRuntime.getAvailableSnapshot().map(model=>model.provider)).size);
      provider.onBranchChange(refresh);
      try {set('footer',(tui,theme)=>factory(tui,theme,provider),'footer');}
      catch(error){provider.dispose();footer=undefined;throw error;}
    },
    setStatus(key:string,text:string|undefined){
      if(text===undefined)statuses.delete(key);else statuses.set(key,text);
      footer?.setExtensionStatus(key,text);state.controls.setStatus(key,text);refresh();
    },
    refreshTheme(){for(const[key,view]of [...views])set(key,view.factory,view.placement);},
    reset(){for(const key of [...views.keys()])remove(key);statuses.clear();footer?.dispose();footer=undefined;},
    close(){closed=true;this.reset();stopLayout();stopEvents();},
  };
}
