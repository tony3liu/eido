import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ReadOnlyAuthStorage } from "../packages/acp/node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";

export const browserCredentialId = "eido-jev";
export const browserDefaults = {apiUrl: "https://api.typesafe.ai/v1/systemone", model: "jev-latest"};

export async function browserDecisionSettings(directory) {
  const raw = await readFile(join(directory, "settings.json"), "utf8").catch(error => {if (error.code === "ENOENT") return "{}"; throw error;});
  const config = JSON.parse(raw).eido?.browserDecision ?? {};
  const credentials = await new ReadOnlyAuthStorage(join(directory, "auth.json")).list();
  return {apiUrl: config.apiUrl ?? process.env.JEV_API_URL ?? browserDefaults.apiUrl,
    model: config.model ?? process.env.JEV_MODEL ?? browserDefaults.model,
    credential: credentials.some(entry => entry.providerId === browserCredentialId && entry.type === "api_key")
      ? "configured" : process.env.TYPESAFE_API_KEY ? "environment" : "none"};
}

export async function browserDecisionEnvironment(directory) {
  const config = await browserDecisionSettings(directory);
  const credential = await new ReadOnlyAuthStorage(join(directory, "auth.json")).read(browserCredentialId);
  const key = credential?.type === "api_key" ? credential.key : process.env.TYPESAFE_API_KEY;
  if (key?.startsWith("!")) throw new Error("Jev credentials support an API key or a $ENV_VAR reference.");
  return {JEV_API_URL: config.apiUrl, JEV_MODEL: config.model, ...(key ? {TYPESAFE_API_KEY: key} : {})};
}
