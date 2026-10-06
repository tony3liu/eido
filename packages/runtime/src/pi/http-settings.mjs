import { createHash } from 'node:crypto';

export class PiHttpSettingsError extends Error {}

export function normalizeHttpProxy(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) {
    throw new PiHttpSettingsError('Enter an HTTP(S) proxy URL. Use Remove Proxy to restore environment defaults.');
  }
  const text = value.trim();
  let url;
  try { url = new URL(text); } catch { /* Never return a URL parser error containing credentials. */ }
  if (!url || !['http:', 'https:'].includes(url.protocol) || !url.hostname
    || (url.pathname !== '' && url.pathname !== '/') || url.search || url.hash || /[\s\\]/.test(text)) {
    throw new PiHttpSettingsError('Use an HTTP(S) proxy URL with a host and optional port and credentials, without a path, query or fragment.');
  }
  return text;
}

// Return only state and an opaque compare-and-swap token, never stored credentials.
export function httpProxyStatus(settings) {
  const value = settings.httpProxy ?? null;
  return { configured: value !== null && value !== '',
    revision: createHash('sha256').update(JSON.stringify(value)).digest('hex') };
}

export function mergeHttpProxy(settings, proxy, expected) {
  if (typeof expected !== 'string' || expected !== httpProxyStatus(settings).revision) {
    throw new PiHttpSettingsError('HTTP proxy changed while this page was open. Reload before saving.');
  }
  const result = structuredClone(settings);
  if (proxy === null) delete result.httpProxy;
  else result.httpProxy = normalizeHttpProxy(proxy);
  return result;
}
