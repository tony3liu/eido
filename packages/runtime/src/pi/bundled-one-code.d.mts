export const ONE_CODE_ID: string;
export function oneCodeDescriptor(settings?: any, root?: string, directory?: string): any;
export function isOneCodeSource(value: unknown, directory: string, root?: string): boolean;
export function oneCodeSettingsView(manager: any, directory: string, cwd?: string): () => any;
export function isOneCodeSearch(path: string): boolean;
export function recordOneCodeLoad(directory: string, sessionId: string, descriptor: any, errors?: any[]): Promise<() => Promise<void>>;
export function oneCodeLoads(directory: string): Promise<any[]>;
