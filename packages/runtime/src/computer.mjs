import {access, readFile, stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {delimiter, isAbsolute, join} from 'node:path';
import {homedir} from 'node:os';
import {runtimeRoot} from './paths.mjs';

export async function computerSettings(directory, env = process.env, root = runtimeRoot) {
  const raw = await readFile(join(directory, 'settings.json'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '{}'; throw error;
  });
  const config = JSON.parse(raw).eido?.computerUse ?? {};
  const configured = typeof config.path === 'string' ? config.path : '';
  const bundled = join(root, '../../Helpers/cua-driver-local');
  const candidates = configured ? [configured] : [
    bundled,
    ...String(env.PATH ?? '').split(delimiter).filter(Boolean).map(path => join(path, 'cua-driver')),
    join(homedir(), '.local/bin/cua-driver'), '/opt/homebrew/bin/cua-driver', '/usr/local/bin/cua-driver',
  ];
  let executable;
  for (const path of candidates) {
    if (!isAbsolute(path)) continue;
    if (await access(path, constants.X_OK).then(() => stat(path).then(info => info.isFile()), () => false).catch(() => false)) {executable = path; break;}
  }
  return {enabled: config.enabled === true, path: configured, executable: executable ?? null,
    status: !executable ? 'not_installed' : config.enabled !== true ? 'disabled' : 'configured',
    message: !executable ? 'Cua Driver is not installed or its executable path is unavailable.'
      : config.enabled !== true ? 'Computer Use is disabled.'
      : executable === bundled ? 'Eido’s bundled Computer Use driver is configured. Grant Eido Accessibility and Screen Recording access in macOS; connection and tool availability are shown in Extensions.'
      : 'Cua Driver is configured. macOS Accessibility and Screen Recording permissions are required; connection and tool availability are shown in Extensions.'};
}

export async function computerMcp(directory, root = runtimeRoot) {
  const config = await computerSettings(directory, process.env, root);
  const bundled = config.executable === join(root, '../../Helpers/cua-driver-local');
  return config.enabled && config.executable
    ? [{name: 'eido_computer', command: config.executable, args: bundled ? ['mcp', '--direct'] : ['mcp'],
      env: bundled ? [{name:'CUA_DRIVER_EMBEDDED',value:'1'}, {name:'CUA_DRIVER_HOST_BUNDLE_ID',value:'dev.eido.app'}] : []}] : [];
}
