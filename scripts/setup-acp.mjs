import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {withRuntimeInstall} from './bundled-runtime.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
// npm verifies the official package integrity. Eido never rewrites pi files.
await withRuntimeInstall(root,()=>new Promise((resolve,reject)=>{
  const child=spawn('npm',['ci','--prefix','packages/acp','--ignore-scripts','--no-audit','--no-fund'],{cwd:root,stdio:'inherit'});
  child.once('error',reject);
  child.once('exit',code=>code===0?resolve():reject(new Error(`Bundled dependency installation failed (${code}).`)));
}));
