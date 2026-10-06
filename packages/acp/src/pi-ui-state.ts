import type {NativeShortcut} from './pi-shortcuts.ts';
import {stripVTControlCharacters} from 'node:util';
import type {AgentContext} from '@agentclientprotocol/sdk';
import type {AgentSession, ExtensionUIContext} from '@earendil-works/pi-coding-agent';
import {nativeUiAction} from './native-ui.ts';

export const PI_UI_STATE = Symbol.for('eido.pi.ui.state');
export interface EditorState {instance: string; revision: number; text: string}

/** The native editor remains the source of truth; synchronous pi getters use its live mirror. */
export function createPiUIState(pi: AgentSession, client: AgentContext, reportError: (message: string) => void,
  turnSignal: () => AbortSignal | undefined) {
  let editor: EditorState = {instance: '', revision: -1, text: ''};
  let ready = false;
  let pending = Promise.resolve();
  let closed = false;
  let queuedState = false;
  let latestState: Record<string,unknown> = {};
  let markReady!: () => void;
  const nativeReady = new Promise<void>(resolve => {markReady = resolve;});
  let toolsExpanded = false;
  let columns=80;
  let appearance:'light'|'dark'='dark';
  const appearanceListeners=new Set<()=>void>();
  const layoutListeners=new Set<()=>void>();
  const editorListeners=new Set<()=>void>();
  const state = {
    statuses: {} as Record<string, string>,
    shortcuts: [] as NativeShortcut[],
    widgets: {} as Record<string, {lines: string[]; placement: 'aboveEditor' | 'belowEditor'; component?:boolean}>,
    header:null as string[]|null,
    footer:null as string[]|null,
    workingMessage: null as string | null,
    workingVisible: true,
    workingIndicator: null as {frames?: string[]; intervalMs?: number} | null,
    hiddenThinkingLabel: null as string | null,
  };
  const plain = (text: string) => stripVTControlCharacters(text);
  const sync = (value: EditorState) => {
    if (value.instance !== editor.instance || value.revision >= editor.revision) {
      const changed=value.text!==editor.text;
      editor = value;
      if(changed)for(const listener of editorListeners)listener();
    }
  };
  const send = (action: string, data: Record<string, unknown> | (()=>Record<string,unknown>)) => {
    pending = pending.then(async () => {
      const payload=typeof data==='function'?data():data;
      if (!ready && !closed) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {await Promise.race([nativeReady, new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Native editor did not become ready.')), 15_000);
        })]);} finally {if (timer) clearTimeout(timer);}
      }
      if (closed) return;
      const signal = turnSignal();
      if (signal?.aborted) return;
      const result = await nativeUiAction(client, pi.sessionId, action, payload, signal);
      if (result.editor) sync(result.editor as EditorState);
    }).catch(error => {if (!closed && !turnSignal()?.aborted) reportError(`Extension UI: ${error instanceof Error ? error.message : String(error)}`);});
  };
  const publish = () => {
    if(!ready||closed)return;
    latestState=structuredClone(state);
    if(queuedState)return;
    queuedState=true;
    send('extension_state',()=>{queuedState=false;return latestState;});
  };
  const controls: Pick<ExtensionUIContext, 'setStatus' | 'setWorkingMessage' | 'setWorkingVisible' | 'setWorkingIndicator' |
    'setHiddenThinkingLabel' | 'getEditorText' | 'setEditorText' | 'pasteToEditor' | 'getToolsExpanded' | 'setToolsExpanded'> = {
    setStatus(key, text) {if (text === undefined) delete state.statuses[key]; else state.statuses[key] = plain(text); publish();},
    setWorkingMessage(message) {state.workingMessage = message === undefined ? null : plain(message); publish();},
    setWorkingVisible(visible) {state.workingVisible = visible; publish();},
    setWorkingIndicator(options) {state.workingIndicator = options ? {...options, frames: options.frames?.map(plain)} : null; publish();},
    setHiddenThinkingLabel(label) {state.hiddenThinkingLabel = label === undefined ? null : plain(label); publish();},
    getEditorText: () => editor.text,
    setEditorText(text) {editor = {...editor, text}; send('set_editor', {text});},
    pasteToEditor(text) {send('paste_editor', {text});},
    getToolsExpanded: () => toolsExpanded,
    setToolsExpanded(expanded) {toolsExpanded = expanded; send('expand_tools', {expanded});},
  };
  return {
    controls,
    async whenReady(signal:AbortSignal){
      signal.throwIfAborted();
      if(ready)return;
      let abort!:()=>void;
      let timer:ReturnType<typeof setTimeout>|undefined;
      try {await Promise.race([nativeReady,new Promise<void>((_,reject)=>{
        abort=()=>reject(new Error('Extension interface cancelled.'));
        signal.addEventListener('abort',abort,{once:true});
        timer=setTimeout(()=>reject(new Error('Native editor did not become ready.')),15_000);
      })]);}finally{signal.removeEventListener('abort',abort);clearTimeout(timer);}
      signal.throwIfAborted();
    },
    onEditor(listener:()=>void){editorListeners.add(listener);return()=>{editorListeners.delete(listener);};},
    setShortcuts(shortcuts:NativeShortcut[]){state.shortcuts=shortcuts;publish();},
    columns:()=>columns,
    appearance:()=>appearance,
    onAppearance(listener:()=>void){appearanceListeners.add(listener);return()=>{appearanceListeners.delete(listener);};},
    onLayout(listener:()=>void){layoutListeners.add(listener);return()=>{layoutListeners.delete(listener);};},
    receive(value: EditorState & {toolsExpanded?: boolean; columns?:number; appearance?:'light'|'dark'}) {
      sync(value);
      if((value.appearance==='light'||value.appearance==='dark')&&value.appearance!==appearance){
        appearance=value.appearance;for(const listener of appearanceListeners)listener();
      }
      if(Number.isInteger(value.columns)&&value.columns!>=10&&value.columns!<=1000&&columns!==value.columns){
        columns=value.columns!;for(const listener of layoutListeners)listener();
      }
      if (typeof value.toolsExpanded === 'boolean') toolsExpanded = value.toolsExpanded;
      if (!ready) {ready = true; markReady(); publish();}
    },
    setTextWidget(key: string, lines: string[] | undefined, placement: 'aboveEditor' | 'belowEditor' = 'aboveEditor') {
      if (lines === undefined) delete state.widgets[key];
      else state.widgets[key] = {lines: lines.map(plain), placement};
      publish();
    },
    setComponentWidget(key:string,lines:string[]|undefined,placement:'aboveEditor'|'belowEditor'){
      if(lines===undefined)delete state.widgets[key];else state.widgets[key]={lines,placement,component:true};publish();
    },
    setDecoration(placement:'header'|'footer',lines:string[]|undefined){state[placement]=lines??null;publish();},
    flush: () => pending,
    reset() {
      state.shortcuts = []; state.statuses = {}; state.widgets = {}; state.header=null;state.footer=null; state.workingMessage = null; state.workingVisible = true;
      state.workingIndicator = null; state.hiddenThinkingLabel = null; publish();
    },
    close() {closed = true; markReady();},
  };
}
