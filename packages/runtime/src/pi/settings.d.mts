export const bundledVersion: string;
export class PiConfigError extends Error {}
export function createPiSettings(directory?: string, sourceDirectory?: string): {
  status(): Promise<Record<string, unknown>>;
  execute(request: Record<string, unknown>): Promise<Record<string, unknown>>;
};

export function validatedCustomProviders(directory: string): Promise<Map<string, {baseUrl?:string; api?:string; compat?:{forceAdaptiveThinking?:boolean}; models?: {id:string; input?: string[]; baseUrl?:string; api?:string; reasoning?:boolean; thinkingLevelMap?:Record<string,string|null>; compat?:{forceAdaptiveThinking?:boolean}}[]}>>;
