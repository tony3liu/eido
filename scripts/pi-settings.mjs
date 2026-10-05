import { readFile, writeFile, mkdir, chmod, rename, mkdtemp, rm, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { browserCredentialId, browserDecisionSettings } from "./browser-config.mjs";
import {runtimeSettings, mergeRuntimeSettings, PiRuntimeSettingsError} from './pi-runtime-settings.mjs';

class PiConfigError extends Error {}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piEntry = pathToFileURL(join(root, "packages/acp/node_modules/@earendil-works/pi-coding-agent/dist/index.js"));
const { ModelRuntime, SettingsManager, readStoredCredential } = await import(piEntry.href);
// Use pi's own locked credential store and models.json validator. These internal
// APIs are audited against the exact bundled version, not reimplemented here.
const { FileSettingsStorage } = await import(new URL("core/settings-manager.js", piEntry).href);
const { AuthStorage, ReadOnlyAuthStorage } = await import(new URL("core/auth-storage.js", piEntry).href);
const { ModelConfig } = await import(new URL("core/model-config.js", piEntry).href);
const { getSupportedThinkingLevels } = await import(pathToFileURL(join(root, "packages/acp/node_modules/@earendil-works/pi-ai/dist/index.js")).href);
const manifest = JSON.parse(await readFile(new URL("../package.json", piEntry), "utf8"));
export const bundledVersion = manifest.version;
if (bundledVersion !== "1.0.2") throw new PiConfigError("Eido requires bundled pi 1.0.2. Run setup:acp.");

async function readJson(path, fallback = {}) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw new PiConfigError("Invalid configuration file format. The file was not changed."); }
}
async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally { await rm(temporary, { force: true }); }
}
function text(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 8192) throw new PiConfigError(`${label} is required and must be at most 8192 characters.`);
  return value.trim();
}
function providerId(value) {
  const id = text(value, "Provider ID");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) throw new PiConfigError("Provider IDs may only contain letters, numbers, dots, hyphens, and underscores.");
  return id;
}

