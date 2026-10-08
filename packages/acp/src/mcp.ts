import {connectDefaultMcpClient} from '../adapter/src/mcp-bridge.js';
import {realSleep, type PiAcpDeps} from '../adapter/src/deps.js';
import {authenticatedMcpFetch, MCP_FETCH, MCP_OPTIONS, registeredMcp} from '../../runtime/src/mcp/config.mjs';
import {createMcpStatus, MCP_STATUS} from '../../runtime/src/mcp/status.mjs';
import {computerUse} from './computer-use.ts';

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

export function createMcpConnector(directory:string) {
  const computers = new Map<string, Set<ReturnType<typeof computerUse>>>();
  return Object.assign(async (...args:Parameters<typeof connectMcp>) => {
    const handle = await connectMcp(...args), [server, , binding] = args;
    if (server.name !== 'eido_computer' || !binding) return handle;
    const computer = computerUse(handle, binding), sessions = computers.get(binding.sessionId) ?? new Set();
    sessions.add(computer); computers.set(binding.sessionId, sessions);
    const close = handle.close.bind(handle);
    handle.close = async () => {try {await close();} finally {sessions.delete(computer); if (!sessions.size) computers.delete(binding.sessionId);}};
    return handle;
  }, {
    finishTurn: async (sessionId: string) => {
      const results = await Promise.allSettled([...(computers.get(sessionId) ?? [])].map(computer => computer.finishTurn()));
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    },
    [MCP_STATUS]: createMcpStatus(directory),
    [Symbol.for('eido.pi.mcp.registered')]: (cwd:string, registrations:Parameters<typeof registeredMcp>[2]) => registeredMcp(directory, cwd, registrations),
  });
}
