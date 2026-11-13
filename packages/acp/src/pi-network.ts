import {SettingsManager} from '@earendil-works/pi-coding-agent';
import {applyHttpProxySettings, configureHttpDispatcher} from '../node_modules/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js';
import {createRequire} from 'node:module';
import {normalizeHttpProxy} from '../../runtime/src/pi/http-settings.mjs';

// Resolve from pi so npm may hoist the dependency without changing the client.
const {getGlobalDispatcher} = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'))('undici') as typeof import('undici');

let configuredTimeout: number | undefined;

// Like pi CLI, apply process-wide proxy defaults before loading any sessions.
// Changes to the proxy require a restart; inherited proxy/NO_PROXY env wins.
export function initializePiNetwork(agentDir: string) {
  const settings = SettingsManager.create(agentDir, agentDir, {projectTrusted:false});
  if (settings.drainErrors().length) throw new Error('Unable to read global pi network settings.');
  const proxy = settings.getGlobalSettings().httpProxy;
  if (proxy !== undefined && proxy !== '') applyHttpProxySettings(normalizeHttpProxy(proxy));
  configureHttpDispatcher(settings.getHttpIdleTimeoutMs());
  configuredTimeout = settings.getHttpIdleTimeoutMs();
}

export function refreshPiNetwork(settings: SettingsManager) {
  const next = settings.getHttpIdleTimeoutMs();
  if (configuredTimeout === undefined || configuredTimeout === next) return;
  const previous = getGlobalDispatcher();
  configureHttpDispatcher(next);
  configuredTimeout = next;
  // Gracefully drain in-flight requests belonging to other tasks.
  void previous.close().catch(() => console.error('Unable to close a previous pi HTTP dispatcher.'));
}
