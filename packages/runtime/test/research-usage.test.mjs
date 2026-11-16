import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {ResearchUsage} from '../src/research/usage.mjs';
import {researchConfig} from '../src/research/config.mjs';

async function fixture(t,limits={}) {
  const directory=await mkdtemp(join(tmpdir(),'eido-usage-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const config=researchConfig({eido:{research:{schemaVersion:1,enabled:true,revision:1,limits}}});
  await writeFile(join(directory,'settings.json'),JSON.stringify({eido:{research:config}}));
  return {directory,usage:new ResearchUsage(directory),config};
}
const args=(id,kind='search')=>({operationId:id,attemptId:id,turnId:'turn',ownerSession:'task',kind});
test('global budget reservations are atomic, retries count, receipts are idempotent and currencies stay distinct',async t=>{
  const {directory,usage}=await fixture(t,{attempts24h:2,httpConcurrency:2});
  const results=await Promise.allSettled(Array.from({length:8},(_,index)=>new ResearchUsage(directory).reserve(args(String(index)))));
  assert.equal(results.filter(item=>item.status==='fulfilled').length,2);
  const attempts=results.filter(item=>item.status==='fulfilled').map(item=>item.value);
  for(const attempt of attempts) {
    await usage.dispatch(attempt.attemptId);
    await usage.settle(attempt.attemptId,{status:'complete',billable:true});
    await usage.settle(attempt.attemptId,{status:'complete',billable:true});
  }
  const summary=(await usage.summary('task')).global;
  assert.equal(summary.attempts,2); assert.equal(summary.estimatedCny,0.01); assert.equal(summary.currency,'CNY'); assert.equal(summary.remaining.attempts24h,0);
  assert.equal((await usage.reserve(args(attempts[0].attemptId))).attemptId,attempts[0].attemptId);
  await assert.rejects(usage.reserve({...args('new'),turnId:'next'}),/24-hour request limit/);
});
test('unknown OCR retains its page, upload and concurrency reservation and is never automatically retried',async t=>{
  const {usage}=await fixture(t);
  await usage.reserve({...args('ocr','ocr'),uploadBytes:1234,originalBytes:4000});
  await usage.dispatch('ocr'); await usage.settle('ocr',{status:'interrupted_unknown',billingUnknown:true});
  await assert.rejects(usage.reserve(args('second','ocr')),/Concurrent OCR limit/);
  const summary=(await usage.summary('task')).task;
  assert.equal(summary.unknown,1); assert.equal(summary.unknownMaximumCny,0.0015);
  assert.equal(summary.uploadedBytes,1234); assert.equal(summary.originalBytes,4000); assert.equal(summary.ocrPages,1);
  assert.equal(summary.estimatedCny,0);
});
test('cancelled queued requests release limits; lowering configuration blocks subsequent reservations',async t=>{
  const {directory,usage,config}=await fixture(t,{attempts24h:1});
  await usage.reserve(args('queued')); await usage.settle('queued',{status:'cancelled_local'});
  assert.equal((await usage.summary()).global.attempts,0);
  await usage.reserve(args('sent')); await usage.dispatch('sent'); await usage.settle('sent',{status:'failed'});
  config.enabled=false; config.revision++;
  await writeFile(join(directory,'settings.json'),JSON.stringify({eido:{research:config}}));
  await assert.rejects(usage.reserve(args('disabled')),/disabled/);
  assert.equal((await usage.summary()).global.attempts,1);
});
test('separate processes cannot over-reserve and dead pre-dispatch owners release slots',async t=>{
  const {directory,usage}=await fixture(t,{httpConcurrency:1});
  const url=new URL('../src/research/usage.mjs',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`import {ResearchUsage} from ${JSON.stringify(url)}; const usage=new ResearchUsage(process.argv[1]); await usage.reserve({operationId:'child',attemptId:'child',turnId:'turn',ownerSession:'child',kind:'search'}); process.stdout.write('reserved'); process.stdin.resume();`,directory],{stdio:['pipe','pipe','pipe']});
  t.after(()=>child.kill());
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});
  await assert.rejects(usage.reserve(args('parent')),/Concurrent request limit/);
  child.kill(); await new Promise(resolve=>child.once('exit',resolve));
  await usage.reserve(args('parent'));
  const ledger=JSON.parse(await readFile(join(directory,'research/v1/usage.json'),'utf8'));
  assert.equal(ledger.attempts.find(item=>item.attemptId==='child').billingState,'not_dispatched');
  assert.equal(ledger.attempts.find(item=>item.attemptId==='parent').status,'reserved');
});
