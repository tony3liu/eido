export function claimBundledRuntime(root: string): Promise<() => Promise<void>>;
export function withRuntimeInstall<T>(root: string, install: () => T | Promise<T>): Promise<T>;
