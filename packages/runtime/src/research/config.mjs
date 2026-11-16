import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

export class ResearchError extends Error {
  constructor(code, message) { super(message); this.name = 'ResearchError'; this.code = code; }
}
export const researchProvider = 'deepseek';
export const researchLimitFields = Object.freeze([
  ['attempts24h', 'Requests per 24 hours', 100, 1, 100000],
  ['uploadBytes24h', 'Upload bytes per 24 hours', 104857600, 1, 107374182400],
  ['ocrPages24h', 'OCR pages per 24 hours', 100, 1, 100000],
  ['attemptsPerTurn', 'Requests per turn', 12, 1, 1000],
  ['httpConcurrency', 'Concurrent requests', 2, 1, 16],
  ['ocrConcurrency', 'Concurrent OCR requests', 1, 1, 4],
  ['fileBytes', 'Original file bytes', 20971520, 1, 20971520],
  ['pageBytes', 'Rendered page bytes', 20971520, 1, 20971520],
  ['pdfPages', 'PDF pages per file', 50, 1, 50],
  ['responseBytes', 'Response bytes', 8388608, 1024, 8388608],
  ['modelTextBytes', 'Text bytes per tool result', 32768, 1024, 32768],
  ['searchTimeoutMs', 'Search and Fetch deadline (ms)', 30000, 1000, 30000],
  ['ocrTimeoutMs', 'OCR page deadline (ms)', 180000, 1000, 180000],
]);
export const defaultResearchLimits = Object.freeze(Object.fromEntries(researchLimitFields.map(([name,,value]) => [name,value])));
export function normalizeResearchUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new ResearchError('invalid_config', 'Enter a valid service base URL.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !url.hostname ||
      !(url.protocol === 'https:' || (local && url.protocol === 'http:'))) {
    throw new ResearchError('invalid_config', 'Use HTTPS without credentials, query or fragment. HTTP is allowed only for a local loopback service.');
  }
  return url.href.replace(/\/+$/, '');
}
export function researchConfig(settings = {}) {
  const stored = settings.eido?.research;
  if (stored !== undefined && (!stored || stored.schemaVersion !== 1)) throw new ResearchError('unsupported_schema', 'Unsupported Research settings. Existing data was not changed.');
  const config = {schemaVersion:1, enabled:false, baseUrl:'https://api.deepseek.com/v1', revision:0, ...stored,
    limits:{...defaultResearchLimits, ...stored?.limits}};
  if (typeof config.enabled !== 'boolean' || !Number.isSafeInteger(config.revision) || config.revision < 0) throw new ResearchError('invalid_config', 'Invalid Research configuration. Repair settings before saving.');
  config.baseUrl = normalizeResearchUrl(config.baseUrl);
  for (const [name,label,,min,max] of researchLimitFields) {
    const value = config.limits[name];
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new ResearchError('invalid_config', `${label} must be an integer from ${min} to ${max}.`);
  }
  for (const name of Object.keys(config.limits)) if (!(name in defaultResearchLimits)) throw new ResearchError('invalid_config', 'Unknown Research limit.');
  return config;
}
export function mergeResearchConfig(settings, changes, expectedRevision) {
  const current = researchConfig(settings);
  if (expectedRevision !== current.revision) throw new ResearchError('conflict', 'Research configuration changed. Reload before saving.');
  if (!changes || Object.keys(changes).some(key => !['enabled','baseUrl','limits'].includes(key))) throw new ResearchError('invalid_config', 'Unsupported Research configuration field.');
  const next = researchConfig({eido:{research:{...current, ...changes, limits:{...current.limits,...changes.limits}, revision:current.revision+1}}});
  return {...settings,eido:{...settings.eido,research:next}};
}
export async function readResearchConfig(directory) {
  let raw;
  try { raw = await readFile(join(directory,'settings.json'),'utf8'); }
  catch(error) { if(error.code === 'ENOENT') return researchConfig(); throw error; }
  try { return researchConfig(JSON.parse(raw)); }
  catch(error) { if(error instanceof ResearchError) throw error; throw new ResearchError('invalid_config','Unable to read Research settings. Existing data was not changed.'); }
}
export async function resolveResearchAuth(modelRuntime, signal) {
  if (!modelRuntime?.getAuth) throw new ResearchError('not_configured', 'Configure the DeepSeek credential in global Research & Documents settings.');
  let resolved;
  try { resolved = await modelRuntime.getAuth(researchProvider, {signal}); }
  catch { throw new ResearchError('authentication_failed', 'DeepSeek authentication could not be resolved. Check the credential in global settings.'); }
  const key = resolved?.auth?.apiKey;
  if (typeof key !== 'string' || !key || /[\r\n]/.test(key)) throw new ResearchError('not_configured', 'DeepSeek authentication did not provide an API key. Check the credential in global settings.');
  return key;
}
export async function researchSettings(directory, modelRuntime) {
  const config = await readResearchConfig(directory);
  const configured = modelRuntime.getProviderAuthStatus(researchProvider).configured;
  let checks = {};
  try { checks = JSON.parse(await readFile(join(directory,'research/v1/checks.json'),'utf8')); }
  catch(error) { if(error.code !== 'ENOENT') checks = {}; }
  const current = checks.revision === config.revision ? checks : {};
  return {...config, credential:configured?'configured':'none',
    status:!config.enabled?'Disabled':!configured?'Not configured':current.status??'Configured · Not checked',
    lastCheckedAt:current.lastCheckedAt??null, capabilities:current.capabilities??{},
    limitFields:researchLimitFields.map(([name,label,,min,max])=>({name,label,min,max})),
    toolsMessage:config.enabled?'Research tools respect task tool defaults and Agent Access.':'Enable Research to make its tools available to new tasks.'};
}
