export const MCP_OPTIONS: unique symbol;
export const MCP_FETCH: unique symbol;
export function registeredMcp(directory:string, cwd:string, registrations:import('../packages/acp/node_modules/@earendil-works/pi-coding-agent/dist/core/mcp-servers.js').RegisteredMcpServer[]):Promise<import('@agentclientprotocol/sdk').McpServer[]>;
export function authenticatedMcpFetch(server: unknown, providerToken: (provider: string)=>Promise<string|undefined>, fetcher?: typeof fetch): {fetch:typeof fetch; settled:()=>Promise<void>};
export function signIn(directory:string, name:string, prompt:{showAuthorizationUrl(url:URL):void; promptForRedirectUrl(signal:AbortSignal):Promise<string|undefined>}, signal?:AbortSignal):Promise<void>;
export function credentials(directory:string): import('../packages/acp/node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/oauth.js').McpOAuthCredentialStore;
