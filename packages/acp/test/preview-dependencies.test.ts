import assert from "node:assert/strict";
import {test} from "node:test";
import {chmod, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {captureDependencies, changedDependencies} from "../src/preview-dependencies.ts";

test("dependency copies preserve executable links, track added files and keep snapshot writes separate",async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),"eido-dependencies-"))),dest=join(root,"snapshot");
  try{
    await mkdir(join(root,"node_modules/tool/bin"),{recursive:true});await mkdir(join(root,"node_modules/.bin"));
    await writeFile(join(root,"node_modules/tool/bin/cli.js"),"original");await chmod(join(root,"node_modules/tool/bin/cli.js"),0o755);
    await symlink(join(root,"node_modules/tool/bin/cli.js"),join(root,"node_modules/.bin/tool"));
    const inputs=await captureDependencies(root,["node_modules","node_modules/tool"],dest,["src.ts"]);
    assert.deepEqual(inputs.roots,["node_modules"]);
    assert.equal(await readlink(join(dest,"node_modules/.bin/tool")),"../tool/bin/cli.js");
    assert.deepEqual(await changedDependencies(root,inputs.entries),{changed:[],unavailable:[]});
    assert.deepEqual(await changedDependencies(dest,inputs.entries,undefined,true),{changed:[],unavailable:[]});
    await writeFile(join(root,"node_modules/tool/added.js"),"new dependency");
    assert.deepEqual((await changedDependencies(root,inputs.entries)).changed,["node_modules/tool"]);
    await writeFile(join(dest,"node_modules/.bin/tool"),"changed snapshot");
    assert.equal(await readFile(join(root,"node_modules/tool/bin/cli.js"),"utf8"),"original");
    assert.ok((await changedDependencies(dest,inputs.entries,undefined,true)).changed.includes("node_modules/tool/bin/cli.js"));
  }finally{await rm(root,{recursive:true,force:true});}
});

test("dependency capture refuses escaping links, private directories, source overlap and cancellation",async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),"eido-dependencies-"))),dest=join(root,"snapshot");
  try{
    await mkdir(join(root,"deps"));await mkdir(join(root,".pi"));await writeFile(join(root,"secret.txt"),"outside selection");
    await symlink("../secret.txt",join(root,"deps/escape"));
    await assert.rejects(captureDependencies(root,["deps"],dest,[]),/leaves captured/);
    await assert.rejects(captureDependencies(root,["."],dest,[]),/entire workspace/);
    await assert.rejects(captureDependencies(root,[".pi"],dest,[]),/Private/);
    await assert.rejects(captureDependencies(root,["deps"],dest,["deps/source.ts"]),/overlap/);
    await assert.rejects(captureDependencies(root,["deps"],dest,[],AbortSignal.abort()));
  }finally{await rm(root,{recursive:true,force:true});}
});
