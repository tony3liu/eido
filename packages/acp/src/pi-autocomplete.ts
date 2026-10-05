import {randomUUID} from 'node:crypto';
import type {AgentSession, ExtensionUIContext} from '@earendil-works/pi-coding-agent';
import {CombinedAutocompleteProvider, fuzzyFilter, type AutocompleteItem, type AutocompleteProvider} from '@earendil-works/pi-tui';
import type {AvailableCommand} from '@agentclientprotocol/sdk';

export const PI_AUTOCOMPLETE = Symbol.for('eido.pi.autocomplete');
export type CompletionRequest = {text: string; cursor: number; force?: boolean; selection?: string};

/** Pi owns provider composition and argument callbacks; Zed owns the popup and edits. */
export function createPiAutocomplete(pi: AgentSession, catalogue: () => AvailableCommand[], report: (message: string) => void) {
  let closed = false;
  let generation = new AbortController();
  let pending: AbortController | undefined;
  let reported = '';
  let batch: {text: string; cursor: number; provider: AutocompleteProvider; prefix: string; items: Map<string, AutocompleteItem>; expires: number} | undefined;
  const failure = (error: unknown) => {
    const message = `Extension autocomplete: ${error instanceof Error ? error.message : String(error)}`;
    if (message !== reported) {reported = message; report(message);}
    return {handled: false, items: []};
  };
  const apply = new CombinedAutocompleteProvider([], pi.sessionManager.getCwd()).applyCompletion;
  const base: AutocompleteProvider = {
    async getSuggestions(lines, row, col) {
      const text = lines[row]!.slice(0, col).trimStart();
      if (/^\/\S*$/.test(text)) {
        const commands = catalogue().map(command => ({value: command.name, label: command.name, description: command.description}));
        return {items: fuzzyFilter(commands, text.slice(1), item => item.value), prefix: text};
      }
      const command = /^\/(\S+) (.*)$/.exec(text);
      if (!command) return null; // Native slash/file/mention completion remains available.
      const [, name, prefix] = command;
      let items: AutocompleteItem[] | null | undefined;
      if (name === 'thinking') items = pi.getAvailableThinkingLevels().map(value => ({value, label: value}));
      else if (name === 'model') items = (await pi.modelRuntime.getAvailable()).map(model => ({value: `${model.provider}/${model.id}`, label: model.name, description: model.provider}));
      else if (name === 'login') items = [...new Set(pi.modelRuntime.getAllModels().map(model => model.provider))].map(value => ({value, label: value}));
      else if (name === 'logout') items = (await pi.modelRuntime.listCredentials()).map(item => ({value: item.providerId, label: item.providerId}));
      else {
        const extension = pi.extensionRunner.getRegisteredCommands().find(command => command.invocationName === name);
        if (!extension?.getArgumentCompletions) return null;
        items = await extension.getArgumentCompletions(prefix!);
        return {items: items ?? [], prefix: prefix!};
      }
      return {items: fuzzyFilter(items ?? [], prefix!, item => `${item.value} ${item.label}`), prefix: prefix!};
    },
    applyCompletion: apply,
  };
  let provider = base;
  let hasProviders = false;
  const controls: Pick<ExtensionUIContext, 'addAutocompleteProvider'> = {
    addAutocompleteProvider(factory) {
      const next = factory(provider);
      if (!next || typeof next.getSuggestions !== 'function' || typeof next.applyCompletion !== 'function') throw new Error('Invalid pi autocomplete provider.');
      generation.abort(); generation = new AbortController();
      provider = next; hasProviders = true; reported = ''; batch = undefined;
    },
  };
  return {
    controls,
    async complete(request: CompletionRequest, outerSignal?: AbortSignal) {
      if (closed) return {handled: false, items: []};
      const {text, cursor} = request;
      if (typeof text !== 'string' || Buffer.byteLength(text) > 65_536 || !Number.isSafeInteger(cursor) || cursor < 0 || cursor > Buffer.byteLength(text)) throw new Error('Invalid autocomplete input.');
      const before = Buffer.from(text).subarray(0, cursor).toString('utf8');
      if (Buffer.byteLength(before) !== cursor || !text.startsWith(before)) throw new Error('Autocomplete cursor must be on a UTF-8 boundary.');
      const lines = text.split('\n'), row = before.split('\n').length - 1, col = before.split('\n').at(-1)!.length;
      if (request.selection !== undefined) {
        const selected = batch;
        batch = undefined; // Consume before invoking plugin code: one selection, once.
        const item = selected?.items.get(request.selection);
        if (outerSignal?.aborted || !selected || !item || selected.text !== text || selected.cursor !== cursor || selected.expires < Date.now()) return {handled: false, items: []};
        try {
          const result = selected.provider.applyCompletion([...lines], row, col, item, selected.prefix);
          if (!Array.isArray(result.lines) || result.lines.some(line => typeof line !== 'string' || line.includes('\n')) || !Number.isInteger(result.cursorLine) || !Number.isInteger(result.cursorCol) || result.cursorLine < 0 || result.cursorLine >= result.lines.length || result.cursorCol < 0 || result.cursorCol > result.lines[result.cursorLine]!.length) throw new Error('Invalid autocomplete edit.');
          const after = result.lines.join('\n');
          if (Buffer.byteLength(after) > 65_536) throw new Error('Autocomplete edit is too large.');
          const cursorText = [...result.lines.slice(0, result.cursorLine), result.lines[result.cursorLine]!.slice(0, result.cursorCol)].join('\n');
          if (!after.startsWith(cursorText) || (result.cursorCol > 0 && /[\uD800-\uDBFF]$/.test(cursorText))) throw new Error('Invalid autocomplete cursor.');
          return {handled: true, items: [], text: after, cursor: Buffer.byteLength(cursorText)};
        } catch (error) { return failure(error); }
      }
      pending?.abort(); pending = new AbortController(); batch = undefined;
      const activeLine = lines[row]!.slice(0, col);
      // Calls are local and never invoke a model. Preserve native file/mention fallback.
      if (!hasProviders && !/^\s*\/\S+ /.test(activeLine)) return {handled: false, items: []};
      const signal = AbortSignal.any([pending.signal, generation.signal, AbortSignal.timeout(1500), ...outerSignal ? [outerSignal] : []]);
      let onAbort!: () => void;
      const aborted = new Promise<never>((_, reject) => {onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, {once: true}); if (signal.aborted) onAbort();});
      try {
        const selected = provider;
        const suggestions = await Promise.race([selected.getSuggestions([...lines], row, col, {signal, force: request.force}), aborted]);
        signal.throwIfAborted();
        if (!suggestions) return {handled: false, items: []};
        if (!Array.isArray(suggestions.items) || typeof suggestions.prefix !== 'string') throw new Error('Invalid autocomplete suggestions.');
        const candidates = new Map<string, AutocompleteItem>();
        const items = suggestions.items.slice(0, 32).map(item => {
          if (typeof item.value !== 'string' || typeof item.label !== 'string' || (item.description !== undefined && typeof item.description !== 'string')) throw new Error('Invalid autocomplete item.');
          const id = randomUUID();
          candidates.set(id, item);
          return {id, label: item.label.slice(0, 512), description: item.description?.slice(0, 4096)};
        });
        batch = {text, cursor, provider: selected, prefix: suggestions.prefix, items: candidates, expires: Date.now() + 60_000};
        return {handled: true, items};
      } catch (error) {
        if (!signal.aborted) return failure(error);
        return {handled: false, items: []};
      } finally {signal.removeEventListener('abort', onAbort);}
    },
    reset() {generation.abort(); generation = new AbortController(); provider = base; hasProviders = false; reported = ''; batch = undefined;},
    close() {closed = true; generation.abort(); pending?.abort(); batch = undefined;},
  };
}
