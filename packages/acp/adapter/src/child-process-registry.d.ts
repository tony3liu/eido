import { type ChildProcess } from "node:child_process";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { PiAcpDeps } from "./deps.js";
interface ChildRecord {
    pid: number;
    pgid?: number;
    child: ChildProcess;
    leaderClosed: Promise<void>;
    termination?: Promise<void>;
    terminationSettled?: boolean;
}
export interface ChildProcessRegistryDeps extends Pick<PiAcpDeps, "graceMs" | "sleep"> {
    platform?: NodeJS.Platform;
    processGroupState?(pgid: number): "alive" | "gone" | "error";
    killProcessGroup?(pgid: number): void;
    taskkillTree?(pid: number, signal: AbortSignal): Promise<void>;
}
export interface SpawnLease {
    register(child: ChildProcess): ChildRecord;
    failed(): void;
}
export declare class ChildCleanupFailure extends Error {
    readonly remainingChildren: number;
    constructor(remainingChildren: number);
}
export declare function isTaskkillAlreadyGone(output: string): boolean;
/** One monotonic ownership epoch. A failed drain remains closing and is retryable. */
export declare class ChildProcessRegistry {
    private readonly deps;
    private state;
    private readonly children;
    private pendingSpawns;
    private drain;
    private generationSignal;
    private changeWaiters;
    constructor(deps: ChildProcessRegistryDeps);
    private get platform();
    get remainingChildren(): number;
    get leaderPids(): readonly number[];
    beginSpawn(): SpawnLease;
    private registerChild;
    /** Natural operation completion never proves away a surviving Unix process group. */
    complete(record: ChildRecord): void;
    /** Terminate one timed-out/aborted tool tree without closing admission for unrelated tools. */
    terminateOne(record: ChildRecord): Promise<void>;
    terminateAll(deadlineSignal: AbortSignal): Promise<void>;
    private drainGeneration;
    private groupState;
    private startTermination;
    private terminateRecord;
    private changed;
    private waitForChange;
}
export declare class ChildProcessRegistrySlot {
    private readonly deps;
    private epoch;
    private cleanupFailed;
    constructor(deps: ChildProcessRegistryDeps);
    get registry(): ChildProcessRegistry;
    get childCleanupFailed(): boolean;
    get remainingChildren(): number;
    beginSpawn(): SpawnLease;
    latchFailure(): void;
    clearFailure(): void;
    /**
     * Close admission on the current epoch synchronously and return that exact
     * epoch with its drain.  Rotation is deliberately a separate commit: a
     * cancel generation must not publish a fresh spawn epoch until both Pi and
     * this captured registry are idle.
     */
    closeEpoch(deadlineSignal: AbortSignal): {
        epoch: ChildProcessRegistry;
        drain: Promise<void>;
    };
    commitRotation(captured: ChildProcessRegistry): void;
    /** Compatibility seam for focused registry tests; production uses the
     * explicit closeEpoch/commitRotation transaction above. */
    terminateAll(shouldRotate: () => boolean, deadlineSignal: AbortSignal): Promise<void>;
}
export declare function createTrackedBashOperations(slot: ChildProcessRegistrySlot, shellPath: string | undefined, deps: Pick<PiAcpDeps, "graceMs" | "sleep">, onCleanupFailure: () => void): BashOperations;
export {};
//# sourceMappingURL=child-process-registry.d.ts.map