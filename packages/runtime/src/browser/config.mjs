import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ReadOnlyAuthStorage } from "../../../acp/node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";

export const browserCredentialId = "eido-jev";
export const browserTextCredentialId = "eido-browser-text";
export const browserDefaults = {apiUrl: "https://api.typesafe.ai/v1/systemone", model: "jev-latest"};
export const browserTextDefaults={apiUrl:'https://api.deepseek.com/v1',model:'deepseek-chat'};
const settings = async directory => JSON.parse(await readFile(join(directory, "settings.json"), "utf8").catch(error => {
  if (error.code === "ENOENT") return "{}"; throw error;
})).eido ?? {};
const auth = directory => new ReadOnlyAuthStorage(join(directory, "auth.json"));
function state(credentials, id, env) {
  return credentials.some(entry => entry.providerId === id && entry.type === "api_key") ? "configured" : env ? "environment" : "none";
}
export async function browserDecisionSettings(directory) {
  const config = (await settings(directory)).browserDecision ?? {};
  const credentials = await auth(directory).list();
  return {apiUrl: config.apiUrl ?? process.env.JEV_API_URL ?? browserDefaults.apiUrl,
    model: config.model ?? process.env.JEV_MODEL ?? browserDefaults.model,
    engine: config.engine ?? process.env.EIDO_BROWSER_ENGINE ?? 'ultrafast',
    credential: state(credentials, browserCredentialId, process.env.TYPESAFE_API_KEY)};
}
export async function browserTextSettings(directory) {
  const config = (await settings(directory)).browserText ?? {};
  return {apiUrl: config.apiUrl ?? process.env.TEXT_MODEL_BASE_URL ?? browserTextDefaults.apiUrl,model: config.model ?? process.env.TEXT_MODEL ?? browserTextDefaults.model,
    reasoning: config.reasoning ?? process.env.TEXT_MODEL_REASONING ?? 'low',
    credential: state(await auth(directory).list(),browserTextCredentialId,process.env.TEXT_MODEL_API_KEY)};
}
async function resolveKey(directory,id,fallback) {
  const credential=await auth(directory).read(id);
  const key=credential?.type==='api_key'?credential.key:fallback;
  if (key?.startsWith('!')) throw new Error('Browser credentials support an API key or a $ENV_VAR reference.');
  if (key?.startsWith('$')) return process.env[key.slice(1)]??'';
  return key??'';
}
export async function browserDecisionEnvironment(directory) {
  const config=await browserDecisionSettings(directory), text=await browserTextSettings(directory);
  const key=await resolveKey(directory,browserCredentialId,process.env.TYPESAFE_API_KEY);
  const textKey=await resolveKey(directory,browserTextCredentialId,process.env.TEXT_MODEL_API_KEY);
  return {JEV_API_URL:config.apiUrl,JEV_MODEL:config.model,EIDO_BROWSER_ENGINE:config.engine,
    TYPESAFE_API_KEY:key,TEXT_MODEL_BASE_URL:text.apiUrl,TEXT_MODEL:text.model,TEXT_MODEL_REASONING:text.reasoning,TEXT_MODEL_API_KEY:textKey};
}
