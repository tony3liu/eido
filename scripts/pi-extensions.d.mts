export function createExtensionCenter(directory?: string, fetcher?: typeof fetch): {
  execute(request?: Record<string, unknown>): Promise<Record<string, unknown>>;
  acquireRuntime(): Promise<() => Promise<void>>;
};
export function configuredMcp(directory: string, cwd?: string): Promise<Array<
  {name: string; command: string; args: string[]; env: Array<{name: string; value: string}>}
  | {name: string; type: "http" | "sse"; url: string; headers: Array<{name: string; value: string}>}
>>;
