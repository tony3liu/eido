import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, realpath, writeFile, symlink, rm, access} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {client, methods, type AgentContext} from "@agentclientprotocol/sdk";
import type {ExtensionToolContext} from "@earendil-works/pi-coding-agent";
import {editorTools} from "../src/editor-tools.ts";
import {workspacePath} from "../src/workspace-path.ts";
import {startEidoAgent} from "../src/server.ts";
import {fixtureModel, call, lastToolText} from "./fixture-model.ts";

test("new file resolution preserves workspace boundaries without creating directories", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(),"eido-new-path-")));
  try {
    assert.equal(await workspacePath(dir,"a/b/new.ts",true),join(dir,"a/b/new.ts"));
    await assert.rejects(access(join(dir,"a")));
    await assert.rejects(workspacePath(dir,"a/b/new.ts"),/ENOENT/);
    await assert.rejects(workspacePath(dir,"../escape.ts",true),/outside/);
    await assert.rejects(workspacePath(dir,".pi/new.ts",true),/Private/);
    await symlink(tmpdir(),join(dir,"outside"));
    await assert.rejects(workspacePath(dir,"outside/escape.ts",true),/outside/);
    await symlink(join(dir,"missing"),join(dir,"dangling"));
    await assert.rejects(workspacePath(dir,"dangling/new.ts",true),/ENOENT/);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("pi creates, reads and edits a new unsaved file through native ACP", {timeout:30_000}, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(),"eido-new-file-")));
  await writeFile(join(dir,"settings.json"),JSON.stringify({defaultProvider:"eido-fixture",defaultModel:"scripted",compaction:{enabled:false}}));
  const path = join(dir,"nested/new.ts");
  const fixture = await fixtureModel(dir,[
    () => call("write",{path,content:"export const created = 1;\n"}),
    context => {lastToolText(context,"write");return call("read",{path});},
    context => {assert.match(lastToolText(context,"read"),/created = 1/);return call("edit",{path,edits:[{oldText:"created = 1",newText:"created = 2"}]});},
    context => {lastToolText(context,"edit");return "New file edited.";},
  ]);
  const toAgent = new TransformStream(), toClient = new TransformStream();
  const server = await startEidoAgent(dir,join(dir,"sessions"),{readable:toAgent.readable,writable:toClient.writable},fixture.runtime);
  let buffer: string | undefined;
  let writes = 0;
  const connection = client({name:"eido-new-file-test"})
    .onNotification(methods.client.session.update,()=>{})
    .onRequest(methods.client.session.requestPermission,()=>({outcome:{outcome:"selected",optionId:"allow_once"}}))
    .onRequest(methods.client.fs.readTextFile,({params})=>{assert.equal(params.path,path);assert.ok(buffer);return {content:buffer};})
    .onRequest(methods.client.fs.writeTextFile,({params})=>{
      assert.equal(params.path,path);assert.equal(params._meta?.["eido.dev/createFile"],true);
      writes++;buffer=params.content;return {};
    })
    .connect({readable:toClient.readable,writable:toAgent.writable});
  try {
    await connection.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{fs:{readTextFile:true,writeTextFile:true}}});
    const session = await connection.agent.request(methods.agent.session.new,{cwd:dir,mcpServers:[]});
    await connection.agent.request(methods.agent.session.prompt,{sessionId:session.sessionId,prompt:[{type:"text",text:"Create and edit a new file"}]});
    assert.equal(writes,2);assert.equal(buffer,"export const created = 2;\n");
    await assert.rejects(access(join(dir,"nested")));
    assert.equal(fixture.requests(),4);
  } finally {await server.agent.dispose();connection.close();server.connection.close();await rm(dir,{recursive:true,force:true});}
});

