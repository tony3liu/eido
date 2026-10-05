// Supervises checks and a development server in a captured project directory.
// These are ordinary local processes, not an OS security sandbox.
import { spawn, execFile } from "node:child_process";
import { readFile, writeFile, rename } from "node:fs/promises";
import { createServer } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {fileURLToPath} from "node:url";
const commandScript = fileURLToPath(new URL("./project-command.mjs", import.meta.url));

const exec = promisify(execFile);
const [directory, owner] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
const groups = new Set();
let closing = false;
const state = { runId: manifest.runId, stage: "starting", checks: [] };
async function record() {
  const path = join(directory, "project-result.json");
  await writeFile(`${path}.tmp`, JSON.stringify(state), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}
function signalGroup(pid, signal) {
  try { process.kill(process.platform === "win32" ? pid : -pid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}
async function stop(code = 0) {
  if (closing) return;
  closing = true;
  clearInterval(watchdog); clearTimeout(expiry);
  for (const pid of groups) signalGroup(pid, "SIGTERM");
  await delay(300);
  for (const pid of groups) signalGroup(pid, "SIGKILL");
  await writeFile(join(directory, "closed.json.tmp"), JSON.stringify({runId: manifest.runId, closedAt: new Date().toISOString()}), {mode: 0o600});
  await rename(join(directory, "closed.json.tmp"), join(directory, "closed.json"));
  process.exit(code);
}
const watchdog = setInterval(async () => {
  try { process.kill(Number(owner), 0); } catch { void stop(); }
  try { if ((await readFile(join(directory, "stop"), "utf8")) === manifest.runId) void stop(); }
  catch (error) { if (error.code !== "ENOENT") void stop(1); }
}, 100);
const expiry = setTimeout(() => void stop(124), 30 * 60 * 1000);
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
process.on("SIGHUP", () => void stop());
const env = { ...process.env,
  PATH: [join(directory, "files", "node_modules", ".bin"), dirname(process.execPath), process.env.PATH ?? ""].join(delimiter),
  npm_config_offline: "true", npm_config_update_notifier: "false", PIP_NO_INDEX: "1", CARGO_NET_OFFLINE: "true" };

function launch(spec, port) {
  if (closing) throw new Error("Project run was cancelled.");
  const substitute = value => port === undefined ? value : value.replaceAll("{port}", String(port));
  const child = spawn(process.execPath, [commandScript], {
    cwd: join(directory, "files"), env: { ...env, ...(port === undefined ? {} : { PORT: String(port), HOST: "127.0.0.1" }) },
    stdio: ["ignore", "pipe", "pipe", "ipc"], detached: process.platform !== "win32",
  });
  if (child.pid) groups.add(child.pid);
  let output = Buffer.alloc(0), truncated = false;
  const capture = (chunk, stream) => {
    stream.write(chunk);
    output = Buffer.concat([output, chunk]);
    if (output.length > 16_384) { output = output.subarray(-16_384); truncated = true; }
  };
  child.stdout.on("data", chunk => capture(chunk, process.stdout));
  child.stderr.on("data", chunk => capture(chunk, process.stderr));
  let completed;
  const exit = new Promise(resolve => {
    child.once("message", result => { completed = result; });
    child.once("error", error => resolve({ exitCode: null, error: error.message }));
    child.once("close", (exitCode, signal) => {
      groups.delete(child.pid);
      resolve(completed ?? { exitCode, ...(signal ? { signal } : {}) });
    });
  });
  child.send({ command: spec.command === "node" ? process.execPath : spec.command, args: (spec.args ?? []).map(substitute) }, () => {});
  return { child, exit, output: () => ({output: output.toString("utf8"), outputTruncated: truncated}) };
}

// A briefly released port can be claimed by another process. Only expose a
// URL when the listening process belongs to our server's process group.
async function ownsPort(port, group) {
  const { stdout } = await exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], { timeout: 2000 });
  const pids = [...new Set(stdout.split("\n").filter(line => /^p\d+$/.test(line)).map(line => line.slice(1)))];
  if (!pids.length) return false;
  for (const pid of pids) {
    const result = await exec("ps", ["-o", "pgid=", "-p", pid], { timeout: 2000 });
    if (Number(result.stdout.trim()) !== group) throw new Error("The preview port was claimed by an unrelated process.");
  }
  return true;
}

try {
  if (process.platform === "win32") throw new Error("Project process-group cleanup currently requires macOS or Linux.");
  for (const [index, spec] of (manifest.commands ?? []).entries()) {
    state.stage = "checking";
    state.checks.push({ command: spec.command, args: spec.args ?? [], startedAt: new Date().toISOString() });
    await record();
    console.log(`Eido check ${index + 1}: ${JSON.stringify([spec.command, ...spec.args ?? []])}`);
    const { child, exit, output } = launch(spec);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; if (child.pid) signalGroup(child.pid, "SIGKILL"); }, (spec.timeoutSeconds ?? 60) * 1000);
    const result = await exit;
    clearTimeout(timer);
    if (closing) break;
    // Background descendants of a completed check must not outlive it.
    if (child.pid) groups.delete(child.pid);
    Object.assign(state.checks[index], result, output(), { timedOut, finishedAt: new Date().toISOString() });
    if (result.exitCode !== 0 || timedOut) {
      state.stage = "failed"; await record();
      await stop(1);
    }
  }
  if (closing) await new Promise(() => {});
  if (!manifest.server) {
    state.stage = "completed"; await record();
    await stop();
  } else {
    await exec("lsof", ["-v"], { timeout: 2000 });
    const reservation = createServer();
    await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    state.stage = "starting_server"; await record();
    const { child, exit, output } = launch(manifest.server, port);
    let ended;
    void exit.then(result => { ended = result; });
    const url = `http://127.0.0.1:${port}${manifest.server.path ?? "/"}`;
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (!ended && !closing && Date.now() < deadline) {
      try {
        const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(750) });
        await response.body?.cancel();
        state.httpStatus = response.status;
        ready = true; break;
      } catch { await delay(100); }
    }
    state.serverOutput = output();
    if (!ready || ended || closing) throw new Error(`Project server did not become reachable: ${JSON.stringify(ended ?? { timeout: true })}`);
    if (!await ownsPort(port, child.pid)) throw new Error("Could not verify project server process ownership.");
    if (ended || closing) throw new Error("Project server exited during startup.");
    state.stage = "serving"; state.url = url; state.serverPid = child.pid;
    await record();
    console.log(`Eido project server: ${url}`);
    const result = await exit;
    if (!closing) { state.stage = "exited"; state.serverExit = result; state.serverOutput = output(); await record(); }
    await stop(result.exitCode === 0 ? 0 : 1);
  }
} catch (error) {
  if (!closing) { state.stage = "failed"; state.error = error.message; await record(); }
  await stop(1);
}
