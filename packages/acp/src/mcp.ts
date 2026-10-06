import {connectDefaultMcpClient} from '../node_modules/@automatalabs/pi-acp/dist/mcp-bridge.js';
import {realSleep, type PiAcpDeps} from '../node_modules/@automatalabs/pi-acp/dist/deps.js';
import {authenticatedMcpFetch, MCP_FETCH, MCP_OPTIONS, registeredMcp} from '../../../scripts/pi-mcp.mjs';
import {createMcpStatus, MCP_STATUS} from '../../../scripts/pi-mcp-status.mjs';

export const connectMcp: PiAcpDeps['connectMcpClient'] = async (server, signal, binding) => {
  const options = (server as unknown as {[MCP_OPTIONS]?: {timeoutMs:number; unresolved?:boolean}})[MCP_OPTIONS];
  if (options?.unresolved) throw new Error('MCP configuration could not be resolved.');
  const auth = authenticatedMcpFetch(server, async provider => (await binding?.modelRuntime?.getAuth(provider))?.auth.apiKey);
  Object.defineProperty(server, MCP_FETCH, {value:auth.fetch, configurable:true});
  try {
    const timeoutMs = options?.timeoutMs ?? 60_000;
    const handle = await connectDefaultMcpClient(server, signal, timeoutMs, realSleep, binding);
    const close = handle.close.bind(handle);
    handle.close = async()=>{try {await close();}finally {await auth.settled();}};
    return handle;
  } catch(error) {await auth.settled(); throw error;}
};

export function createMcpConnector(directory:string): PiAcpDeps['connectMcpClient'] {
  return Object.assign((...args:Parameters<typeof connectMcp>) => connectMcp(...args), {
    [MCP_STATUS]: createMcpStatus(directory),
    [Symbol.for('eido.pi.mcp.registered')]: (cwd:string, registrations:Parameters<typeof registeredMcp>[2]) => registeredMcp(directory, cwd, registrations),
  });
}
