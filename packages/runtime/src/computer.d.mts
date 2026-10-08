export function computerSettings(directory: string, env?: NodeJS.ProcessEnv, root?: string): Promise<{enabled: boolean; path: string; executable: string | null; status: string; message: string}>;
export function computerMcp(directory: string, root?: string): Promise<Array<{name: string; command: string; args: string[]; env: Array<{name: string; value: string}>}>>;
