import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {claimBundledRuntime,withRuntimeInstall} from '../bundled-runtime.mjs';

test('dependency replacement excludes live runtimes and blocks startup until installation settles',async()=>{
  const root=await mkdtemp(join(tmpdir(),'eido-runtime-lock-'));
  try {
    const release=await claimBundledRuntime(root);
    let installs=0;
    await assert.rejects(withRuntimeInstall(root,()=>installs++),/Close all development/);
    assert.equal(installs,0);
    await release();
    await withRuntimeInstall(root,async()=>{
      await assert.rejects(claimBundledRuntime(root),/in progress/);
      installs++;
    });
    assert.equal(installs,1);
    const next=await claimBundledRuntime(root);await next();
    await assert.rejects(withRuntimeInstall(root,()=>{throw new Error('install failed');}),/install failed/);
    await (await claimBundledRuntime(root))();
  }finally{await rm(root,{recursive:true,force:true});}
});