export function createPiSettings(directory = join(root, ".local/eido"), sourceDirectory = join(homedir(), ".pi/agent")) {
  const authPath = join(directory, "auth.json");
  const modelsPath = join(directory, "models.json");
  const settings = () => SettingsManager.create(directory, directory, { projectTrusted: false });
  const runtime = () => ModelRuntime.create({ authPath, modelsPath, refreshOnCreate: false, allowModelNetwork: false });
  const validateModels = async (path) => {
    const config = await ModelConfig.load(path);
    if (config.getError()) throw new PiConfigError("models.json did not pass pi validation. Check the provider, model, and API fields.");
    return config;
  };
  const writeModels = async (providers, validateOnly = false) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(directory, ".models-validation-"));
    try {
      const path = join(temporary, "models.json");
      await atomicJson(path, { providers });
      await validateModels(path);
      const check = await ModelRuntime.create({ authPath, modelsPath: path, refreshOnCreate: false, allowModelNetwork: false });
      if (check.getError()) throw new PiConfigError("Invalid custom model API, URL, or parameters. Configuration was not changed.");
      if (!validateOnly) await atomicJson(modelsPath, { providers });
      return check;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  };

  async function status() {
    const manager = settings();
    if (manager.drainErrors().length) throw new PiConfigError("Unable to read pi settings.json. Fix the configuration and try again.");
    await validateModels(modelsPath);
    const modelRuntime = await runtime();
    if (modelRuntime.getError()) throw new PiConfigError("Invalid pi model configuration. Fix models.json and try again.");
    const credentials = await new ReadOnlyAuthStorage(authPath).list();
    const providers = modelRuntime.getProviders().map(provider => {
      const credential = credentials.find(entry => entry.providerId === provider.id);
      const state = modelRuntime.getProviderAuthStatus(provider.id);
      return { id: provider.id, name: provider.name ?? provider.id,
        credential: credential?.type ?? (state.configured ? state.source ?? "configured" : "none"),
        models: modelRuntime.getModels(provider.id).map(model => ({ id: model.id, name: model.name,
          thinkingLevels: getSupportedThinkingLevels(model) })) };
    }).filter(provider => provider.models.length).sort((a, b) => a.name.localeCompare(b.name));
    return { version: bundledVersion, adapterVersion: "0.9.4", directory,
      defaultProvider: manager.getDefaultProvider() ?? "",
      defaultModel: manager.getDefaultModel() ?? "",
      defaultThinkingLevel: manager.getDefaultThinkingLevel() ?? "off",
      defaultTools: (await readJson(join(directory, "settings.json"))).defaultTools ?? null,
      runtime: runtimeSettings(manager),
      fullAccess: (await readJson(join(directory, "settings.json"))).eido?.fullAccess === true,
      browserDecision: await browserDecisionSettings(directory),
      providers, update: await readJson(join(directory, "pi-update.json"), null) };
  }

  async function execute(request) {
    const operation = request?.operation ?? "status";
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!["status", "check-update", "import", "access"].includes(operation)) await status();
    if (operation === 'runtime') {
      new FileSettingsStorage(directory, directory).withLock('global', current => {
        try {return JSON.stringify(mergeRuntimeSettings(current?JSON.parse(current):{},request.changes,request.expected),null,2)+'\n';}
        catch(error) {throw new PiConfigError(error instanceof PiRuntimeSettingsError ? error.message : 'Unable to read runtime settings. Repair settings.json before saving.');}
      });
      await chmod(join(directory, 'settings.json'), 0o600);
    } else if (operation === "tool-defaults") {
      const selected = request.tools;
      if (selected !== null && (!Array.isArray(selected) || selected.length > 256
        || selected.some(name => typeof name !== 'string' || !/^[+-]?[A-Za-z0-9_][A-Za-z0-9_.-]{0,255}$/.test(name)))) {
        throw new PiConfigError('Enter comma-separated tool names, optional + or - prefixes, or [] for no default file tools.');
      }
      new FileSettingsStorage(directory, directory).withLock('global', current => {
        const value = current ? JSON.parse(current) : {};
        if (JSON.stringify(value.defaultTools ?? null) !== JSON.stringify(request.expected ?? null)) {
          throw new PiConfigError('Tool defaults changed while this page was open. Reload the page before saving.');
        }
        if (selected === null) delete value.defaultTools;
        else value.defaultTools = selected;
        return JSON.stringify(value, null, 2) + '\n';
      });
      await chmod(join(directory, 'settings.json'), 0o600);
    } else if (operation === "browser-decision") {
      const apiUrl = text(request.apiUrl, "Jev API URL"), model = text(request.model, "Jev model");
      const url = new URL(apiUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new PiConfigError("Enter an HTTP(S) Jev endpoint without credentials or a fragment.");
      const key = request.key ? text(request.key, "Jev API Key") : undefined;
      if (key?.startsWith("!")) throw new PiConfigError("Use an API key or a $ENV_VAR reference for Jev.");
      if (request.removeKey === true) await AuthStorage.create(authPath).delete(browserCredentialId);
      else if (key) await AuthStorage.create(authPath).modify(browserCredentialId, async () => ({type: "api_key", key}));
      new FileSettingsStorage(directory, directory).withLock("global", current => {
        const value = current ? JSON.parse(current) : {};
        value.eido = {...value.eido, browserDecision: {apiUrl, model}};
        return JSON.stringify(value, null, 2) + "\n";
      });
      await chmod(join(directory, "settings.json"), 0o600);
      if (key || request.removeKey) await chmod(authPath, 0o600);
    } else if (operation === "access") {
      if (typeof request.fullAccess !== "boolean") throw new PiConfigError("Full Access must be enabled or disabled.");
      new FileSettingsStorage(directory, directory).withLock("global", current => {
        const value = current ? JSON.parse(current) : {};
        value.eido = { ...value.eido, fullAccess: request.fullAccess };
        return JSON.stringify(value, null, 2) + "\n";
      });
      await chmod(join(directory, "settings.json"), 0o600);
      return { fullAccess: request.fullAccess };
    } else if (operation === "defaults") {
      const provider = providerId(request.provider);
      const modelRuntime = await runtime();
      const model = modelRuntime.getModel(provider, text(request.model, "Model"));
      if (!model) throw new PiConfigError("The selected model is not in the pi catalog.");
      if (!getSupportedThinkingLevels(model).includes(request.thinking)) throw new PiConfigError("This model does not support the selected thinking level.");
      const manager = settings();
      if (manager.drainErrors().length) throw new PiConfigError("Unable to read pi settings. Configuration was not changed.");
      manager.setDefaultModelAndProvider(provider, model.id);
      manager.setDefaultThinkingLevel(request.thinking);
      await manager.flush();
      if (manager.drainErrors().length) throw new PiConfigError("Unable to save pi settings. Try again.");
      await chmod(join(directory, "settings.json"), 0o600);
    } else if (operation === "key") {
      const provider = providerId(request.provider);
      if (!(await runtime()).getProvider(provider)) throw new PiConfigError("Configure a model for this provider first.");
      const key = text(request.key, "API Key");
      await AuthStorage.create(authPath).modify(provider, async current => ({ type: "api_key", key,
        ...(current?.type === "api_key" && current.env ? { env: current.env } : {}) }));
      await chmod(authPath, 0o600);
    } else if (operation === "remove-key") {
      await AuthStorage.create(authPath).delete(providerId(request.provider));
    } else if (operation === "custom-model") {
      const provider = providerId(request.provider);
      const baseUrl = text(request.baseUrl, "Base URL");
      const url = new URL(baseUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new PiConfigError("Enter an HTTP(S) API URL without a username or password.");
      const api = text(request.api, "API Type");
      if (!["openai-completions", "openai-responses", "anthropic-messages"].includes(api)) throw new PiConfigError("Select a supported API type.");
      const id = text(request.model, "Model ID");
      const config = await validateModels(modelsPath);
      const providers = Object.fromEntries(config.providers);
      const current = providers[provider] ?? {};
      const models = [...(current.models ?? [])];
      const index = models.findIndex(model => model.id === id);
      const model = { ...(index >= 0 ? models[index] : {}), id, name: request.name?.trim() || id };
      if (index >= 0) models[index] = model; else models.push(model);
      providers[provider] = { ...current, baseUrl, api, models };
      await writeModels(providers);
    } else if (operation === "import") {
      if (resolve(sourceDirectory) === resolve(directory)) throw new PiConfigError("The source is already the Eido pi configuration directory.");
      if (!(await Promise.all(["models.json", "auth.json", "settings.json"].map(name => access(join(sourceDirectory, name)).then(() => true, () => false)))).some(Boolean)) {
        throw new PiConfigError("Local pi configuration was not found. Nothing was imported.");
      }
      const sourceSettings = SettingsManager.create(sourceDirectory, sourceDirectory, { projectTrusted: false });
      const manager = settings();
      if (sourceSettings.drainErrors().length || manager.drainErrors().length) throw new PiConfigError("Unable to read pi settings. Nothing was imported.");
      const sourceConfig = await validateModels(join(sourceDirectory, "models.json"));
      const sourceAuth = new ReadOnlyAuthStorage(join(sourceDirectory, "auth.json"));
      const credentials = await sourceAuth.list();
      await new ReadOnlyAuthStorage(authPath).list();
      const destination = await validateModels(modelsPath);
      const mergedProviders = Object.fromEntries(destination.providers);
      for (const [id, config] of sourceConfig.providers) {
        const current = mergedProviders[id] ?? {};
        const models = new Map((current.models ?? []).map(model => [model.id, model]));
        for (const model of config.models ?? []) models.set(model.id, { ...models.get(model.id), ...model });
        mergedProviders[id] = { ...current, ...config, ...(models.size ? { models: [...models.values()] } : {}) };
      }
      // Validate all input files and the resulting defaults before changing any
      // destination file. The source credential store is strictly read-only.
      const checked = await writeModels(mergedProviders, true);
      const provider = sourceSettings.getDefaultProvider();
      const modelId = sourceSettings.getDefaultModel();
      const thinking = sourceSettings.getDefaultThinkingLevel();
      if (provider && modelId) {
        const model = checked.getModel(provider, modelId);
        if (!model) throw new PiConfigError("The local pi default model is missing from the merged catalog. Nothing was imported.");
        if (thinking && !getSupportedThinkingLevels(model).includes(thinking)) throw new PiConfigError("The local default model does not support its thinking level. Nothing was imported.");
      }
      const importedCredentials = credentials.map(entry => [entry.providerId, readStoredCredential(entry.providerId, join(sourceDirectory, "auth.json"))]);
      await writeModels(mergedProviders);
      const target = AuthStorage.create(authPath);
      for (const [id, credential] of importedCredentials) {
        if (credential) await target.modify(id, async () => credential);
      }
      if (provider && modelId) manager.setDefaultModelAndProvider(provider, modelId);
      if (thinking) manager.setDefaultThinkingLevel(thinking);
      await manager.flush();
      if (manager.drainErrors().length) throw new PiConfigError("Unable to import default model settings. Try again.");
      for (const name of ["auth.json", "settings.json"]) {
        await chmod(join(directory, name), 0o600).catch(error => { if (error.code !== "ENOENT") throw error; });
      }
    } else if (operation === "check-update") {
      const update = await checkPiUpdate();
      await atomicJson(join(directory, "pi-update.json"), update);
    } else if (operation !== "status") {
      throw new PiConfigError("Unsupported pi settings operation.");
    }
    return status();
  }
  return { execute, status };
}

