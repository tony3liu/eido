export class ResearchError extends Error { code: string; constructor(code: string, message: string); }
export interface ResearchLimits {
  attempts24h:number; uploadBytes24h:number; ocrPages24h:number; attemptsPerTurn:number;
  httpConcurrency:number; ocrConcurrency:number; fileBytes:number; pageBytes:number; pdfPages:number;
  responseBytes:number; modelTextBytes:number; searchTimeoutMs:number; ocrTimeoutMs:number;
}
export interface ResearchConfig { schemaVersion:1; enabled:boolean; baseUrl:string; revision:number; limits:ResearchLimits; }
export interface ResearchModelRuntime {
  getAuth(provider:string, options?:{signal?:AbortSignal}):Promise<{auth:{apiKey?:string}}|undefined>;
  getProviderAuthStatus(provider:string):{configured:boolean};
  settleCredentialWrites():Promise<void>;
}
export const researchProvider:'deepseek';
export const researchLimitFields:ReadonlyArray<readonly [keyof ResearchLimits,string,number,number,number]>;
export const defaultResearchLimits:Readonly<ResearchLimits>;
export function normalizeResearchUrl(value:string):string;
export function researchConfig(settings?:unknown):ResearchConfig;
export function readResearchConfig(directory:string):Promise<ResearchConfig>;
export function mergeResearchConfig(settings:unknown, changes:Partial<Omit<ResearchConfig,'schemaVersion'|'revision'>>, expectedRevision:number):unknown;
export function resolveResearchAuth(runtime:Pick<ResearchModelRuntime,'getAuth'>|undefined, signal?:AbortSignal):Promise<string>;
export function researchSettings(directory:string,runtime:ResearchModelRuntime):Promise<ResearchConfig & {credential:string;status:string;lastCheckedAt:number|null;capabilities:Record<string,unknown>}>;
