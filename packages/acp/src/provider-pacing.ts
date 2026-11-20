import {setTimeout as sleep} from 'node:timers/promises';
import type {ModelRuntime} from '@earendil-works/pi-coding-agent';

// These pi adapters support the public request-level fetch option.
const supported = new Set(['openai-completions', 'openai-responses', 'azure-openai-responses',
  'anthropic-messages', 'mistral-conversations']);
const initialSpacing = 10_000;
const maxSpacing = 60_000;
const maxWait = 5 * 60_000;
type Cooldown = {spacing: number; next: number; generation: number};

function retryAfter(headers: Headers, now: number) {
  const milliseconds = headers.get('retry-after-ms')?.trim();
  if (milliseconds && /^\d+(?:\.\d+)?$/.test(milliseconds) && Number.isFinite(Number(milliseconds))) return Number(milliseconds);
  const value = headers.get('retry-after')?.trim();
  if (!value) return 0;
  const delay = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(delay, 0) : 0;
}

/** Keep pi's usual retries for the current turn, but pace the actual HTTP
 * attempts (including its SDK retries) together across tasks on a connection. */
export function installProviderPacing(runtime: ModelRuntime) {
  const original = runtime.streamSimple;
  const cooldowns = new Map<string, Cooldown>();
  const wrapped: ModelRuntime['streamSimple'] = function(model, context, options) {
    if (!supported.has(model.api)) return original.call(runtime, model, context, options);
    const upstream = options?.fetch ?? globalThis.fetch;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const key = JSON.stringify([model.provider, url.origin]);
      const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const signals = [options?.signal, requestSignal].filter((signal): signal is AbortSignal => !!signal);
      const signal = signals.length ? AbortSignal.any(signals) : undefined;
      const started = Date.now();
      let state: Cooldown | undefined;
      for (;;) {
        signal?.throwIfAborted();
        state = cooldowns.get(key);
        if (!state) break;
        const now = Date.now();
        if (now - state.next > 2 * maxSpacing) {
          cooldowns.delete(key);
          state = undefined;
          break;
        }
        const wait = state.next - now;
        if (wait <= 0) {
          state.next = now + state.spacing;
          break;
        }
        if (state.next - started > maxWait) {
          // Never send before a long Retry-After, or leave a turn queued forever.
          throw new Error('HTTP 429: The model provider has requested a longer cooldown.');
        }
        await sleep(wait, undefined, {signal});
      }

      const generation = state?.generation;
      const response = await upstream(input, init);
      const now = Date.now();
      if (response.status === 429 && response.headers.get('x-should-retry')?.toLowerCase() !== 'false') {
        const current = cooldowns.get(key);
        const spacing = Math.min(maxSpacing, current ? current.spacing * 2 : initialSpacing);
        cooldowns.set(key, {
          spacing, next: Math.max(current?.next ?? 0, now + Math.max(spacing, retryAfter(response.headers, now))),
          generation: (current?.generation ?? 0) + 1,
        });
      } else if (response.ok && state && cooldowns.get(key) === state && state.generation === generation) {
        // A response already in flight when a new 429 arrived must not clear it.
        state.spacing = Math.floor(state.spacing / 2);
        if (state.spacing < 1_000 && state.next <= now) cooldowns.delete(key);
      }
      return response;
    };
    return original.call(runtime, model, context, {...options, fetch});
  };
  runtime.streamSimple = wrapped;
  return () => { cooldowns.clear(); if (runtime.streamSimple === wrapped) runtime.streamSimple = original; };
}
