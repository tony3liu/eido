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
  let markReady!: () => void;
  const nativeReady = new Promise<void>(resolve => {markReady = resolve;});
  let toolsExpanded = false;
  const state = {
    statuses: {} as Record<string, string>,
    widgets: {} as Record<string, {lines: string[]; placement: 'aboveEditor' | 'belowEditor'}>,
    workingMessage: null as string | null,
    workingVisible: true,
    workingIndicator: null as {frames?: string[]; intervalMs?: number} | null,
    hiddenThinkingLabel: null as string | null,
  };
  const plain = (text: string) => stripVTControlCharacters(text);
  const sync = (value: EditorState) => {
    if (value.instance !== editor.instance || value.revision >= editor.revision) editor = value;
  };
  const send = (action: string, data: Record<string, unknown>) => {
    pending = pending.then(async () => {
      if (!ready && !closed) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {await Promise.race([nativeReady, new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Native editor did not become ready.')), 15_000);
        })]);} finally {if (timer) clearTimeout(timer);}
      }
      if (closed) return;
      const signal = turnSignal();
      if (signal?.aborted) return;
      const result = await nativeUiAction(client, pi.sessionId, action, data, signal);
      if (result.editor) sync(result.editor as EditorState);
    }).catch(error => {if (!closed && !turnSignal()?.aborted) reportError(`Extension UI: ${error instanceof Error ? error.message : String(error)}`);});
  };
  const publish = () => {if (ready) send('extension_state', structuredClone(state));};
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
    receive(value: EditorState & {toolsExpanded?: boolean}) {
      sync(value);
      if (typeof value.toolsExpanded === 'boolean') toolsExpanded = value.toolsExpanded;
      if (!ready) {ready = true; markReady(); publish();}
    },
    setTextWidget(key: string, lines: string[] | undefined, placement: 'aboveEditor' | 'belowEditor' = 'aboveEditor') {
      if (lines === undefined) delete state.widgets[key];
      else state.widgets[key] = {lines: lines.map(plain), placement};
      publish();
    },
    flush: () => pending,
    reset() {
      state.statuses = {}; state.widgets = {}; state.workingMessage = null; state.workingVisible = true;
      state.workingIndicator = null; state.hiddenThinkingLabel = null; publish();
    },
    close() {closed = true; markReady();},
  };
}
