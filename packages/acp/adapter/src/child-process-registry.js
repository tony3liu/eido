// Adapted for Eido from @automatalabs/pi-acp 0.9.4 (Apache-2.0). See ../LICENSE.
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
export class ChildCleanupFailure extends Error {
    remainingChildren;
    constructor(remainingChildren) {
        super("child process cleanup failed");
        this.remainingChildren = remainingChildren;
        this.name = "ChildCleanupFailure";
    }
}
export function isTaskkillAlreadyGone(output) {
    return /ERROR:\s+The process "[^"]+" not found\./i.test(output)
        || /Reason:\s+There is no running instance of the task\./i.test(output);
}
/** One monotonic ownership epoch. A failed drain remains closing and is retryable. */
export class ChildProcessRegistry {
    deps;
    state = "open";
    children = new Map();
    pendingSpawns = 0;
    drain;
    generationSignal;
    changeWaiters = new Set();
    constructor(deps) {
        this.deps = deps;
    }
    get platform() { return this.deps.platform ?? process.platform; }
    get remainingChildren() { return this.children.size; }
    get leaderPids() { return [...this.children.keys()]; }
    beginSpawn() {
        if (this.state !== "open")
            throw new Error("aborted");
        this.pendingSpawns += 1;
        let settled = false;
        return {
            failed: () => {
                if (settled)
                    return;
                settled = true;
                this.pendingSpawns -= 1;
                this.changed();
            },
            register: (child) => {
                if (settled)
                    throw new Error("spawn lease already settled");
                settled = true;
                this.pendingSpawns -= 1;
                const record = this.registerChild(child);
                if (this.state !== "open") {
                    const signal = this.generationSignal;
                    if (signal)
                        this.startTermination(record, signal);
                }
                this.changed();
                return record;
            },
        };
    }
    registerChild(child) {
        if (!child.pid)
            throw new Error("bash child spawned without pid");
        let closeError;
        const leaderClosed = new Promise((resolve, reject) => {
            child.once("error", (error) => {
                closeError = error;
                reject(error);
            });
            child.once("close", () => closeError === undefined ? resolve() : reject(closeError));
        });
        // A rejected leader promise is always observed by normal execution or cleanup.
        leaderClosed.catch(() => undefined);
        const record = {
            pid: child.pid,
            pgid: this.platform === "win32" ? undefined : child.pid,
            child,
            leaderClosed,
        };
        this.children.set(record.pid, record);
        return record;
    }
    /** Natural operation completion never proves away a surviving Unix process group. */
    complete(record) {
        if (this.children.get(record.pid) !== record)
            return;
        // A Windows leader close is not descendant-disappearance proof.  Keep the
        // ownership record until terminateRecord observes successful taskkill /T
        // /F as well as leader close.  Unix may discharge ownership with ESRCH for
        // the process group plus the already-observed leader completion.
        if (this.platform !== "win32" && this.groupState(record.pgid ?? record.pid) === "gone") {
            this.children.delete(record.pid);
            this.changed();
        }
    }
    /** Terminate one timed-out/aborted tool tree without closing admission for unrelated tools. */
    async terminateOne(record) {
        if (this.children.get(record.pid) !== record)
            return;
        const deadline = new AbortController();
        const timer = new AbortController();
        const expiry = this.deps.sleep(this.deps.graceMs, timer.signal).then(() => {
            deadline.abort(new ChildCleanupFailure(this.children.size));
            throw new ChildCleanupFailure(this.children.size);
        });
        expiry.catch(() => undefined);
        try {
            await Promise.race([this.startTermination(record, deadline.signal), expiry]);
        }
        finally {
            timer.abort();
            if (record.termination) {
                await record.termination.catch(() => undefined);
                record.termination = undefined;
                record.terminationSettled = false;
            }
        }
    }
    terminateAll(deadlineSignal) {
        if (this.drain)
            return this.drain;
        if (this.state === "closed" && this.children.size === 0 && this.pendingSpawns === 0) {
            return Promise.resolve();
        }
        this.state = "closing";
        this.generationSignal = deadlineSignal;
        for (const record of this.children.values()) {
            record.termination = undefined;
            record.terminationSettled = false;
            this.startTermination(record, deadlineSignal);
        }
        this.drain = this.drainGeneration(deadlineSignal)
            .then(() => { this.generationSignal = undefined; })
            .finally(() => { this.drain = undefined; });
        return this.drain;
    }
    async drainGeneration(deadlineSignal) {
        while (true) {
            for (const record of this.children.values())
                this.startTermination(record, deadlineSignal);
            if (this.pendingSpawns === 0 && this.children.size === 0) {
                this.state = "closed";
                return;
            }
            if (deadlineSignal.aborted)
                throw new ChildCleanupFailure(this.children.size);
            const terminations = [...this.children.values()]
                .flatMap((record) => record.termination ? [record.termination] : []);
            if (this.pendingSpawns === 0 && terminations.length > 0) {
                await Promise.allSettled(terminations);
                if (this.children.size > 0) {
                    if (deadlineSignal.aborted)
                        throw new ChildCleanupFailure(this.children.size);
                    // Every admitted record was attempted and at least one proof failed.
                    const allSettled = [...this.children.values()].every((record) => record.terminationSettled);
                    if (allSettled)
                        throw new ChildCleanupFailure(this.children.size);
                }
                continue;
            }
            try {
                await Promise.race([this.waitForChange(), abortPromise(deadlineSignal)]);
            }
            catch {
                throw new ChildCleanupFailure(this.children.size);
            }
        }
    }
    groupState(pgid) {
        if (this.deps.processGroupState)
            return this.deps.processGroupState(pgid);
        try {
            process.kill(-pgid, 0);
            return "alive";
        }
        catch (error) {
            const code = error.code;
            if (code === "ESRCH")
                return "gone";
            if (code === "EPERM")
                return "alive";
            return "error";
        }
    }
    startTermination(record, deadlineSignal) {
        if (record.termination)
            return record.termination;
        record.terminationSettled = false;
        record.termination = this.terminateRecord(record, deadlineSignal)
            .finally(() => { record.terminationSettled = true; });
        record.termination.catch(() => undefined);
        return record.termination;
    }
    async terminateRecord(record, deadlineSignal) {
        if (this.platform === "win32") {
            const taskkill = this.deps.taskkillTree
                ? this.deps.taskkillTree(record.pid, deadlineSignal)
                : new Promise((resolve, reject) => {
                    const killer = spawn("taskkill", ["/PID", String(record.pid), "/T", "/F"], { windowsHide: true });
                    let output = "";
                    killer.stdout?.setEncoding("utf8");
                    killer.stderr?.setEncoding("utf8");
                    killer.stdout?.on("data", (chunk) => { output += chunk; });
                    killer.stderr?.on("data", (chunk) => { output += chunk; });
                    killer.once("error", reject);
                    killer.once("close", (code) => code === 0 || isTaskkillAlreadyGone(output)
                        ? resolve()
                        : reject(new Error(`taskkill exited ${code}`)));
                });
            try {
                await raceAbort(taskkill, deadlineSignal);
            }
            catch (error) {
                if (error.code !== "ESRCH")
                    throw error;
            }
        }
        else {
            if (this.deps.killProcessGroup) {
                this.deps.killProcessGroup(record.pgid ?? record.pid);
            }
            else {
                try {
                    process.kill(-(record.pgid ?? record.pid), "SIGKILL");
                }
                catch (error) {
                    if (error.code !== "ESRCH")
                        throw error;
                }
            }
        }
        await raceAbort(record.leaderClosed, deadlineSignal);
        if (this.platform !== "win32") {
            while (true) {
                const state = this.groupState(record.pgid ?? record.pid);
                if (state === "gone")
                    break;
                if (state === "error")
                    throw new Error("child process-group probe failed");
                await raceAbort(this.deps.sleep(10, deadlineSignal), deadlineSignal);
            }
        }
        this.children.delete(record.pid);
        this.changed();
    }
    changed() {
        const waiters = this.changeWaiters;
        this.changeWaiters = new Set();
        for (const resolve of waiters)
            resolve();
    }
    waitForChange() {
        return new Promise((resolve) => {
            this.changeWaiters.add(resolve);
        });
    }
}
function abortPromise(signal) {
    return new Promise((_, reject) => {
        if (signal.aborted)
            reject(signal.reason);
        else
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
}
async function raceAbort(promise, signal) {
    promise.catch(() => undefined);
    return Promise.race([promise, abortPromise(signal)]);
}
export class ChildProcessRegistrySlot {
    deps;
    epoch;
    cleanupFailed = false;
    constructor(deps) {
        this.deps = deps;
        this.epoch = new ChildProcessRegistry(deps);
    }
    get registry() { return this.epoch; }
    get childCleanupFailed() { return this.cleanupFailed; }
    get remainingChildren() { return this.epoch.remainingChildren; }
    beginSpawn() { return this.epoch.beginSpawn(); }
    latchFailure() { this.cleanupFailed = true; }
    clearFailure() { this.cleanupFailed = false; }
    /**
     * Close admission on the current epoch synchronously and return that exact
     * epoch with its drain.  Rotation is deliberately a separate commit: a
     * cancel generation must not publish a fresh spawn epoch until both Pi and
     * this captured registry are idle.
     */
    closeEpoch(deadlineSignal) {
        const captured = this.epoch;
        return { epoch: captured, drain: captured.terminateAll(deadlineSignal) };
    }
    commitRotation(captured) {
        if (this.epoch === captured) {
            this.epoch = new ChildProcessRegistry(this.deps);
            this.cleanupFailed = false;
        }
    }
    /** Compatibility seam for focused registry tests; production uses the
     * explicit closeEpoch/commitRotation transaction above. */
    async terminateAll(shouldRotate, deadlineSignal) {
        const { epoch, drain } = this.closeEpoch(deadlineSignal);
        await drain;
        if (shouldRotate())
            this.commitRotation(epoch);
    }
}
class BashCleanupSentinel extends Error {
}
export function createTrackedBashOperations(slot, shellPath, deps, onCleanupFailure) {
    return {
        async exec(command, cwd, { onData, signal, timeout, env }) {
            if (signal?.aborted)
                throw new Error("aborted");
            if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
                throw new Error("Invalid timeout: must be a finite number of seconds");
            }
            const timeoutMs = timeout === undefined ? undefined : timeout * 1000;
            if (timeoutMs !== undefined && timeoutMs > 2_147_483_647) {
                throw new Error(`Invalid timeout: maximum is ${2_147_483_647 / 1000} seconds`);
            }
            try {
                await access(cwd, constants.F_OK);
            }
            catch {
                throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
            }
            // access() is asynchronous.  A cancel may have closed the captured
            // generation while it was pending, so re-check before taking a lease.
            if (signal?.aborted)
                throw new Error("aborted");
            const shell = getShellConfig(shellPath);
            const stdin = shell.commandTransport === "stdin";
            const lease = slot.beginSpawn();
            let child;
            try {
                child = spawn(shell.shell, stdin ? shell.args : [...shell.args, command], {
                    cwd,
                    detached: process.platform !== "win32",
                    env,
                    stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
                    windowsHide: true,
                });
            }
            catch (error) {
                lease.failed();
                throw error;
            }
            let record;
            try {
                record = lease.register(child);
            }
            catch (error) {
                lease.failed();
                try {
                    child.kill("SIGKILL");
                }
                catch { /* no PID/tree was admitted */ }
                throw error;
            }
            if (stdin) {
                child.stdin?.on("error", () => undefined);
                child.stdin?.end(command);
            }
            child.stdout?.on("data", onData);
            child.stderr?.on("data", onData);
            const timerController = new AbortController();
            const timeoutResult = timeoutMs === undefined
                ? new Promise(() => undefined)
                : deps.sleep(timeoutMs, timerController.signal).then(() => ({ type: "timeout" }));
            timeoutResult.catch(() => undefined);
            const abortResult = signal
                ? new Promise((resolve) => {
                    if (signal.aborted)
                        resolve({ type: "abort" });
                    else
                        signal.addEventListener("abort", () => resolve({ type: "abort" }), { once: true });
                })
                : new Promise(() => undefined);
            const exitResult = new Promise((resolve, reject) => {
                child.once("error", reject);
                child.once("close", (exitCode) => resolve({ type: "exit", exitCode }));
            });
            try {
                const outcome = await Promise.race([exitResult, abortResult, timeoutResult]);
                if (outcome.type === "exit") {
                    slot.registry.complete(record);
                    return { exitCode: outcome.exitCode };
                }
                try {
                    await slot.registry.terminateOne(record);
                }
                catch {
                    slot.latchFailure();
                    onCleanupFailure();
                    throw new BashCleanupSentinel();
                }
                if (outcome.type === "abort")
                    throw new Error("aborted");
                throw new Error(`timeout:${timeout}`);
            }
            finally {
                timerController.abort();
            }
        },
    };
}
