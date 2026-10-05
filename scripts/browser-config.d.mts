export const browserCredentialId: string;
export const browserDefaults: {apiUrl: string; model: string};
export function browserDecisionSettings(directory: string): Promise<{apiUrl: string; model: string; credential: "configured" | "environment" | "none"}>;
export function browserDecisionEnvironment(directory: string): Promise<{JEV_API_URL: string; JEV_MODEL: string; TYPESAFE_API_KEY?: string}>;
