// Adapted for Eido from @automatalabs/pi-acp 0.9.4 (Apache-2.0). See ../LICENSE.
import { ModelRuntime, SessionManager, createAgentSession, getAgentDir, } from "@earendil-works/pi-coding-agent";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { connectDefaultMcpClient, } from "./mcp-bridge.js";
export function realSleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason);
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason);
        }, { once: true });
    });
}
export async function resolveDeps(partial = {}) {
    const sleep = partial.sleep ?? realSleep;
    const mcpTimeoutMs = partial.mcpTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
    const modelRuntime = partial.modelRuntime ?? await ModelRuntime.create();
    const sessions = partial.sessions ?? {
        create: SessionManager.create,
        open: SessionManager.open,
        forkFrom: SessionManager.forkFrom,
        list: SessionManager.list,
        listAll: (sessionDir) => SessionManager.listAll(sessionDir),
    };
    return {
        eidoClaimSession: partial.eidoClaimSession,
        createAgentSession: partial.createAgentSession ?? createAgentSession,
        sessions,
        modelRuntime,
        agentDir: partial.agentDir ?? getAgentDir(),
        sessionDir: partial.sessionDir,
        sleep,
        graceMs: partial.graceMs ?? 5_000,
        mcpTimeoutMs,
        connectMcpClient: partial.connectMcpClient ??
            ((server, signal, binding) => connectDefaultMcpClient(server, signal, mcpTimeoutMs, sleep, binding)),
    };
}
