import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';

// Runtime registrations enter the same bridge and share its turn boundary.
// A plugin can queue a replacement during a tool call; registration never waits
// for that same call to end, so /reload and tool-driven changes cannot deadlock.
export async function patchMcpRegistry(path, agentPath, patch) {
  let source = await readFile(path, 'utf8');
  const marker = '// Eido MCP registry v1';
  if (!source.includes(marker)) {
    if (createHash('sha256').update(source).digest('hex') !== '101a9799a20d5882143a647141a26edf1529b84b55c9b34f7cb1bf501372bf06') {
      throw new Error('Review the MCP bridge before adapting runtime registrations.');
    }
    const replace = (before, after) => {
      if (source.split(before).length !== 2) throw new Error(`Unexpected MCP registry source: ${before.slice(0,100)}`);
      source = source.replace(before, after);
    };
    replace('    const usedServerTokens = new Set();', '    const usedServerTokens = new Set();\n    const serverTokens = new Map();');
    replace('    const allocateServerToken = (name) => {', '    const allocateServerToken = (name) => {\n        if (serverTokens.has(name)) return serverTokens.get(name);');
    replace('        usedServerTokens.add(candidate);\n        return candidate;', '        usedServerTokens.add(candidate);\n        serverTokens.set(name, candidate);\n        return candidate;');
    replace('const skipServer = async (server, state, handle) => {', 'const skipServer = async (server, state, handle, diagnose = true) => {');
    replace('                aliasServers.delete(alias);', '                aliasServers.delete(alias);\n                usedAliases.delete(alias);');
    replace('        if (handle) await closeClients([handle], deps);', '        if (handle) {\n            await closeClients([handle], deps);\n            const index = acquiredHandles.indexOf(handle);\n            if (index >= 0) acquiredHandles.splice(index, 1);\n        }\n        if (!diagnose) return;');
    const start = source.indexOf('    try {\n        for (const server of servers) {\n            const token');
    const end = source.indexOf('    const inlineExtension =', start);
    if (start < 0 || end < 0) throw new Error('Missing MCP connection transaction.');
    let connect = source.slice(start, end);
    connect = connect
      .replace('        const initialDirty = states.filter((state) => state.dirty);\n        for (const state of states)',
        '        const initialStates = states.filter(state => state.initializing);\n        const initialDirty = initialStates.filter((state) => state.dirty);\n        for (const state of initialStates)')
      .replace('for (const state of [...states]) {', 'for (const state of initialStates.filter(state => !state.disabled)) {')
      .replace('await closeClients(acquiredHandles, deps);', `const rollback = acquiredHandles.slice(acquiredStart);
        for (const state of [...states]) if (rollback.includes(state.handle)) await skipServer(state.server, state, state.handle, false);
        await closeClients(rollback, deps);
        acquiredHandles.splice(acquiredStart);`);
    source = source.slice(0, start) + `    const connectServers = async (servers, openSignal) => {
        const acquiredStart = acquiredHandles.length;
${connect}    };
    await connectServers(servers, openSignal);
${marker}
    const fixedNames = new Set(servers.filter(server => !server[Symbol.for("eido.pi.mcp.options")]).map(server => server.name));
    const fingerprint = server => {
        const options = server[Symbol.for("eido.pi.mcp.options")];
        return JSON.stringify([server, options?.config, options?.autoEnableCodemode, options?.cwd, options?.unresolved]);
    };
    const managed = new Map(servers.filter(server => !fixedNames.has(server.name)).map(server => [server.name, fingerprint(server)]));
    const resolveRegistered = deps.connectMcpClient[Symbol.for("eido.pi.mcp.registered")];
    let registrationRevision = 0;
    let pendingRegistration;
    let registrationController;
    const retire = async state => {
        state.disabled = true;
        state.dirty = false;
        for (const alias of state.validAliases) {
            const definition = piSession?.getToolDefinition(alias) ?? tools.find(tool => tool.name === alias);
            if (definition) extensionApi?.registerTool({ ...definition, exposure: "hidden" });
        }
        for (const alias of [...state.syntheticAliases, ...state.aliases.values()]) {
            const toolIndex = tools.findIndex(tool => tool.name === alias);
            if (toolIndex >= 0) tools.splice(toolIndex, 1);
            const aliasIndex = aliases.indexOf(alias);
            if (aliasIndex >= 0) aliases.splice(aliasIndex, 1);
            usedAliases.delete(alias);
            aliasServers.delete(alias);
        }
        state.validAliases.clear();
        states.splice(states.indexOf(state), 1);
        await closeClients([state.handle], deps);
        const acquiredIndex = acquiredHandles.indexOf(state.handle);
        if (acquiredIndex >= 0) acquiredHandles.splice(acquiredIndex, 1);
    };
    const reconcileRegistrations = async (registrations, signal, revision, retry = false) => {
        if (!resolveRegistered || closing) return;
        let next;
        try {next = (await resolveRegistered(binding?.cwd, registrations)).filter(server => !fixedNames.has(server.name));}
        catch {pendingDiagnostics.push("MCP configuration could not be loaded. Check Extensions > MCP; existing connections were kept.\\n"); return;}
        if (closing || signal.aborted || revision !== registrationRevision) return;
        const wanted = new Map(next.map(server => [server.name, fingerprint(server)]));
        for (const state of [...states]) {
            if (managed.has(state.server.name) && (state.disabled || state.peerDead || wanted.get(state.server.name) !== managed.get(state.server.name))) await retire(state);
        }
        const add = next.filter(server => !states.some(state => state.server.name === server.name) && (retry || managed.get(server.name) !== wanted.get(server.name)));
        managed.clear();
        for (const [name, value] of wanted) managed.set(name, value);
        const previousTools = new Set(tools.map(tool => tool.name));
        await connectServers(add, signal);
        if (closing || signal.aborted) return;
        for (const tool of tools) if (!previousTools.has(tool.name)) extensionApi?.registerTool(tool);
    };
    const scheduleRegistrations = registrations => {
        registrationController?.abort(new Error("MCP registration superseded"));
        pendingRegistration = { registrations, revision: ++registrationRevision };
        if (closing || refreshPaused) return;
        refreshQueue = refreshQueue.then(async () => {
            if (closing || refreshPaused || !pendingRegistration) return;
            const next = pendingRegistration;
            const release = await acquireTurnBoundary();
            const controller = new AbortController();
            try {
                if (closing || refreshPaused || next !== pendingRegistration) return;
                registrationController = controller;
                await reconcileRegistrations(next.registrations, AbortSignal.any([refreshController.signal, controller.signal]), next.revision, true);
                if (next === pendingRegistration) pendingRegistration = undefined;
            } finally {if (registrationController === controller) registrationController = undefined; release();}
        }).catch(error => {
            if (!closing && !refreshPaused) binding?.emitDiagnostic("MCP registration update failed; reload the task to retry.\\n");
        });
    };
` + source.slice(end);
    replace('            extensionApi = api;\n            for (const tool of tools)', `            extensionApi = api;
            api.on("mcp_servers_change", event => { scheduleRegistrations(event.servers); });
            api.on("session_start", () => { if (piSession) scheduleRegistrations(api.getMcpServers()); });
            for (const tool of tools)`);
    replace('        bindSession(session) {', `        async initializeRegistrations() {
            await reconcileRegistrations(extensionApi?.getMcpServers() ?? [], openSignal, registrationRevision);
        },
        bindSession(session) {`);
    replace('        acquireTurnBoundary,', `        async acquireTurnBoundary() {
            while (pendingRegistration && !closing && !refreshPaused) {
                const pending = refreshQueue;
                await pending;
                if (refreshQueue === pending) break;
            }
            return acquireTurnBoundary();
        },`);
    replace('            refreshPaused = false;\n            scheduleRefreshes();', '            refreshPaused = false;\n            if (pendingRegistration) scheduleRegistrations(pendingRegistration.registrations);\n            scheduleRefreshes();');
    await writeFile(path, source);
  }
  await patch(agentPath,
    '            const created = await this.deps.createAgentSession({',
    '            await bridge.initializeRegistrations();\n            const created = await this.deps.createAgentSession({');
}
