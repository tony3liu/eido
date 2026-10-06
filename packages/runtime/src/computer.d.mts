export function computerSettings(directory: string, env?: NodeJS.ProcessEnv): Promise<{enabled: boolean; path: string; executable: string | null; status: string; message: string}>;
export function computerMcp(directory: string): Promise<Array<{name: string; command: string; args: string[]; env: []}>>;
