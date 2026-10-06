import {createHash} from 'node:crypto';
import {readFile, writeFile, rename, rm} from 'node:fs/promises';
import {basename, join} from 'node:path';

export const MCP_STATUS = Symbol.for('eido.pi.mcp.status');
export const mcpRevision = (config, autoEnableCodemode) => createHash('sha256').update(JSON.stringify([config, autoEnableCodemode !== false])).digest('hex');
const read = path => readFile(path, 'utf8').then(JSON.parse).catch(() => undefined);

// A transient view of the existing bridge, owned by the existing runtime lease.
// No credentials, URLs, process arguments, tool output or conversation text.
export function createMcpStatus(directory) {
  const leasePath = join(directory, 'runtimes', `${process.pid}.json`);
  const path = join(directory, 'runtimes', `${process.pid}.mcp.json`);
  const lease = read(leasePath);
  const sessions = new Map();
  let queue = Promise.resolve();
  let warned = false;
  const save = () => {
    const rows = [...sessions].map(([sessionId, owner]) => ({sessionId, servers:owner.rows}));
    queue = queue.then(async () => {
      const original = await lease;
      if (!original?.id || (await read(leasePath))?.id !== original.id) return;
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({version:1, runtimeId:original.id, sessions:rows}), {mode:0o600});
        await rename(temporary, path);
      } finally {await rm(temporary, {force:true});}
    }).catch(() => {if (!warned) {warned = true; console.error('MCP status could not be saved. Connections are unaffected.');}});
    return queue;
  };
  return binding => {
    if (!binding) return;
    const owner = {rows:[]};
    sessions.set(binding.sessionId, owner);
    let closed = false;
    const close = () => {
      if (closed) return queue;
      closed = true;
      binding.sessionSignal.removeEventListener('abort', close);
      if (sessions.get(binding.sessionId) === owner) {sessions.delete(binding.sessionId); return save();}
      return queue;
    };
    binding.sessionSignal.addEventListener('abort', close, {once:true});
    if (binding.sessionSignal.aborted) close();
    return {
      publish(rows) {
        if (closed || sessions.get(binding.sessionId) !== owner) return;
        owner.rows = rows.map(({server, state, toolCount}) => {
          const options = server[Symbol.for('eido.pi.mcp.options')];
          return {name:server.name, state, toolCount, updatedAt:new Date().toISOString(),
            origin:options?.origin ?? (server.name === 'eido_browser' ? 'builtin' : 'client'),
            ...(options?.extensionPath ? {plugin:basename(options.extensionPath)} : {}),
            ...(options?.config ? {revision:mcpRevision(options.config, options.autoEnableCodemode)} : {})};
        });
        return save();
      }, close,
    };
  };
}

export async function readMcpStatus(directory, activePids) {
  const rows = [];
  for (const pid of activePids) {
    const path = join(directory, 'runtimes', String(pid));
    const [lease, snapshot] = await Promise.all([read(`${path}.json`), read(`${path}.mcp.json`)]);
    if (!lease?.id || snapshot?.version !== 1 || snapshot.runtimeId !== lease.id || !Array.isArray(snapshot.sessions)) continue;
    for (const session of snapshot.sessions) {
      if (typeof session.sessionId !== 'string' || !Array.isArray(session.servers)) continue;
      for (const server of session.servers) {
        if (typeof server.name !== 'string' || !['connecting','connected','unavailable','needs-auth','disconnected','degraded'].includes(server.state)) continue;
        rows.push({...server, sessionId:session.sessionId, runtime:pid});
      }
    }
  }
  return rows;
}
