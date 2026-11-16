import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,readFile,writeFile,stat,symlink,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {ResearchStore,sha256} from '../src/research/store.mjs';

async function fixture(t,sessionId='task-one') {
  const directory=await mkdtemp(join(tmpdir(),'eido-research-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return {directory,store:new ResearchStore({directory,sessionId,workspaceIdentity:'fixture'})};
}
test('immutable source versions, UTF-8 byte citations and bounded pagination survive reopening',async t=>{
  const {directory,store}=await fixture(t);
  const first=await store.addSource({kind:'web',canonicalUrl:'https://example.com'},{body:'资料 α text'});
  const second=await store.addSource({kind:'web',sourceId:first.sourceId,parentVersionId:first.versionId},{body:'资料 α text'});
  assert.notEqual(first.versionId,second.versionId); assert.equal(first.bodyHash,second.bodyHash);
  assert.equal((await stat(join(store.path,'manifest.json'))).mode&0o777,0o600);
  assert.equal((await stat(store.path)).mode&0o777,0o700);
  const reopened=new ResearchStore({directory,sessionId:'task-one'});
  const cite=await reopened.cite(first.versionId,'资料',[0,6]);
  assert.equal(cite.matchState,'exact'); assert.deepEqual(cite.range,[0,6]);
  await assert.rejects(reopened.cite(first.versionId,'资料',[1,6]),/UTF-8/);
  assert.equal((await reopened.cite(first.versionId,'different')).matchState,'unmatched');
  const page=await reopened.read(first.versionId,0,7); assert.equal(page.text,'资料 '); assert.equal(page.next,7);
  await assert.rejects(reopened.read(first.versionId,1),/UTF-8/);
  const duplicate=await store.addSource({kind:'web'},{body:'same same'});
  assert.equal((await store.cite(duplicate.versionId,'same')).matchState,'ambiguous');
  const summary=await store.addSource({kind:'search_summary',readState:'summary_only'},{body:'headline'});
  assert.equal((await store.cite(summary.versionId,'headline')).matchState,'summary_only');
});
test('CAS rejects concurrent stale updates and deletion tombstones block late results',async t=>{
  const {store}=await fixture(t);
  const operation=await store.beginOperation({operationId:'op',turnId:'turn',kind:'fetch'});
  const source=await store.addSource({kind:'web'},{body:'original',operationId:'op',generation:operation.generation});
  const revision=(await store.manifest()).revision;
  await store.mutate(manifest=>manifest.requirements.push({requirementId:'r'}),{expectedRevision:revision});
  await assert.rejects(store.mutate(()=>{}, {expectedRevision:revision}),/changed/);
  await store.deleteSources([source.versionId],(await store.manifest()).revision);
  await assert.rejects(store.addSource({kind:'web'},{body:'late',operationId:'op',generation:operation.generation}),/no longer active/);
  await assert.rejects(store.source(source.versionId),/Local source deleted/);
  assert.deepEqual(await readdir(join(store.path,'objects')),[]);
});
test('task copies own physical bytes and deleting one version preserves siblings and original files',async t=>{
  const {directory,store}=await fixture(t);
  const original=join(directory,'original.pdf'); await writeFile(original,'original file');
  const source=await store.addSource({kind:'document',originalName:'original.pdf'},{raw:await readFile(original),body:'body'});
  const sibling=await store.addSource({kind:'web'},{body:'body'});
  const target=new ResearchStore({directory,sessionId:'task-two'}); await store.copyTo(target);
  assert.notEqual((await stat(join(store.path,'objects',source.bodyHash))).ino,(await stat(join(target.path,'objects',source.bodyHash))).ino);
  await store.deleteSources([source.versionId],(await store.manifest()).revision);
  assert.equal((await store.read(sibling.versionId)).text,'body');
  assert.equal((await target.read(source.versionId)).text,'body');
  assert.equal((await readFile(original)).toString(),'original file');
  await assert.rejects(store.source('other-task-source'),/unavailable/);
});
test('recovery preserves committed receipts, marks unknown dispatch and refuses corrupted or linked records',async t=>{
  const {directory,store}=await fixture(t);
  await store.beginOperation({operationId:'op',turnId:'turn',kind:'ocr'});
  await store.setOperation('op',{status:'dispatched'});
  const recovered=await new ResearchStore({directory,sessionId:'task-one'}).recover();
  assert.equal(recovered[0].status,'interrupted_unknown'); assert.equal(recovered[0].receipt,'pending');
  await store.setOperation('op',{receipt:'recorded'}); assert.equal((await store.recover()).length,0);
  await writeFile(join(store.path,'manifest.json'),'{bad json');
  await assert.rejects(store.manifest(),/preserved/);
  assert.equal((await readFile(join(store.path,'manifest.json'))).toString(),'{bad json');
  const linked=new ResearchStore({directory,sessionId:'linked'}); await linked.manifest();
  await symlink(join(store.path,'manifest.json'),join(linked.path,'objects'));
  await assert.rejects(linked.putObject('secret'),/symbolic links/);
  await assert.rejects(linked.object('../original.pdf'),/Invalid Research object/);
});
test('a process dying between object write and manifest commit leaves no fabricated source',async t=>{
  const {directory,store}=await fixture(t);
  const source=await store.addSource({kind:'web'},{body:'keep'});
  const url=new URL('../src/research/store.mjs',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`import {ResearchStore} from ${JSON.stringify(url)}; const store=new ResearchStore({directory:process.argv[1],sessionId:'task-one'}); await store.mutate(async manifest=>{await store.putObject('uncommitted'); process.exit(0);});`,directory],{stdio:'pipe'});
  await new Promise((resolve,reject)=>{child.once('exit',code=>code===0?resolve():reject(new Error('Crash fixture failed')));child.once('error',reject);});
  const receipts=await store.recover(); assert.equal(receipts.length,0);
  assert.equal((await store.read(source.versionId)).text,'keep');
  assert.deepEqual(await readdir(join(store.path,'objects')),[source.bodyHash]);
  assert.equal((await store.manifest()).sources.length,1);
});
