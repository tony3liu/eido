import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, writeFile, readFile, rm, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createExtensionCenter, configuredMcp} from '../../src/pi/extensions.mjs';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'eido poki ')));
  const source = join(root, 'Poki'), directory = join(root, 'pi'), node = join(root, 'node 24');
  await mkdir(join(source, 'src'), {recursive: true});
  await mkdir(join(source, 'skills/poki-mcp'), {recursive: true});
  await mkdir(directory);
  await writeFile(join(source, 'package.json'), JSON.stringify({name: 'poki-mcp'}));
  await writeFile(join(source, 'src/stdio.mjs'), 'throw new Error("Registration must not launch Poki");');
  const skill = join(source, 'skills/poki-mcp/SKILL.md');
  await writeFile(skill, '---\nname: poki-mcp\ndescription: Phone skill fixture\n---\nPhone instructions.\n');
  const version = async value => writeFile(node, `#!/bin/sh\n[ "$#" -eq 1 ] && [ "$1" = '--version' ] || exit 2\nprintf '%s\\n' '${value}'\n`, {mode: 0o700});
  await version('v24.0.0');
  return {root, directory, source, node, skill, version, center: createExtensionCenter(directory),
    request: {operation: 'mcp-poki', source, node, stateDirectory: join(root, 'private state')},
    close: () => rm(root, {recursive: true, force: true})};
}

test('Poki registration uses global MCP and pi skills, preserves other configuration, and is idempotent', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, 'settings.json'), JSON.stringify({defaultThinkingLevel: 'high', eido: {fullAccess: false}, skills: ['!/other/skill']}));
    await f.center.execute({operation: 'mcp-save', text: JSON.stringify({autoEnableCodemode: true, mcpServers: {other: {command: 'other', env: {KEY: 'private-marker'}}}})});
    const status = await f.center.execute(f.request);
    assert.equal(status.mcp.find(s => s.name === 'poki-mcp').enabled, true);
    assert.equal(status.skills.find(s => s.name === 'poki-mcp').enabled, true);
    assert.doesNotMatch(JSON.stringify(status), /private-marker/);
    const [server] = (await configuredMcp(f.directory)).filter(s => s.name === 'poki-mcp');
    const options = server[Symbol.for('eido.pi.mcp.options')];
    assert.equal(server.command, f.node);
    assert.deepEqual(server.args, [join(f.source, 'src/stdio.mjs')]);
    assert.deepEqual(Object.fromEntries(server.env.map(({name, value}) => [name, value])), {POKI_MCP_TOOLS: 'all', POKI_MCP_STATE_DIR: f.request.stateDirectory});
    assert.equal(options.timeoutMs, 900_000);
    assert.equal(options.cwd, f.source);
    assert.equal(options.config.exposure, 'codemode');
    await f.center.execute(f.request);
    const settings = JSON.parse(await readFile(join(f.directory, 'settings.json'), 'utf8'));
    assert.deepEqual(settings, {defaultThinkingLevel: 'high', eido: {fullAccess: false}, skills: ['!/other/skill', f.skill]});
    const config = JSON.parse(await readFile(join(f.directory, 'mcp.json'), 'utf8'));
    assert.equal(config.mcpServers.other.env.KEY, 'private-marker');
    await f.center.execute({operation: 'mcp-toggle', name: 'poki-mcp', enabled: false});
    await assert.rejects(f.center.execute(f.request), /already configured/);
    assert.ok(!(await configuredMcp(f.directory)).some(s => s.name === 'poki-mcp'));
  } finally {await f.close();}
});

test('Poki rejects missing files, unsupported Node and invalid paths without changing global configuration', async () => {
  const f = await fixture();
  try {
    const settings = JSON.stringify({eido: {fullAccess: true}});
    await writeFile(join(f.directory, 'settings.json'), settings);
    await assert.rejects(f.center.execute({...f.request, source: 'relative'}), /absolute/);
    await assert.rejects(f.center.execute({...f.request, stateDirectory: 'relative'}), /absolute/);
    await assert.rejects(f.center.execute({...f.request, node: '/missing/node'}), /not found/);
    await f.version('v22.23.2');
    await assert.rejects(f.center.execute(f.request), /Node.js 24/);
    await f.version('not-node');
    await assert.rejects(f.center.execute(f.request), /Node.js 24/);
    await f.version('v24.0.0');
    await rm(f.skill);
    await assert.rejects(f.center.execute(f.request), /installation containing/);
    assert.equal(await readFile(join(f.directory, 'settings.json'), 'utf8'), settings);
    await assert.rejects(readFile(join(f.directory, 'mcp.json')), {code: 'ENOENT'});
  } finally {await f.close();}
});

test('Poki registration retains explicit skill disablement', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, 'settings.json'), JSON.stringify({skills: [`!${f.skill}`]}));
    const state = await f.center.execute(f.request);
    assert.notEqual(state.skills.find(s => s.name === 'poki-mcp')?.enabled, true);
    assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'settings.json'), 'utf8')).skills, [`!${f.skill}`]);
  } finally {await f.close();}
});
