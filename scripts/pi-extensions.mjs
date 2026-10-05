import {validateMcp, credentials, usesOAuth} from './pi-mcp.mjs';
export {validateMcp, configuredMcp} from './pi-mcp.mjs';
import { mkdir, readFile, writeFile, rename, rm, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = pathToFileURL(join(root, "packages/acp/node_modules/@earendil-works/pi-coding-agent/dist/index.js"));
const { DefaultPackageManager, SettingsManager, parseFrontmatter } = await import(entry.href);
const { FileSettingsStorage } = await import(new URL("core/settings-manager.js", entry).href);
const lockfile = createRequire(entry)("proper-lockfile");
const revisionOf = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sourceOf = value => typeof value === "string" ? value : value.source;
const readJson = async (path, fallback) => {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw new Error(`Invalid ${basename(path)}. It was not changed.`); }
};
const atomic = async (path, data) => {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(data, null, 2) + "\n", {mode: 0o600}); await rename(temp, path); }
  finally { await rm(temp, {force: true}); }
};
const npmName = source => {
  const name = source.replace(/^npm:/, "");
  if (!/^(@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9.*^~<>=| -]+)?$/.test(name)) throw new Error("Enter an npm package name or an absolute local package path.");
  return name;
};

export function createExtensionCenter(directory = join(root, ".local/eido"), fetcher = fetch) {
  const queuePath = join(directory, "package-changes.json"), leases = join(directory, "runtimes");
  const settings = () => {
    const manager = SettingsManager.create(directory, directory, {projectTrusted: false});
    if (manager.drainErrors().length) throw new Error("Fix pi settings.json before managing extensions.");
    return manager;
  };
  const manager = s => new DefaultPackageManager({cwd: directory, agentDir: directory, settingsManager: s});
  const configured = () => readJson(join(directory, "settings.json"), {});
  const mutateSettings = fn => new FileSettingsStorage(directory, directory).withLock("global", raw => JSON.stringify(fn(raw ? JSON.parse(raw) : {}), null, 2) + "\n");
  async function locked(fn, wait = false) {
    await mkdir(directory, {recursive: true, mode: 0o700});
    const lockPath = join(directory, ".extensions.lock");
    // pi's lock implementation refreshes live operations and recovers crashed owners.
    const release = await lockfile.lock(lockPath, {realpath: false, stale: 10_000, retries: wait ? {retries: 60, minTimeout: 250, maxTimeout: 250, factor: 1} : 0})
      .catch(() => {throw new Error("Another extension operation is running. Try again when it finishes.");});
    try { return await fn(); } finally {await release();}
  }
  async function activeRuntimes() {
    const active = [];
    for (const name of await readdir(leases).catch(e => {if (e.code === "ENOENT") return []; throw e;})) {
      if (!/^\d+\.json$/.test(name)) continue;
      const pid = Number(name.slice(0, -5));
      try { process.kill(pid, 0); active.push(pid); }
      catch (error) { if (error.code === "ESRCH") await rm(join(leases, name), {force: true}); else active.push(pid); }
    }
    return active;
  }
  async function status() {
    const s = settings(), pm = manager(s), config = await configured();
    // Inspection never installs missing packages or contacts git remotes.
    const paths = await pm.resolve(async () => "skip");
    const disabled = config.eido?.disabledPackages ?? {};
    const packages = s.getPackages().map(pkg => {
      const source = sourceOf(pkg), installedPath = pm.getInstalledPath(source, "user");
      return {source, name: source.replace(/^npm:/, ""), enabled: !(source in disabled), installed: !!installedPath, path: installedPath ?? ""};
    });
    for (const pkg of packages) {
      if (pkg.path) {const manifest = await readJson(join(pkg.path, "package.json"), {}); pkg.name = manifest.name ?? pkg.name; pkg.version = manifest.version ?? "local"; pkg.description = manifest.description ?? "";}
    }
    const resources = async kind => Promise.all(paths[kind].filter(p => p.metadata.scope === "user").map(async p => {
      let name = basename(p.path), description = "";
      if (kind === "skills") {try {const {frontmatter} = parseFrontmatter(await readFile(p.path, "utf8")); name = frontmatter.name || basename(dirname(p.path)); description = frontmatter.description || "";} catch {description = "Unable to read skill metadata.";}}
      return {...p, name, description};
    }));
    const mcp = validateMcp(await readJson(join(directory, "mcp.json"), {mcpServers: {}}));
    return {packages, extensions: await resources("extensions"), skills: await resources("skills"),
      mcp: [{name: "eido_browser", enabled: true, builtin: true, detail: "Built-in browser automation"},
        ...Object.entries(mcp.mcpServers).map(([name, s]) => ({name, enabled: s.enabled !== false, builtin: false, oauth: usesOAuth(s), signedIn: usesOAuth(s) && !!credentials(directory).tokens(name, s.url), detail: s.command ? "Local process" : s.type === "sse" ? "SSE server" : "HTTP server"}))],
      pending: await readJson(queuePath, []), activeRuntimes: (await activeRuntimes()).length};
  }
  async function applyPending() {
    if ((await activeRuntimes()).length) return;
    const queue = await readJson(queuePath, []);
    while (queue.length) {
      const request = queue[0], s = settings(), pm = manager(s);
      try {
        if (request.operation === "install") await pm.installAndPersist(request.source);
        else if (request.operation === "update") await pm.update(request.source);
        else if (request.operation === "remove") {
          await pm.removeAndPersist(request.source);
          mutateSettings(c => {if (c.eido?.disabledPackages) delete c.eido.disabledPackages[request.source]; return c;});
        }
        await s.flush();
        if (s.drainErrors().length) throw new Error("pi could not save the package configuration.");
        queue.shift(); await atomic(queuePath, queue);
      } catch {request.error = "Package operation failed. Check the source and network, then retry."; await atomic(queuePath, queue); break;}
    }
  }
  async function search(query) {
    if (typeof query !== "string" || query.trim().length > 160) throw new Error("Enter a package search of at most 160 characters.");
    const url = new URL("https://registry.npmjs.org/-/v1/search");
    url.searchParams.set("text", `keywords:pi-package ${query.trim()}`); url.searchParams.set("size", "30");
    const response = await fetcher(url, {signal: AbortSignal.timeout(15_000)});
    if (!response.ok) throw new Error("Package search is unavailable. Try again later.");
    const result = await response.json();
    return {results: (result.objects ?? []).map(o => o.package).filter(p => p.keywords?.includes("pi-package")).map(p => ({name: p.name, source: `npm:${p.name}`, version: p.version, description: p.description ?? ""}))};
  }
  async function execute(request = {}) {
    const operation = request.operation ?? "status";
    if (operation === "status") return status();
    if (operation === "search") return search(request.query ?? "");
    if (operation === "mcp-read") {
      const value = validateMcp(await readJson(join(directory, "mcp.json"), {mcpServers: {}}));
      return {text: JSON.stringify(value, null, 2), revision: revisionOf(value)};
    }
    return locked(async () => {
      if (["install", "update", "remove"].includes(operation)) {
        let source = request.source;
        if (typeof source !== "string" || source.length > 4096) throw new Error("Choose a package source.");
        if (operation !== "install") {
          const s = settings(), pm = manager(s);
          const existing = s.getPackages().find(p => sourceOf(p) === source || (isAbsolute(source) && pm.getInstalledPath(sourceOf(p), "user") === source));
          if (!existing) throw new Error("This package is not configured.");
          source = sourceOf(existing);
          if (operation === "update" && /^(git:|https?:|git@)/.test(source)) throw new Error("Update GitHub packages manually, then restart Eido.");
        } else if (isAbsolute(source)) {
          const manifest = await readJson(join(source, "package.json"), {});
          if (!manifest.pi) throw new Error("The local folder must contain a pi package manifest.");
          source = resolve(source);
        } else source = `npm:${npmName(source)}`;
        const queue = await readJson(queuePath, []);
        if (!queue.some(item => item.source === source && item.operation === operation)) queue.push({operation, source});
        await atomic(queuePath, queue); await applyPending();
      } else if (operation === "retry") await applyPending();
      else if (operation === "cancel-pending") {
        const queue = await readJson(queuePath, []); await atomic(queuePath, queue.filter(item => item.source !== request.source));
      } else if (operation === "toggle-package") {
        if (typeof request.enabled !== "boolean") throw new Error("Choose enabled or disabled.");
        mutateSettings(c => {
          const i = (c.packages ?? []).findIndex(p => sourceOf(p) === request.source);
          if (i < 0) throw new Error("This package is not configured.");
          c.eido ??= {}; c.eido.disabledPackages ??= {};
          if (request.enabled) {
            if (request.source in c.eido.disabledPackages) {c.packages[i] = c.eido.disabledPackages[request.source]; delete c.eido.disabledPackages[request.source];}
          } else if (!(request.source in c.eido.disabledPackages)) {
            c.eido.disabledPackages[request.source] = c.packages[i];
            c.packages[i] = {source: request.source, autoload: false};
          }
          return c;
        });
      } else if (operation === "toggle-resource") {
        const kind = request.kind;
        if (!["skills", "extensions"].includes(kind) || typeof request.enabled !== "boolean") throw new Error("Choose an installed resource.");
        const s = settings(), pm = manager(s), paths = await pm.resolve(async () => "skip");
        const resource = paths[kind].find(p => p.path === request.path && p.metadata.scope === "user");
        if (!resource) throw new Error("This resource is no longer installed.");
        mutateSettings(c => {
          if (resource.metadata.origin === "package") {
            const i = (c.packages ?? []).findIndex(p => sourceOf(p) === resource.metadata.source);
            if (i < 0 || c.eido?.disabledPackages?.[resource.metadata.source]) throw new Error("Enable the owning package first.");
            const p = typeof c.packages[i] === "string" ? {source: c.packages[i]} : c.packages[i];
            const file = relative(resource.metadata.packageRoot, resource.path).split("\\").join("/");
            p[kind] = [...(p[kind] ?? []).filter(v => ![file, `+${file}`, `-${file}`, `!${file}`].includes(v)), `${request.enabled ? "+" : "-"}${file}`];
            c.packages[i] = p;
          } else c[kind] = [...(c[kind] ?? []).filter(v => ![`+${request.path}`, `-${request.path}`, `!${request.path}`].includes(v)), `${request.enabled ? "+" : "-"}${request.path}`];
          return c;
        });
      } else if (operation === "mcp-save") {
        const value = validateMcp(JSON.parse(request.text));
        const current = validateMcp(await readJson(join(directory, "mcp.json"), {mcpServers: {}}));
        if (request.revision !== undefined && request.revision !== revisionOf(current)) throw new Error("MCP configuration changed. Reopen the editor before saving again.");
        await atomic(join(directory, "mcp.json"), value);
      } else if (["mcp-toggle", "mcp-remove", "mcp-signout"].includes(operation)) {
        const value = validateMcp(await readJson(join(directory, "mcp.json"), {mcpServers: {}}));
        if (!value.mcpServers[request.name]) throw new Error("This MCP server is not configured.");
        if (operation === "mcp-signout" || operation === "mcp-remove") {
          const server = value.mcpServers[request.name];
          if (server.url) {
            const store = credentials(directory);
            await store.forServer(request.name,server.url).withRefreshLock(async()=>store.remove(request.name,server.url));
          }
          if (operation === "mcp-remove") delete value.mcpServers[request.name];
        }
        else {if (typeof request.enabled !== "boolean") throw new Error("Choose enabled or disabled."); value.mcpServers[request.name].enabled = request.enabled;}
        await atomic(join(directory, "mcp.json"), value);
      } else throw new Error("Unsupported extension operation.");
      return status();
    });
  }
  return {execute, async acquireRuntime() {
    return locked(async () => {
      await applyPending(); await mkdir(leases, {recursive: true, mode: 0o700});
      const path = join(leases, `${process.pid}.json`); await atomic(path, {startedAt: new Date().toISOString()});
      return () => rm(path, {force: true});
    }, true);
  }};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {takeOverStdout, writeRawStdout, flushRawStdout} = await import(new URL("core/output-guard.js", entry).href);
  takeOverStdout();
  try {
    let text = ""; for await (const part of process.stdin) {text += part; if (text.length > 1_000_000) throw new Error("Request is too large.");}
    const data = await createExtensionCenter().execute(text ? JSON.parse(text) : {});
    writeRawStdout(JSON.stringify({ok: true, data}));
  } catch (error) {writeRawStdout(JSON.stringify({ok: false, error: error.message})); process.exitCode = 1;}
  await flushRawStdout();
}
