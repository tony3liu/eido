import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

// Reserve stdout for the existing adapter's ACP transport before loading pi.
console.log = console.error;
console.info = console.error;
console.debug = console.error;
const root = process.env.EIDO_ROOT;
if (!root) throw new Error("Launch this agent from Eido's configured workspace.");
const agentDir = resolve(process.env.EIDO_PI_CONFIG_DIR || resolve(root, ".local/eido"));
const sessionDir = resolve(agentDir, "acp-sessions");
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(sessionDir, { recursive: true, mode: 0o700 });
const {claimBundledRuntime}=await import('../../runtime/src/lifecycle.mjs');
const releaseBundle=process.env.EIDO_INSTALLED_RUNTIME==='1'?async()=>{}:await claimBundledRuntime(root);
process.once('exit',()=>{void releaseBundle();});
const { createExtensionCenter } = await import("../../runtime/src/pi/extensions.mjs");
const { takeOverStdout, restoreStdout } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/output-guard.js");
takeOverStdout();
const releaseRuntime = await createExtensionCenter(agentDir).acquireRuntime();
restoreStdout();
const { initializePiNetwork } = await import('./pi-network.ts');
try { initializePiNetwork(agentDir); }
catch { await releaseRuntime(); await releaseBundle(); throw new Error('Unable to initialize pi networking. Check global HTTP proxy and timeout settings.'); }
const { startEidoAgent } = await import("./server.ts");
const { agent, connection } = await startEidoAgent(agentDir, sessionDir).catch(async error => {await releaseRuntime(); await releaseBundle(); throw error;});
let shuttingDown: Promise<void> | undefined;
const shutdown = (code: number) => {
  shuttingDown ??= (async () => {
    const deadline = setTimeout(() => process.exit(1), 15_000);
    try { await agent.dispose(); await releaseRuntime(); await releaseBundle(); clearTimeout(deadline); process.exit(code); }
    catch { await releaseRuntime(); await releaseBundle(); clearTimeout(deadline); console.error("Eido ACP cleanup failed."); process.exit(1); }
  })();
  return shuttingDown;
};
connection.closed.then(() => shutdown(0), () => shutdown(1));
process.on("SIGTERM", () => { void shutdown(0); });
process.on("SIGINT", () => { void shutdown(0); });
