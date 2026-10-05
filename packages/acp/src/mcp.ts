import {connectDefaultMcpClient} from '../node_modules/@automatalabs/pi-acp/dist/mcp-bridge.js';
import {realSleep, type PiAcpDeps} from '../node_modules/@automatalabs/pi-acp/dist/deps.js';
import {authenticatedMcpFetch, MCP_FETCH} from '../../../scripts/pi-mcp.mjs';

export const connectMcp: PiAcpDeps['connectMcpClient'] = async (server, signal, binding) => {
  const auth = authenticatedMcpFetch(server, async provider => (await binding?.modelRuntime?.getAuth(provider))?.auth.apiKey);
  Object.defineProperty(server, MCP_FETCH, {value:auth.fetch, configurable:true});
  try {
    const handle = await connectDefaultMcpClient(server, signal, 60_000, realSleep, binding);
    const close = handle.close.bind(handle);
    handle.close = async()=>{try {await close();}finally {await auth.settled();}};
    return handle;
  } catch(error) {await auth.settled(); throw error;}
};
