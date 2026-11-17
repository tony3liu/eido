import {cp, mkdir, readFile, writeFile, rename, rm, readdir, symlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runtimeRoot} from '../../packages/runtime/src/paths.mjs';

export async function prepareOneCode(output = join(runtimeRoot, '.local/one-code-runtime'), development = true) {
  const source = join(runtimeRoot, 'packages/acp/node_modules/one-code-extension');
  const own = join(runtimeRoot, 'packages/acp/one-code');
  const manifest = JSON.parse(await readFile(join(own, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  if (pkg.version !== manifest.upstreamVersion || JSON.stringify(pkg.pi.extensions) !== JSON.stringify(manifest.entries.map(item => item.entry))) throw Error('One Code manifest changed; review compatibility before building.');
  for (const [path, hash] of Object.entries(manifest.hashes)) {
    if (createHash('sha256').update(await readFile(join(source, path))).digest('hex') !== hash) throw Error(`One Code upstream file changed: ${path}`);
  }
  const profileEntries = (await readdir(join(source, 'profile/extensions')).catch(error => {if(error.code === 'ENOENT') return []; throw error;}));
  if (JSON.stringify(profileEntries.sort()) !== JSON.stringify(manifest.profileExtensions)) throw Error('Unknown One Code product extension.');
  const lock = JSON.parse(await readFile(join(runtimeRoot, 'packages/acp/package-lock.json'), 'utf8'));
  const integrity = lock.packages['node_modules/one-code-extension'].integrity;
  const temporary = `${output}.prepare-${process.pid}`;
  await rm(temporary, {recursive: true, force: true});
  await mkdir(temporary, {recursive: true});
  try {
    for (const name of ['extensions', 'profile', 'package.json', 'LICENSE', 'docs/guide']) await cp(join(source, name), join(temporary, name), {recursive: true});
    await rename(join(temporary, 'profile/index.ts'), join(temporary, 'profile/upstream-profile.ts'));
    await rename(join(temporary, 'profile/brand.json'), join(temporary, 'profile/upstream-brand.json'));
    for (const [from, to] of [['profile.ts.template', 'profile/index.ts'], ['brand.json', 'profile/brand.json'], ['sources.ts.template', 'profile/eido-sources.ts'], ['search.ts.template', 'eido/search.ts'], ['wire.ts.template', 'eido/wire.ts'], ['resources.ts.template', 'eido/resources.ts']]) {
      await mkdir(join(temporary, to, '..'), {recursive: true});
      await cp(join(own, from), join(temporary, to));
    }
    const hiddenSkills = (await readdir(join(temporary, 'profile/skills'))).filter(name => !manifest.skills.includes(name));
    for (const name of hiddenSkills) await rm(join(temporary, 'profile/skills', name), {recursive: true, force: true});
    const review = join(temporary, 'profile/skills/code-review');
    await rm(join(review, 'cells'), {recursive: true, force: true});
    await mkdir(join(review, 'cells'));
    const body = 'Review the requested changes using the available Eido read, find, grep and editor tools. Identify actionable correctness, security and regression issues with file and line evidence. Use the native subagent tool for independent investigations only when it is available and delegation is authorized; otherwise review sequentially. Verify suspected issues before reporting. Do not modify code unless asked.\n';
    await writeFile(join(review, 'cells/eido.md'), body);
    await writeFile(join(review, 'cells/table.json'), JSON.stringify({tables: {default: Object.fromEntries(['low','medium','high','xhigh','max'].map(level => [level, 'eido']))}}));
    await writeFile(join(review, 'SKILL.md'), '---\nname: code-review\ndescription: Review code changes for actionable correctness and regression issues using Eido tools.\n---\n'+body);
    const replacements = {'extensions/request/tool-search/index.ts': 'eido/search.ts', 'extensions/request/ledger/wire.ts': 'eido/wire.ts', 'extensions/commands/resources/index.ts': 'eido/resources.ts'};
    const entries = manifest.entries.filter(item => item.mode === 'upstream').map(item => replacements[item.entry] ?? item.entry);
    const overrides = ['profile/index.ts', 'profile/brand.json', 'profile/eido-sources.ts', 'eido/search.ts', 'eido/wire.ts', 'eido/resources.ts', 'profile/skills/code-review/SKILL.md', 'profile/skills/code-review/cells/eido.md', 'profile/skills/code-review/cells/table.json'];
    const overrideHashes = Object.fromEntries(await Promise.all(overrides.map(async path => [path, createHash('sha256').update(await readFile(join(temporary,path))).digest('hex')])));
    const generated = {...manifest, integrity, entryDecisions: manifest.entries, entries, overrideHashes, compatibility: 'Eido compatible subset', hiddenSkills};
    await writeFile(join(temporary, 'eido-manifest.json'), JSON.stringify(generated, null, 2)+'\n');
    if (development) await symlink(join(runtimeRoot, 'packages/acp/node_modules'), join(temporary, 'node_modules'));
    await rm(output, {recursive: true, force: true});
    await rename(temporary, output);
    return generated;
  } finally {await rm(temporary, {recursive: true, force: true});}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await prepareOneCode(process.argv[2], !process.argv.includes('--production'));
  console.log(`Prepared One Code ${result.upstreamVersion} / Eido compatibility ${result.compatibilityRevision}`);
}
