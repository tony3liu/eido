import {existsSync, readFileSync, realpathSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {runtimeRoot, piDirectory} from '../paths.mjs';

export const ONE_CODE_ID = 'builtin:one-code-extension';
const oneCodePath = root => join(root, existsSync(join(root, 'eido-runtime.json')) ? 'packages/acp/bundled/one-code' : '.local/one-code-runtime');

function oneCodeEnabled(settings, directory, root) {
  const configured = settings.eido?.builtinPackages?.oneCode?.enabled;
  if (typeof configured === 'boolean') return configured;
  // Inherit the existing center's disabled-package choice until the user
  // explicitly sets the new built-in toggle. Never rewrite the old record.
  const matches = source => isOneCodeSource(source, directory, root);
  return !(settings.packages ?? []).some(pkg => pkg?.autoload === false && matches(pkg))
    && !Object.entries(settings.eido?.disabledPackages ?? {}).some(([source, pkg]) => matches(source) || matches(pkg));
}

export function oneCodeDescriptor(settings = {}, root = runtimeRoot, directory = piDirectory(root)) {
  const path = oneCodePath(root);
  let manifest, error;
  try {
    manifest = JSON.parse(readFileSync(join(path, 'eido-manifest.json'), 'utf8'));
    if (manifest.upstreamVersion !== '0.8.0' || manifest.compatibilityRevision !== 1 || !manifest.entries.every(entry => existsSync(join(path, entry)))) throw Error('Invalid bundled compatibility runtime');
  } catch {error = 'Bundled One Code runtime is unavailable. Rebuild or reinstall Eido.';}
  return {source: ONE_CODE_ID, name: 'One Code', builtin: true, version: '0.8.0', compatibility: 'Eido compatible subset · r1',
    description: 'Prompt, context, tool search and Claude user skills. Native Eido tools, permissions and models.',
    enabled: oneCodeEnabled(settings, directory, root), installed: !error, path,
    entries: manifest?.entries ?? [], ...(error ? {error} : {})};
}
export function isOneCodeSource(value, directory, root = runtimeRoot) {
  let source = typeof value === 'string' ? value : value?.source;
  if (typeof source !== 'string') return false;
  source = source.trim().replace(/^[!+-]/, '');
  if (source === ONE_CODE_ID || /^npm:one-code-extension(?:@.*)?$/.test(source)) return true;
  // pi treats bare names and relative paths as local; only these package,
  // built-in and remote schemes are non-local (pi utils/paths.isLocalPath).
  if (/^(npm|git|github|http|https|ssh|builtin):/.test(source)) return false;
  if (source === '~') source = homedir();
  else if (source.startsWith('~/')) source = join(homedir(), source.slice(2));
  let path;
  try {
    if (source.startsWith('file://')) source = fileURLToPath(source);
    path = realpathSync(resolve(directory, source));
  } catch {return false;}
  const bundled = oneCodePath(root);
  if (path === bundled || path.startsWith(`${bundled}/`)) return true;
  for (let current = path; current !== dirname(current); current = dirname(current)) {
    try {if (JSON.parse(readFileSync(join(current, 'package.json'), 'utf8')).name === 'one-code-extension') return true;} catch {}
  }
  return false;
}
export function oneCodeSettingsView(manager, directory, cwd = directory) {
  const global = manager.getGlobalSettings.bind(manager), project = manager.getProjectSettings.bind(manager);
  const clean = (value, base) => ({...value,
    packages: (value.packages ?? []).filter(item => !isOneCodeSource(item, base)),
    extensions: (value.extensions ?? []).filter(item => !isOneCodeSource(item, base))});
  manager.getGlobalSettings = () => {
    const original = global(), result = clean(original, directory), builtin = oneCodeDescriptor(original, runtimeRoot, directory);
    if (builtin.enabled) {
      if (builtin.error) throw Error(builtin.error);
      const searchDisabled = original.disabledBuiltinExtensions?.includes('tool-search') || original.extensions?.some(entry => ['-builtin:tool-search', '!builtin:tool-search'].includes(entry));
      result.extensions = [...result.extensions, '!builtin:tool-search', ...builtin.entries.filter(entry => !searchDisabled || entry !== 'eido/search.ts').map(entry => join(builtin.path, entry))];
    }
    return result;
  };
  // pi resolves user entries from agentDir and project entries from cwd/.pi.
  // This does not grant project trust; the manager still owns that decision.
  manager.getProjectSettings = () => clean(project(), join(cwd, '.pi'));
  return () => oneCodeDescriptor(global(), runtimeRoot, directory);
}
export function isOneCodeSearch(path) {
  return path === join(oneCodeDescriptor().path, 'eido/search.ts');
}

export async function recordOneCodeLoad(directory, sessionId, descriptor, errors = []) {
  const {mkdir, writeFile, rename, rm} = await import('node:fs/promises');
  const {createHash} = await import('node:crypto');
  const folder = join(directory, 'one-code/runtime-status');
  const path = join(folder, `${process.pid}-${createHash('sha256').update(sessionId).digest('hex')}.json`);
  await mkdir(folder, {recursive:true, mode:0o700});
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify({pid:process.pid, sessionId, enabled:descriptor.enabled,
    loaded:descriptor.enabled && errors.length === 0, error:errors.length ? 'One Code extension loading failed' : undefined}), {mode:0o600});
  await rename(temporary,path);
  return () => errors.length ? Promise.resolve() : rm(path,{force:true});
}
export async function oneCodeLoads(directory) {
  const {readdir, readFile} = await import('node:fs/promises');
  const folder = join(directory, 'one-code/runtime-status'), results = [];
  for(const name of await readdir(folder).catch(error => {if(error.code==='ENOENT')return [];throw error;})) {
    if(!/^\d+-[a-f0-9]{64}\.json$/.test(name))continue;
    try {const entry=JSON.parse(await readFile(join(folder,name),'utf8'));process.kill(entry.pid,0);results.push(entry);} catch {}
  }
  return results;
}
