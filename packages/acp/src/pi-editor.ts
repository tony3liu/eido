import {randomUUID} from 'node:crypto';
import type {AgentContext} from '@agentclientprotocol/sdk';
import {matchesKey, type EditorComponent, type EditorTheme} from '@earendil-works/pi-tui';
import type {AgentSession, ExtensionUIContext, Theme} from '@earendil-works/pi-coding-agent';
import {CustomEditor} from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-editor.js';
import {showPiComponent} from './pi-component-terminal.ts';
import {nativeUiAction} from './native-ui.ts';
import type {createPiUIState} from './pi-ui-state.ts';
import type {createPiAutocomplete} from './pi-autocomplete.ts';
import type {createPiShortcuts} from './pi-shortcuts.ts';
type EditorFactory=NonNullable<Parameters<ExtensionUIContext['setEditorComponent']>[0]>;

/** A plugin editor occupies the existing composer. Its draft and submissions stay native. */
export function createPiEditor(pi:AgentSession, client:AgentContext, state:ReturnType<typeof createPiUIState>,
  theme:()=>Theme, agentDir:string, autocomplete:ReturnType<typeof createPiAutocomplete>,
  shortcuts:ReturnType<typeof createPiShortcuts>, report:(text:string)=>void) {
  type Handler=Parameters<ExtensionUIContext['onTerminalInput']>[0];
  const handlers=new Set<Handler>();
  let factory:EditorFactory|undefined, closed=false, epoch=0;
  let active:{generation:string; abort:AbortController; done:Promise<void>}|undefined;
  let component:EditorComponent|undefined;
  let render:()=>void=()=>{}, changing=false, writing=0, submitting=false;
  let settled=Promise.resolve();
  const error=(value:unknown)=>report(`Extension editor: ${value instanceof Error?value.message:String(value)}`);
  const filter=(data:string)=>{
    for(const handler of [...handlers]) {
      const result=handler(data);
      if(result?.consume)return undefined;
      if(result?.data!==undefined)data=result.data;
    }
    return data;
  };
  const text=()=>component?.getExpandedText?.()??component?.getText()??state.controls.getEditorText();
  const mirror=(value=text())=>{
    if(changing||closed)return;
    if(Buffer.byteLength(value)>1_048_576)throw new Error('Extension draft exceeds 1 MiB.');
    if(value===state.controls.getEditorText())return;
    writing++;
    state.controls.setEditorText(value);
    void state.flush().finally(()=>{writing--;});
  };
  const update=(value:string)=>{
    if(!component)return;
    changing=true;
    try {component.setText(value);render();}finally{changing=false;}
  };
  const stopEditor=state.onEditor(()=>{
    if(!writing)try {update(state.controls.getEditorText());}catch(value){error(value);active?.abort.abort();}
  });
  const editorTheme:EditorTheme={
    borderColor:value=>theme().fg('borderMuted',value),
    selectList:{selectedPrefix:value=>theme().fg('accent',value),selectedText:value=>theme().fg('accent',value),
      description:value=>theme().fg('muted',value),scrollInfo:value=>theme().fg('muted',value),noMatch:value=>theme().fg('muted',value)},
  };
  const restart=()=>{
    const selected=++epoch;
    try {if(component)mirror();}catch(value){error(value);}
    active?.abort.abort();
    settled=settled.then(async()=>{
      if(active)await active.done;
      if(closed||selected!==epoch||(!factory&&!handlers.size))return;
      const generation=randomUUID(),abort=new AbortController();
      const selectedFactory=factory;
      const run=state.whenReady(abort.signal).then(()=>showPiComponent(pi,client,theme(),agentDir,(tui,_theme,keys)=>{
        component=selectedFactory?selectedFactory(tui,editorTheme,keys):new CustomEditor(tui,editorTheme,keys);
        if(!component||typeof component.getText!=='function'||typeof component.setText!=='function'||typeof component.handleInput!=='function')throw new Error('Invalid pi editor component.');
        const editor=component;
        render=()=>tui.requestRender();
        editor.setText(state.controls.getEditorText());
        editor.setPaddingX?.(pi.settingsManager.getEditorPaddingX());
        editor.setAutocompleteMaxVisible?.(pi.settingsManager.getAutocompleteMaxVisible());
        editor.setAutocompleteProvider?.(autocomplete.provider());
        editor.onChange=()=>{if(!submitting)mirror();};
        editor.onSubmit=value=>{
          if(submitting||abort.signal.aborted||!value.trim())return;
          submitting=true;
          // Capture once; the plugin may clear its own buffer after invoking onSubmit.
          mirror(value);
          void state.flush().then(async()=>{
            if(abort.signal.aborted)return;
            const result=await nativeUiAction(client,pi.sessionId,'submit_editor',{generation,text:value},abort.signal);
            if(result.editor)state.receive(result.editor as Parameters<typeof state.receive>[0]);
            editor.addToHistory?.(value);
          }).catch(value=>{if(!abort.signal.aborted)error(value);})
            .finally(()=>{submitting=false;if(active?.generation===generation)update(state.controls.getEditorText());});
        };
        return {
          render:width=>editor.render(width),invalidate:()=>editor.invalidate(),
          get focused(){return (editor as EditorComponent&{focused?:boolean}).focused??false;},
          set focused(value:boolean){(editor as EditorComponent&{focused?:boolean}).focused=value;},
          handleInput(data:string){
            if(submitting)return;
            const shortcut=shortcuts.list().find(binding=>matchesKey(data,binding.key as Parameters<typeof matchesKey>[1]));
            if(shortcut){void shortcuts.invoke(shortcut);return;}
            editor.handleInput(data);if(!submitting)mirror();
          },
          dispose(){
            if(component===editor){component=undefined;render=()=>{};}
            (editor as EditorComponent&{dispose?():void}).dispose?.();
          },
        };
      },undefined,()=>{},abort.signal,{
        input:filter,
        async mount(terminalId){
          const result=await nativeUiAction(client,pi.sessionId,'mount_editor',{terminalId,generation},abort.signal);
          if(result.editor)state.receive(result.editor as Parameters<typeof state.receive>[0]);
        },
        async unmount(){
          try {if(!submitting)mirror();await state.flush();}
          finally {await nativeUiAction(client,pi.sessionId,'unmount_editor',{generation});}
        },
      }));
      const done=run.then(()=>{},value=>{if(!abort.signal.aborted&&!/Extension (interface cancelled|terminal closed)\./.test(String(value)))error(value);})
        .finally(()=>{
          if(active?.generation===generation){active=undefined;component=undefined;render=()=>{};}
          if(selected===epoch){factory=undefined;handlers.clear();}
        });
      active={generation,abort,done};
    }).catch(error);
  };
  const controls:Pick<ExtensionUIContext,'setEditorComponent'|'getEditorComponent'|'onTerminalInput'|'getEditorText'|'setEditorText'|'pasteToEditor'>={
    setEditorComponent(value){factory=value;restart();},
    getEditorComponent:()=>factory,
    onTerminalInput(handler){
      handlers.add(handler);if(!active)restart();
      return()=>{handlers.delete(handler);if(!handlers.size&&!factory)restart();};
    },
    getEditorText:text,
    setEditorText(value){update(value);state.controls.setEditorText(value);},
    pasteToEditor(value){
      if(!component){state.controls.pasteToEditor(value);return;}
      component.handleInput(`\x1b[200~${value}\x1b[201~`);mirror();render();
    },
  };
  return {
    controls,input:filter,
    refreshTheme(){component?.invalidate();render();},
    async reset(){factory=undefined;handlers.clear();restart();await settled;},
    close(){
      closed=true;stopEditor();handlers.clear();factory=undefined;epoch++;active?.abort.abort();
      return settled.then(async()=>{await active?.done;});
    },
  };
}
