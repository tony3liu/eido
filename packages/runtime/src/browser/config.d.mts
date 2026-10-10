export const browserCredentialId: string;
export const browserTextCredentialId: string;
export const browserDefaults: {apiUrl: string; model: string};
type Credential = 'configured' | 'environment' | 'none';
export function browserDecisionSettings(directory: string): Promise<{apiUrl: string; model: string; engine:'ultrafast'|'legacy'; credential:Credential}>;
export function browserTextSettings(directory:string):Promise<{apiUrl:string;model:string;reasoning:'low'|'none';credential:Credential}>;
export function browserDecisionEnvironment(directory: string): Promise<Record<string,string>>;
