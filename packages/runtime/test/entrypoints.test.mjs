import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('native process entry points share global state from an unrelated working directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'eido-runtime-entrypoints-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const directory = join(root, 'global'), cwd = join(root, 'project');
  await mkdir(directory); await mkdir(cwd);
  await writeFile(join(directory, 'settings.json'), JSON.stringify({customSetting: 'preserved'}));
  const run = (name, input, code = 0) => {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL(`../bin/${name}.mjs`, import.meta.url))], {
      cwd, env: {...process.env, EIDO_PI_CONFIG_DIR: directory},
      input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 20_000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, code, child.stderr);
    return JSON.parse(child.stdout);
  };
  assert.deepEqual(run('pi-settings', {operation: 'access', fullAccess: true}), {ok: true, data: {fullAccess: true}});
  const status = run('pi-settings', {operation: 'status'});
  assert.equal(status.data.directory, directory);
  assert.equal(status.data.fullAccess, true);
  const extensions = run('pi-extensions', {});
  assert.equal(extensions.ok, true);
  assert.deepEqual(extensions.data.packages, []);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')),
    {customSetting: 'preserved', eido: {fullAccess: true}});
  const malformed = run('pi-settings', '{"secret":"must-not-echo"', 1);
  assert.equal(malformed.ok, false);
  assert.doesNotMatch(JSON.stringify(malformed), /must-not-echo/);
  assert.equal(run('pi-extensions', {operation: 'unsupported'}, 1).ok, false);
});