test("read recovers stale offsets once using the native snapshot, with bounded and explicit line ranges", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "eido-read-range-")));
  try {
    const lines = (count: number) => Array.from({length:count}, (_,i) => `native line ${i+1}`).join("\n");
    const cases = [
      {content:lines(68), offset:400, start:1, count:68},
      {content:lines(844), offset:850, limit:100, start:745, count:100},
      {content:lines(844), offset:850, limit:10000, start:645, count:200},
      {content:lines(844), offset:850, start:645, count:200},
      {content:"", offset:400, start:1, count:1},
      {content:"last line\n", offset:3, start:1, count:2},
    ];
    // Concurrent calls must not borrow each other's snapshot or range.
    const snapshots = new Map(cases.map((item,i) => [join(dir, `${i}.txt`), item.content]));
    const reads = new Map<string,number>();
    const endpoint = {request: async (method: string, params: {path:string}) => {
      assert.equal(method,methods.client.fs.readTextFile);
      const count = (reads.get(params.path) ?? 0) + 1; reads.set(params.path,count);
      assert.equal(count,1,"Recovery must not re-read a potentially changed native buffer");
      return {content:snapshots.get(params.path)};
    }} as unknown as Pick<AgentContext,"request">;
    const tool = editorTools(dir,"s",endpoint).find(tool => tool.name === "read")!;
    await Promise.all(cases.map(async (item,i) => {
      const path = join(dir,`${i}.txt`);
      const input = {path,offset:item.offset,...(item.limit === undefined ? {} : {limit:item.limit})};
      const result = await tool.execute(`r${i}`,input,undefined,undefined,{} as ExtensionToolContext);
      const text = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      assert.match(text,new RegExp(`Reading from offset=${item.start} with limit=${item.count}\\.`));
      assert.equal(text.split("\n\n").slice(1).join("\n\n"),item.content.split("\n").slice(item.start-1).join("\n"));
      assert.equal(result.structuredContent,text,"Codemode must see the same correction as the model");
      assert.equal(input.offset,item.offset,"Preserve the original request in the activity history");
      assert.equal(reads.get(path),1);
      if (!item.content) assert.match(text,/file is empty/);
    }));
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("read preserves normal slices, truncation, images, cancellation and genuine native failures", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(),"eido-read-boundaries-")));
  try {
    const controller = new AbortController();
    let content = "one\ntwo\nthree";
    let requests = 0;
    let fail: Error | undefined;
    let abort = false;
    const endpoint = {request: async (method: string, _params: unknown, options: {cancellationSignal?:AbortSignal}) => {
      assert.equal(method,methods.client.fs.readTextFile); requests++;
      if (fail) throw fail;
      if (abort) {assert.equal(options.cancellationSignal,controller.signal);controller.abort();}
      return {content};
    }} as unknown as Pick<AgentContext,"request">;
    const image = {data:"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGMwyXtAEmIY1TCqYfhqAACJooIQq9u/YAAAAABJRU5ErkJggg==",mimeType:"image/png"};
    const tool = editorTools(dir,"s",endpoint,path => path.endsWith('.png') ? image : undefined).find(tool=>tool.name === "read")!;
    const execute = (offset: number, limit?: number, signal?: AbortSignal, path = join(dir,"file.txt")) =>
      tool.execute("r",{path,offset,...(limit === undefined ? {} : {limit})},signal,undefined,{model:{input:["text","image"]}} as ExtensionToolContext);
    const normal = await execute(2,1);
    assert.equal(normal.structuredContent,"two\n\n[1 more lines in file. Use offset=3 to continue.]");
    content = Array.from({length:400},()=>"x".repeat(1000)).join("\n");
    const truncated = await execute(850);
    assert.match(String(truncated.structuredContent),/offset=201 with limit=200/);
    assert.match(String(truncated.structuredContent),/Showing lines 201-\d+ of 400 .*50.*limit/);
    assert.ok(JSON.stringify(truncated.content).length < 53_000);
    assert.ok((truncated.details as Record<string,unknown>).truncation);
    const beforeImage = requests;
    const result = await execute(850,undefined,undefined,join(dir,"output.png"));
    assert.ok(result.content.some(item=>item.type === "image"),JSON.stringify(result.content));
    assert.doesNotMatch(JSON.stringify(result.content),/Read range adjusted/);
    assert.equal(requests,beforeImage);
    for (const message of ["Permission denied", "ENOENT: file unavailable", "Offset 850 is beyond end of file (1 lines total)"]) {
      fail = new Error(message);
      const before = requests;
      await assert.rejects(execute(850),error => error === fail);
      assert.equal(requests,before+1);
    }
    fail = undefined;
    const beforePrivate = requests;
    await assert.rejects(execute(850,undefined,undefined,join(dir,".pi/private.txt")),/Private/);
    assert.equal(requests,beforePrivate);
    abort = true;
    await assert.rejects(execute(850,undefined,controller.signal),/abort/i);
    const afterAbort = requests;
    await assert.rejects(execute(850,undefined,controller.signal),/abort/i);
    assert.equal(requests,afterAbort);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("pi continues after an out-of-range read and ACP records it as completed", {timeout:30_000}, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(),"eido-read-recovery-acp-")));
  await writeFile(join(dir,"settings.json"),JSON.stringify({defaultProvider:"eido-fixture",defaultModel:"scripted",compaction:{enabled:false}}));
  const path = join(dir,"ui.rs");
  await writeFile(path,"stale disk content");
  const nativeContent = Array.from({length:68},(_,i)=>`unsaved row ${i+1}`).join("\n");
  let continued = false;
  const fixture = await fixtureModel(dir,[
    () => call("read",{path,offset:400,limit:100}),
    context => {
      const output = lastToolText(context,"read");
      assert.match(output,/offset=1 with limit=68/);
      assert.ok(output.includes(nativeContent),output.slice(-500));
      assert.doesNotMatch(output,/stale disk content/);
      continued = true;
      return "Read automatically recovered. Task can continue.";
    },
  ]);
  const toAgent = new TransformStream(), toClient = new TransformStream();
  const server = await startEidoAgent(dir,join(dir,"sessions"),{readable:toAgent.readable,writable:toClient.writable},fixture.runtime);
  const statuses: string[] = [];
  let reads = 0;
  const connection = client({name:"eido-read-recovery-test"})
    .onNotification(methods.client.session.update,({params})=>{
      const update = params.update;
      if (update.sessionUpdate === "tool_call_update" && update.status) statuses.push(update.status);
    })
    .onRequest(methods.client.session.requestPermission,()=>({outcome:{outcome:"selected",optionId:"allow_once"}}))
    .onRequest(methods.client.fs.readTextFile,({params})=>{assert.equal(params.path,path);reads++;return {content:nativeContent};})
    .connect({readable:toClient.readable,writable:toAgent.writable});
  try {
    await connection.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{fs:{readTextFile:true,writeTextFile:true}}});
    const session = await connection.agent.request(methods.agent.session.new,{cwd:dir,mcpServers:[]});
    await connection.agent.request(methods.agent.session.prompt,{sessionId:session.sessionId,prompt:[{type:"text",text:"Read the current file"}]});
    assert.equal(continued,true);assert.equal(fixture.requests(),2);assert.equal(reads,1);
    assert.ok(statuses.includes("completed"));assert.ok(!statuses.includes("failed"));
  } finally {await server.agent.dispose();connection.close();server.connection.close();await rm(dir,{recursive:true,force:true});}
});
