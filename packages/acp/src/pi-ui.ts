import {createPiShortcuts, PI_SHORTCUTS} from './pi-shortcuts.ts';
import { methods, type AgentContext, type AvailableCommand, type ElicitationPropertySchema, type SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentSession, ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import {createPiUIState, PI_UI_STATE} from './pi-ui-state.ts';
import {showPiComponent} from './pi-component-terminal.ts';
import {getThemeByName, getAvailableThemesWithPaths} from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import {createPiDecorations} from './pi-decorations.ts';
import {createPiAutocomplete, PI_AUTOCOMPLETE} from './pi-autocomplete.ts';

/** Use the native ACP form surface for pi's dialog API. */
export function createPiUI(pi: AgentSession, client: AgentContext, turnSignal: () => AbortSignal | undefined, emit: (update: SessionUpdate) => void, native = false, agentDir = pi.sessionManager.getCwd(), catalogue: () => AvailableCommand[] = () => []): ExtensionUIContext {
  let lifetime = new AbortController();
  let activeComponent = false;
  const findTheme = (name:string) => pi.resourceLoader.getThemes().themes.find(theme => theme.name === name) ?? getThemeByName(name);
  let theme = findTheme(pi.settingsManager.getTheme() ?? 'dark') ?? getThemeByName('dark')!;
  const request = async (title: string, property: ElicitationPropertySchema | undefined, opts?: ExtensionUIDialogOptions) => {
    const signals = [lifetime.signal, turnSignal(), opts?.signal].filter((signal): signal is AbortSignal => !!signal);
    const timeout = new AbortController();
    const timer = opts?.timeout === undefined ? undefined : setTimeout(() => timeout.abort(), opts.timeout);
    signals.push(timeout.signal);
    const signal = AbortSignal.any(signals);
    try {
      if (signal.aborted) return undefined;
      const response = await client.request(methods.client.elicitation.create, {
        sessionId: pi.sessionId,
        mode: "form",
        message: title,
        requestedSchema: {type: "object", properties: property ? {value: property} : {}, required: property ? ["value"] : []},
      }, {cancellationSignal: signal});
      if (signal.aborted || response.action !== "accept") return undefined;
      const content = "content" in response && typeof response.content === "object" && response.content !== null ? response.content as Record<string, unknown> : {};
      return property ? content.value : true;
    } catch (error) {
      if (signal.aborted) return undefined;
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  };
  const notice = (text: string) => {
    // Display-only notices are persisted as custom data, outside model context.
    pi.sessionManager.appendCustomEntry("eido.notice.v1", {text});
    emit({
      sessionUpdate: "agent_message_chunk", content: {type: "text", text: `${text}\n\n`},
    });
  };
  const state = native ? createPiUIState(pi, client, message => notice(message), turnSignal) : undefined;
  const decorations=state?createPiDecorations(pi,state,()=>theme,notice):undefined;
  const shortcuts = state ? createPiShortcuts(pi, agentDir, state.setShortcuts, notice) : undefined;
  if(shortcuts)Object.defineProperty(pi,PI_SHORTCUTS,{value:shortcuts});
  const autocomplete = native ? createPiAutocomplete(pi, catalogue, notice) : undefined;
  if (autocomplete) Object.defineProperty(pi, PI_AUTOCOMPLETE, {value: autocomplete});
  if (state) Object.defineProperty(pi, PI_UI_STATE, {value: state});
  const dispose = pi.dispose.bind(pi);
  pi.dispose = () => {lifetime.abort(); shortcuts?.close(); autocomplete?.close(); decorations?.close();state?.close(); dispose();};
  const reload = pi.reload.bind(pi);
  pi.reload = async (...args) => {
    lifetime.abort(); lifetime = new AbortController(); shortcuts?.reset(); autocomplete?.reset(); decorations?.reset();state?.reset();
    const result = await reload(...args);
    theme = findTheme(pi.settingsManager.getTheme() ?? 'dark') ?? getThemeByName('dark')!;
    decorations?.refreshTheme();
    shortcuts?.refresh();
    return result;
  };
  return {
    ...pi.extensionRunner.createContext().ui,
    ...state?.controls,
    ...autocomplete?.controls,
    get theme() {return theme;},
    getAllThemes() {
      return [...new Map([...getAvailableThemesWithPaths(), ...pi.resourceLoader.getThemes().themes
        .filter(theme => !!theme.name).map(theme => ({name:theme.name!, path:theme.sourcePath}))].map(theme => [theme.name,theme])).values()];
    },
    getTheme: findTheme,
    setTheme(value) {
      const next = typeof value === 'string' ? findTheme(value) : value;
      if (!next) return {success:false,error:`Unknown pi theme: ${value}`};
      theme = next;
      decorations?.refreshTheme();
      return {success:true};
    },
    async custom(factory, options) {
      if (!native) throw new Error('This client does not support interactive pi components.');
      if (activeComponent) throw new Error('An extension interface is already open in this task.');
      activeComponent = true;
      try {
        return await showPiComponent(pi, client, theme, agentDir, factory, options, emit,
          AbortSignal.any([lifetime.signal, turnSignal()].filter((signal):signal is AbortSignal => !!signal)));
      } finally {activeComponent=false;}
    },
    ...(decorations ? {setWidget:decorations.setWidget,setHeader:decorations.setHeader,
      setFooter:decorations.setFooter,setStatus:decorations.setStatus} : {}),
    async select(title, options, opts) {
      if (!options.length) return undefined;
      const value = await request(title, {type: "string", title: "Choose an option", enum: options}, opts);
      return typeof value === "string" && options.includes(value) ? value : undefined;
    },
    async confirm(title, message, opts) { return await request(`${title}\n\n${message}`, undefined, opts) === true; },
    async input(title, placeholder, opts) {
      const value = await request(title, {type: "string", title: "Value", description: placeholder}, opts);
      return typeof value === "string" ? value : undefined;
    },
    async editor(title, prefill) {
      const value = await request(title, {type: "string", title: "Text", default: prefill ?? "", _meta: {eidoMultiline: true}});
      return typeof value === "string" ? value : undefined;
    },
    notify: (message, type) => notice(type && type !== "info" ? `${type}: ${message}` : message),
    setTitle: title => pi.setSessionName(title),
  };
}
