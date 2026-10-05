import {randomUUID} from 'node:crypto';
import type {AgentSession} from '@earendil-works/pi-coding-agent';
import {KeybindingsManager} from '../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js';

export const PI_SHORTCUTS = Symbol.for('eido.pi.shortcuts');
export interface NativeShortcut {key:string; binding:string; description:string; generation:string}

export function nativeBinding(key:string) {
  const modifiers:string[]=[];
  let rest=key.toLowerCase();
  while (/^(ctrl|alt|shift|super)\+/.test(rest)) {
    const end=rest.indexOf('+');modifiers.push(rest.slice(0,end));rest=rest.slice(end+1);
  }
  const aliases:Record<string,string>={esc:'escape',return:'enter'};
  if(!rest || /\s/.test(rest))return undefined;
  return [...modifiers,aliases[rest]??rest].join('-');
}

/** pi resolves plugin conflicts; the native composer only routes the resulting bindings. */
export function createPiShortcuts(pi:AgentSession, directory:string, publish:(shortcuts:NativeShortcut[])=>void, report:(message:string)=>void) {
  let generation=randomUUID(),closed=false;
  let listed:NativeShortcut[]=[];
  let shortcuts:ReturnType<AgentSession['extensionRunner']['getShortcuts']>=new Map();
  const running=new Set<string>();
  const refresh=()=>{
    if(closed)return;
    generation=randomUUID();
    shortcuts=pi.extensionRunner.getShortcuts(KeybindingsManager.create(directory).getEffectiveConfig());
    listed=[...shortcuts].flatMap(([key,value])=>{
      const binding=nativeBinding(key);
      return binding?[{key,binding,description:value.description??'pi extension shortcut',generation}]:[];
    }).slice(0,256);
    publish(listed);
  };
  return {
    refresh,
    list:()=>listed,
    reset(){generation=randomUUID();shortcuts=new Map();listed=[];publish([]);},
    close(){closed=true;generation=randomUUID();shortcuts.clear();listed=[];publish([]);},
    async invoke(request:{key:string;generation:string},signal?:AbortSignal) {
      if(closed||signal?.aborted||request.generation!==generation)return {handled:false};
      const shortcut=shortcuts.get(request.key as Parameters<typeof shortcuts.get>[0]);
      if(!shortcut)return {handled:false};
      const id=`${generation}:${request.key}`;
      if(running.has(id))return {handled:true};
      running.add(id);
      try {await shortcut.handler(pi.extensionRunner.createContext());return {handled:true};}
      catch(error){report(`Extension shortcut: ${error instanceof Error?error.message:String(error)}`);return {handled:true};}
      finally {running.delete(id);}
    },
  };
}
