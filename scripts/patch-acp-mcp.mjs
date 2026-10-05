import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';

// Keep ACP's transport ownership, cancellation arbiter and turn boundary. These
// targeted changes adapt its 0.9.4 bridge to pi's per-server configuration.
export async function patchMcpBridge(path) {
  let source = await readFile(path, 'utf8');
  const marker = '// Eido MCP configuration v1\n';
  if (source.startsWith(marker)) return;
  if (createHash('sha256').update(source).digest('hex') !== '98caa52125fd79286f80c6ec8452dccdc063b6dade46fe8b2e93203ff561c06f') {
    throw new Error('Review the pi-acp MCP bridge before applying Eido configuration support.');
  }
  const replace = (before, after, count = 1) => {
    if (source.split(before).length !== count + 1) throw new Error(`Unexpected MCP bridge source: ${before.slice(0, 100)}`);
    source = source.replaceAll(before, after);
  };
  const section = (from, to, edit) => {
    const start = source.indexOf(from), end = source.indexOf(to, start);
    if (start < 0 || end < 0) throw new Error('Missing MCP bridge section.');
    source = source.slice(0, start) + edit(source.slice(start, end)) + source.slice(end);
  };

  // Refresh the deadline only for progress observed before it expires. Keep the
  // original deterministic terminal precedence and cancel superseded timers.
  replace('        const timer = new AbortController();\n        let settled = false;', '        let timer = new AbortController();\n        let settled = false;');
  replace('        const expiry = sleep(timeoutMs, timer.signal).then(() => { timedOut = true; claim(); }, () => undefined);\n        expiry.catch(() => undefined);', `        const resetTimeout = () => {
            if (settled || timedOut) return;
            timer.abort();
            const current = timer = new AbortController();
            sleep(timeoutMs, current.signal).then(() => {
                if (timer === current && !settled) { timedOut = true; claim(); }
            }, () => undefined);
        };
        resetTimeout();`);
  replace('            return operation(requestSignal);', '            return operation(requestSignal, resetTimeout);');
  replace('        timeout: requestTimeout,', '        timeout: requestTimeout,\n        resetTimeoutOnProgress: true,');
  replace('async listTools(cursor, requestSignal, requestTimeout) {\n            const raw = await client.listTools(cursor ? { cursor } : undefined, options(requestSignal, requestTimeout));', 'async listTools(cursor, requestSignal, requestTimeout, onprogress) {\n            const raw = await client.listTools(cursor ? { cursor } : undefined, options(requestSignal, requestTimeout, onprogress));');
  replace('        const page = await bounded(request(cursor, {', '        const page = await settleMcpOperation((requestSignal, resetTimeout) => request(cursor, {');
  section('async function pageAll(', 'function syntheticTool(', part => part
    .replace('            signal,', '            signal: requestSignal,\n            resetTimeoutOnProgress: true,')
    .replace('...(onUpdate ? { onprogress: (value) => {', '...{ onprogress: (value) => {\n                    resetTimeout();')
    .replace('                    onUpdate({', '                    onUpdate?.({')
    .replace('                } } : {}),', '                } },')
    .replace('}), signal, deps.mcpTimeoutMs, deps.sleep);', '}), signal, undefined, undefined, deps.mcpTimeoutMs, deps.sleep);'));

  replace('    const assertReady = () => {\n        const dead = states.find((state) => state.peerDead || state.handle.getPeerSignal?.().aborted);\n        if (dead)\n            throw adapterError("mcp_init_error", { server: dead.server.name });\n    };', `    const pendingDiagnostics = [];
    const assertReady = () => {
        if (closing || poisoned) throw adapterError("mcp_init_error", { server: "closed" });
    };
    const skipServer = async (server, state, handle) => {
        if (state) {
            state.disabled = true;
            state.dirty = false;
            states.splice(states.indexOf(state), 1);
            for (const alias of state.validAliases) {
                const index = tools.findIndex(tool => tool.name === alias);
                if (index >= 0) tools.splice(index, 1);
                const reserved = aliases.indexOf(alias);
                if (reserved >= 0) aliases.splice(reserved, 1);
                aliasServers.delete(alias);
            }
            state.validAliases.clear();
        }
        if (handle) await closeClients([handle], deps);
        const reason = server[Symbol.for("eido.pi.mcp.needs-auth")]
            ? "sign-in required. Open Extensions > MCP to sign in, then start or reload a task."
            : "unavailable. Check its configuration in Extensions > MCP, then start or reload a task.";
        pendingDiagnostics.push('[mcp:' + safeToken(server.name) + '] ' + reason + ' Other tools remain available.\\n');
    };`);
  replace('    const requestOptions = (signal, onprogress) => ({\n        signal,\n        timeout: deps.mcpTimeoutMs,', '    const requestOptions = (state, signal, onprogress) => ({\n        signal,\n        timeout: state.timeoutMs,\n        resetTimeoutOnProgress: true,');
  section('    const makeSynthetic =', '    const enumerate =', part => part
    .replaceAll('deps.mcpTimeoutMs', 'state.timeoutMs')
    .replaceAll('requestOptions(requestSignal,', 'requestOptions(state, requestSignal,')
    .replaceAll('requestSignal, deps,', 'requestSignal, { ...deps, mcpTimeoutMs: state.timeoutMs },')
    .replace('(requestSignal) => operation(requestSignal, guardedUpdate)', '(requestSignal, resetTimeout) => operation(requestSignal, (update) => { resetTimeout(); guardedUpdate(update); })')
    .replace('(requestSignal) => state.handle.callTool(', '(requestSignal, resetTimeout) => state.handle.callTool(')
    .replace('                    const progressValue = value;', '                    resetTimeout();\n                    const progressValue = value;'));
  section('    const enumerate =', '    const poison =', part => part
    .replaceAll('deps.mcpTimeoutMs', 'state.timeoutMs')
    .replace('(requestSignal) => state.handle.listTools(cursor, requestSignal, state.timeoutMs)', '(requestSignal, resetTimeout) => state.handle.listTools(cursor, requestSignal, state.timeoutMs, resetTimeout)'));
  replace('            const token = allocateServerToken(server.name);', '            const token = allocateServerToken(server.name);\n            const timeoutMs = server[Symbol.for("eido.pi.mcp.options")]?.timeoutMs ?? deps.mcpTimeoutMs;');
  section('        for (const server of servers) {\n            const token', '        // Keep the initialization window', part => part
    .replaceAll('undefined, deps.mcpTimeoutMs, deps.sleep', 'undefined, timeoutMs, deps.sleep')
    .replaceAll('handle.ping(requestSignal, deps.mcpTimeoutMs)', 'handle.ping(requestSignal, timeoutMs)')
    .replaceAll('handle.setLoggingLevel(requestSignal, deps.mcpTimeoutMs)', 'handle.setLoggingLevel(requestSignal, timeoutMs)')
    .replaceAll('handle.getPeerSignal?.(), deps.mcpTimeoutMs, deps.sleep', 'handle.getPeerSignal?.(), timeoutMs, deps.sleep')
    .replace('                    server,\n                    token,', '                    server,\n                    timeoutMs,\n                    token,')
    .replaceAll('                throw adapterError("mcp_init_error", { server: server.name });', '                await skipServer(server, state, handle);\n                continue;'));
  replace('                throw adapterError("mcp_init_error", { server: state.server.name });\n            }\n        }\n        // Every capability-conditioned', '                await skipServer(state.server, state, state.handle);\n            }\n        }\n        // Every capability-conditioned');
  section('        // Every capability-conditioned', '    const inlineExtension', part => part
    .replace('for (const state of states)', 'for (const state of [...states])')
    .replace('throw adapterError("mcp_init_error", { server: state.server.name });', 'await skipServer(state.server, state, state.handle);'));
  // Opening errors must reach the conversation after it exists, once per task.
  replace('            api.on("before_agent_start", (event) => {', '            api.on("before_agent_start", (event) => {\n                for (const text of pendingDiagnostics.splice(0)) binding?.emitDiagnostic(text);');
  await writeFile(path, marker + source);
}
