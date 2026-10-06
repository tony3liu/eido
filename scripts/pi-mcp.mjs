import {readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {FileAuthStorageBackend} from '../packages/acp/node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js';
import {validateMcpServerConfig} from '../packages/acp/node_modules/@earendil-works/pi-coding-agent/dist/core/mcp-servers.js';
import {resolveConfigValueOrThrow, resolveHeadersOrThrow} from '../packages/acp/node_modules/@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js';
import {McpOAuthCredentialStore, createMcpAuthProvider, signInMcpServer} from '../packages/acp/node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/oauth.js';
import {parseWwwAuthenticate} from '../packages/acp/node_modules/@earendil-works/pi-mcp/dist/oauth/index.js';

export const MCP_OPTIONS = Symbol.for('eido.pi.mcp.options');
export const MCP_FETCH = Symbol.for('eido.pi.mcp.fetch');
export const credentials = directory => new McpOAuthCredentialStore(new FileAuthStorageBackend(join(directory, 'mcp-auth.json')), directory);
export const usesOAuth = server => !!server.url && !server.auth && !Object.keys(server.headers ?? {}).some(key => key.toLowerCase() === 'authorization');
const expandHome = value => value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;

export function validateMcp(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MCP configuration must contain a mcpServers object.');
  if (value.autoEnableCodemode !== undefined && typeof value.autoEnableCodemode !== 'boolean') throw new Error('autoEnableCodemode must be a boolean.');
  const raw = value.mcpServers ?? {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('mcpServers must be an object.');
  const servers = Object.create(null);
  for (const [name, input] of Object.entries(raw)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || name === 'eido_browser') throw new Error('Use a unique server name; eido_browser is reserved.');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`Invalid MCP server: ${name}.`);
    if (input.disabled !== undefined && typeof input.disabled !== 'boolean') throw new Error(`Invalid disabled flag for ${name}.`);
    if (!!input.command === !!input.url) throw new Error(`Choose a command or HTTP URL for ${name}.`);
    if (input.command && (!input.command.trim?.() || input.type !== undefined && input.type !== 'stdio') || input.url && input.type !== undefined && !['http','sse','streamable-http'].includes(input.type)) throw new Error(`Invalid transport for ${name}.`);
    if (input.url) {
      const url = URL.canParse(input.url) ? new URL(input.url) : undefined;
      if (!url || !['http:','https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error(`Invalid URL for ${name}.`);
    }
    // pi owns field validation. Preserve legacy SSE through the existing ACP transport.
    const config = validateMcpServerConfig(name, {...input, ...(input.type === 'sse' || input.type === 'streamable-http' ? {type:'http'} : {})});
    if (typeof config === 'string') throw new Error(config);
    // Migrate Eido's old flag to pi's enabled flag. An explicit pi flag wins.
    if (config.enabled === undefined && input.disabled !== undefined) config.enabled = !input.disabled;
    delete config.disabled;
    if (input.type === 'sse') config.type = 'sse';
    servers[name] = config;
  }
  return {...value, mcpServers: servers};
}

export async function readMcp(directory) {
  let text;
  try {text = await readFile(join(directory,'mcp.json'),'utf8');}
  catch (error) {if (error.code === 'ENOENT') return {mcpServers:{}}; throw error;}
  let value;
  try {value = JSON.parse(text);} catch {throw new Error('Invalid mcp.json. It was not changed.');}
  return validateMcp(value);
}

export async function configuredMcp(directory, cwd = directory) {
  return resolveMcp(await readMcp(directory), directory, cwd);
}

export async function registeredMcp(directory, cwd, registrations) {
  const global = await readMcp(directory);
  const entries = Object.create(null);
  for (const {name, config} of registrations) {
    if (name === 'eido_browser' || Object.hasOwn(global.mcpServers, name)) continue;
    const validated = validateMcpServerConfig(name, config);
    if (typeof validated === 'string') throw new Error('Invalid registered MCP server.');
    entries[name] = validated;
  }
  // Global entries, including disabled ones, take precedence over plugins.
  return resolveMcp({...global, mcpServers:{...entries,...global.mcpServers}}, directory, cwd,
    new Map(registrations.filter(({name}) => !Object.hasOwn(global.mcpServers, name)).map(({name, extensionPath}) => [name, extensionPath])));
}

function resolveMcp(config, directory, cwd, plugins = new Map()) {
  return Object.entries(config.mcpServers).filter(([, s]) => s.enabled !== false).map(([name, s]) => {
    const description = `MCP server "${name}"`;
    let unresolved = false;
    let server;
    try {server = s.command
      ? {name, command: expandHome(s.command), args: (s.args ?? []).map(expandHome), env: Object.entries(s.env ?? {}).map(([name,value]) => ({name,value:resolveConfigValueOrThrow(value, `${description} environment`)}))}
      : {name, type: s.type ?? 'http', url: s.url, headers: Object.entries(resolveHeadersOrThrow(s.headers, description) ?? {}).map(([name,value]) => ({name,value}))};
    } catch {
      // Keep configuration errors scoped to this server. No unresolved values
      // are forwarded to a process or included in a user-facing diagnostic.
      unresolved = true;
      server = s.command ? {name, command:s.command, args:[], env:[]} : {name, type:s.type ?? 'http', url:s.url, headers:[]};
    }
    Object.defineProperty(server, MCP_OPTIONS, {value:{config:s, directory, unresolved, origin:plugins.has(name) ? 'plugin' : 'global', extensionPath:plugins.get(name), autoEnableCodemode:config.autoEnableCodemode, timeoutMs:Math.min((s.timeout ?? 60) * 1000, 2_147_483_647), cwd:resolve(cwd,expandHome(s.cwd ?? '.'))}});
    return server;
  });
}

export function oauthSettings(config) {
  const {clientSecret, authServerMetadataUrl, ...rest} = config.oauth ?? {};
  return {...rest, ...(clientSecret !== undefined ? {clientSecret:resolveConfigValueOrThrow(clientSecret,'MCP OAuth client secret')} : {}),
    ...(authServerMetadataUrl ? {authServerMetadataUrl:new URL(authServerMetadataUrl)} : {})};
}

/** Only this fetch lane changes; ACP retains tool permissions and connection ownership. */
export function authenticatedMcpFetch(server, providerToken, fetcher = fetch) {
  const options = server[MCP_OPTIONS];
  if (!options || !server.url) return {fetch:fetcher, settled:async()=>{}};
  const {config,directory} = options;
  const provider = usesOAuth(config) ? createMcpAuthProvider({serverUrl:server.url, store:credentials(directory).forServer(server.name,server.url), settings:()=>oauthSettings(config), onChallenge:()=>{}})
    : config.auth ? {token:()=>providerToken(config.auth.provider), settled:async()=>{}} : undefined;
  const baseUrl = new URL(server.url);
  const authorized = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input, baseUrl);
    // SSE endpoint messages must not send configured credentials to another origin.
    if (url.origin !== baseUrl.origin) throw new Error('MCP endpoint changed origin.');
    for (let attempt=0; ; attempt++) {
      init?.signal?.throwIfAborted();
      const token = await provider?.token();
      const headers = new Headers(init?.headers);
      if (token) headers.set('Authorization', `Bearer ${token}`);
      const response = await fetcher(input,{...init,headers,redirect:'error'});
      const unauthorized = response.status === 401 || response.status === 403 && parseWwwAuthenticate(response.headers.get('www-authenticate')).error === 'insufficient_scope';
      if (!unauthorized) {server[Symbol.for('eido.pi.mcp.needs-auth')] = false; return response;}
      server[Symbol.for('eido.pi.mcp.needs-auth')] = true;
      if (attempt || !provider?.onUnauthorized) return response;
      try {await provider.onUnauthorized({response,serverUrl:baseUrl,fetch:fetcher,token});}
      finally {await response.body?.cancel().catch(()=>{});}
    }
  };
  return {fetch:authorized, settled:()=>provider?.settled() ?? Promise.resolve()};
}

export async function signIn(directory, name, prompt, signal) {
  const server = (await readMcp(directory)).mcpServers[name];
  if (!server || !usesOAuth(server)) throw new Error('Choose an MCP server that uses account sign-in.');
  const store = credentials(directory).forServer(name,server.url);
  signal?.throwIfAborted();
  await store.withRefreshLock(async()=> {
    signal?.throwIfAborted();
    // Refuse late credential writes after cancellation or a changed/removed server.
    const checkedStore = {load:()=>store.load(), save:async state=> {
      signal?.throwIfAborted();
      const current = (await readMcp(directory)).mcpServers[name];
      if (JSON.stringify(current) !== JSON.stringify(server)) throw new Error('MCP configuration changed during sign-in.');
      return store.save(state);
    }};
    await signInMcpServer({serverUrl:server.url,store:checkedStore,settings:oauthSettings(server),prompt});
    signal?.throwIfAborted();
  });
}