export async function checkPiUpdate(fetcher = fetch) {
  const checkedAt = new Date().toISOString();
  try {
    const response = await fetcher("https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest", {
      signal: AbortSignal.timeout(8000), redirect: "error", headers: { accept: "application/json" },
    });
    if (!response.ok) throw new PiConfigError("registry request failed");
    const data = await response.json();
    const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/;
    if (data.name !== "@earendil-works/pi-coding-agent" || !versionPattern.test(data.version)) throw new PiConfigError("invalid release metadata");
    const a = data.version.split(".").map(Number); const b = bundledVersion.split(".").map(Number);
    const difference = a.map((n, i) => n - b[i]).find(n => n !== 0) ?? 0;
    return { status: difference > 0 ? "update_available" : difference < 0 ? "ahead" : "up_to_date",
      current: bundledVersion, latest: data.version, checkedAt };
  } catch {
    return { status: "error", current: bundledVersion, checkedAt, message: "Unable to reach the update service. Try again later." };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = "";
  try {
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 65536) throw new PiConfigError("The request is too large."); }
    const result = await createPiSettings().execute(input.trim() ? JSON.parse(input) : {});
    process.stdout.write(JSON.stringify({ ok: true, data: result }));
  } catch (error) {
    // Never include raw SDK/parser diagnostics: those can contain credential values.
    const message = error instanceof PiConfigError
      ? error.message : "Unable to update pi settings. Check file formats and permissions.";
    process.stdout.write(JSON.stringify({ ok: false, error: message }));
    process.exitCode = 1;
  }
}
