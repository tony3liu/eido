import {mkdir,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
async function lock(root,action) {
  const base=join(root,'.local/bundled-runtime'),path=join(base,'lock');
  await mkdir(base,{recursive:true,mode:0o700});
  const token=randomUUID();
  try {await mkdir(path,{mode:0o700});}
  catch(error) {
    if(error.code!=='EEXIST')throw error;
    const owner=await readFile(join(path,'owner.json'),'utf8').then(JSON.parse).catch(()=>undefined);
    if(owner&&Number.isSafeInteger(owner.pid)&&owner.pid>0&&!alive(owner.pid))
      throw new Error(`A previous runtime operation ended unexpectedly. Inspect and remove the stale lock at ${path} before retrying.`);
    throw new Error('A bundled runtime operation is in progress. Retry after it finishes.');
  }
  await writeFile(join(path,'owner.json'),JSON.stringify({pid:process.pid,token}),{mode:0o600});
  try{return await action(base);}finally{await rm(path,{recursive:true,force:true});}
}

export async function claimBundledRuntime(root) {
  return lock(root,async base=>{
    const directory=join(base,'leases');await mkdir(directory,{recursive:true,mode:0o700});
    const path=join(directory,`${process.pid}-${randomUUID()}.json`);
    await writeFile(path,JSON.stringify({pid:process.pid}),{mode:0o600});
    return ()=>rm(path,{force:true});
  });
}

export async function withRuntimeInstall(root,install) {
  return lock(root,async base=>{
    const directory=join(base,'leases');
    const entries=await readdir(directory).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
    for(const name of entries) {
      const path=join(directory,name),owner=JSON.parse(await readFile(path,'utf8'));
      if(!Number.isSafeInteger(owner.pid)||owner.pid<=0||alive(owner.pid))throw new Error('Close all development Eido/ACP processes before replacing bundled dependencies.');
      await rm(path);
    }
    return install();
  });
}
