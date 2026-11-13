import {execFile} from 'node:child_process';
import {access, readFile, realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {promisify} from 'node:util';

const run = promisify(execFile);
function absolute(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Choose an absolute ${label} path.`);
  const path = value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
  if (!isAbsolute(path)) throw new Error(`Choose an absolute ${label} path.`);
  return path;
}

// Poki remains an independently installed MCP service. Never import its source,
// start its daemon, change approvals, or select a phone while adding the entry.
export async function pokiConfiguration({source, node = process.execPath, stateDirectory} = {}) {
  const directory = await realpath(absolute(source, 'Poki folder'))
    .catch(() => {throw new Error('Poki folder not found. Install Poki before connecting it.');});
  const command = await realpath(absolute(node, 'Node.js executable'))
    .catch(() => {throw new Error('Node.js executable not found. Choose Node.js 24 or newer.');});
  const entry = join(directory, 'src/stdio.mjs'), skill = join(directory, 'skills/poki-mcp/SKILL.md');
  try {
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (manifest.name !== 'poki-mcp') throw new Error('Not Poki');
    await access(entry);
    await access(skill);
  } catch {throw new Error('Choose a Poki installation containing src/stdio.mjs and skills/poki-mcp/SKILL.md.');}
  let version;
  try {version = (await run(command, ['--version'], {timeout: 5_000, maxBuffer: 4096})).stdout.trim();}
  catch {throw new Error('Unable to run the selected Node.js executable.');}
  if (!/^v\d+\.\d+\.\d+$/.test(version) || Number(version.slice(1).split('.')[0]) < 24) {
    throw new Error('Poki requires Node.js 24 or newer. Choose a newer Node.js executable; Eido can keep its bundled runtime.');
  }
  return {skill, server: {
    command, args: [entry], cwd: directory,
    env: {POKI_MCP_TOOLS: 'all', ...(stateDirectory ? {POKI_MCP_STATE_DIR: absolute(stateDirectory, 'Poki state directory')} : {})},
    timeout: 900, exposure: 'codemode', description: 'Poki iPhone and iOS Simulator automation',
  }};
}
