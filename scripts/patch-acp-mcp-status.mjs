import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';

export async function patchMcpStatus(path) {
  let source = await readFile(path, 'utf8');
  const marker = '// Eido MCP runtime status v1';
  if (source.includes(marker)) return;
  if (createHash('sha256').update(source).digest('hex') !== 'b119b19e8f01995b320b6a18db1af7c2a985b546f19cab270aa7bf2c126d964e') {
    throw new Error('Review the MCP bridge before exposing runtime status.');
  }
  const replace = (before, after, count = 1) => {
    if (source.split(before).length !== count + 1) throw new Error(`Unexpected MCP status source: ${before.slice(0, 100)}`);
    source = source.replaceAll(before, after);
  };
  replace('    const pendingDiagnostics = [];', `    const pendingDiagnostics = [];
${marker}
    const statusSink = deps.connectMcpClient[Symbol.for("eido.pi.mcp.status")]?.(binding);
    const statusRows = new Map();
    const publishStatus = () => statusSink?.publish([...statusRows.values()]);
    const reportStatus = (server, state, toolCount = 0) => {
        statusRows.set(server.name, {server, state, toolCount});
        publishStatus();
    };`);
  replace('        if (!diagnose) return;', `        reportStatus(server, server[Symbol.for("eido.pi.mcp.needs-auth")] ? "needs-auth" : "unavailable");
        if (!diagnose) return;`);
  replace('            const token = allocateServerToken(server.name);', '            reportStatus(server, "connecting");\n            const token = allocateServerToken(server.name);');
  replace('                    state.peerDead = true;', '                    state.peerDead = true;\n                    reportStatus(server, "disconnected");');
  replace('        poisoned = true;\n        closing = true;', '        poisoned = true;\n        closing = true;\n        void statusSink?.close();');
  replace('            state.pages = candidate.pages;', '            state.pages = candidate.pages;\n            reportStatus(state.server, "connected", candidate.tools.length);');
  replace('            if (!closing && !refreshPaused && !state.peerDead && !state.disabled)\n                binding?.emitDiagnostic', '            if (!closing && !refreshPaused && !state.peerDead && !state.disabled) {\n                reportStatus(state.server, "degraded", state.tools.length);\n            }\n            if (!closing && !refreshPaused && !state.peerDead && !state.disabled)\n                binding?.emitDiagnostic');
  replace('                    tools.push(remoteDefinition(state, remote, alias));\n                }', '                    tools.push(remoteDefinition(state, remote, alias));\n                }\n                reportStatus(state.server, "connected", state.tools.length);');
  replace('    await connectServers(servers, openSignal);', '    try {await connectServers(servers, openSignal);}\n    catch (error) {await statusSink?.close(); throw error;}');
  replace('options?.cwd, options?.unresolved]);', 'options?.cwd, options?.unresolved, options?.origin, options?.extensionPath]);');
  replace('        const wanted = new Map(next.map(server => [server.name, fingerprint(server)]));', `        const wanted = new Map(next.map(server => [server.name, fingerprint(server)]));
        for (const name of statusRows.keys()) if (!wanted.has(name) && !fixedNames.has(name)) statusRows.delete(name);
        publishStatus();`);
  replace('    const startDisposal = () => {', '    const startDisposal = () => {\n        void statusSink?.close();');
  replace('                await physicalCloses;', '                await physicalCloses;\n                await statusSink?.close();');
  await writeFile(path, source);
}
