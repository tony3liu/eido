import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { client, methods } from "@agentclientprotocol/sdk";
import { startEidoAgent } from "../src/server.ts";
import { fixtureModel, call, lastToolText } from "./fixture-model.ts";
import { createExtensionCenter } from "../../runtime/src/pi/extensions.mjs";

test("globally configured MCP tools join the existing ACP bridge and disappear when disabled", {timeout:30_000}, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "eido-configured-mcp-")));
  const script = join(dir,"mcp.mjs");
  await writeFile(script, `import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);if(r.id===undefined)return;
 const result=r.method==='initialize'?{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:
 r.method==='tools/list'?{tools:[{name:'ping',description:'Ping local fixture',inputSchema:{type:'object',properties:{}}}]}:
 r.method==='tools/call'?{content:[{type:'text',text:'MCP fixture reached'}]}:{};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
});`);
  await writeFile(join(dir,"settings.json"),JSON.stringify({defaultProvider:"eido-fixture",defaultModel:"scripted",compaction:{enabled:false}}));
  const center = createExtensionCenter(dir);
  await center.execute({operation:"mcp-save",text:JSON.stringify({mcpServers:{fixture:{command:process.execPath,args:[script],exposure:"direct"}}})});
  const fixture = await fixtureModel(dir,[
    () => call("mcp__fixture__ping"),
    context => {assert.match(lastToolText(context,"mcp__fixture__ping"),/MCP fixture reached/);return "MCP verified.";},
    context => {assert.doesNotMatch(JSON.stringify(context.messages.filter(m=>m.role==="system")),/mcp__fixture__ping/);return "MCP disabled.";},
  ]);
  const toAgent = new TransformStream(), toClient = new TransformStream();
  const server = await startEidoAgent(dir,join(dir,"sessions"),{readable:toAgent.readable,writable:toClient.writable},fixture.runtime);
  const output:string[]=[];
  const connection = client({name:"eido-mcp-config-test"})
    .onNotification(methods.client.session.update,({params})=>{const u=params.update;if(u.sessionUpdate==="agent_message_chunk"&&u.content.type==="text")output.push(u.content.text);})
    .onRequest(methods.client.session.requestPermission,()=>({outcome:{outcome:"selected",optionId:"allow_once"}}))
    .connect({readable:toClient.readable,writable:toAgent.writable});
  try {
    await connection.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{}});
    const a=await connection.agent.request(methods.agent.session.new,{cwd:dir,mcpServers:[]});
    await connection.agent.request(methods.agent.session.prompt,{sessionId:a.sessionId,prompt:[{type:"text",text:"Ping MCP"}]});
    await center.execute({operation:"mcp-toggle",name:"fixture",enabled:false});
    const b=await connection.agent.request(methods.agent.session.new,{cwd:dir,mcpServers:[]});
    await connection.agent.request(methods.agent.session.prompt,{sessionId:b.sessionId,prompt:[{type:"text",text:"Inspect tools"}]});
    assert.match(output.join(""),/MCP verified/);assert.match(output.join(""),/MCP disabled/);assert.equal(fixture.requests(),3);
  } finally {await server.agent.dispose();connection.close();server.connection.close();await rm(dir,{recursive:true,force:true});}
});

test("installed pi plugin tools execute through ACP and disabling removes them from new tasks", {timeout:30_000}, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "eido-plugin-acp-")));
  const pkg = join(dir,"plugin"); await mkdir(pkg);
  await writeFile(join(pkg,"package.json"),JSON.stringify({name:"pi-local-fixture",version:"1.0.0",pi:{extensions:["index.js"]}}));
  await writeFile(join(pkg,"index.js"), `export default api => api.registerTool({name:"fixture_plugin", label:"Plugin fixture", description:"Report fixture status", parameters:{type:"object",properties:{}}, async execute(){return {content:[{type:"text",text:"Plugin executed"}]}}});`);
  await writeFile(join(dir,"settings.json"),JSON.stringify({defaultProvider:"eido-fixture",defaultModel:"scripted",compaction:{enabled:false}}));
  const center = createExtensionCenter(dir);
  await center.execute({operation:"install",source:pkg});
  const fixture = await fixtureModel(dir,[
    context => {assert.match(JSON.stringify(context.messages.filter(m => m.role === "system")), /fixture_plugin/); return call("fixture_plugin");},
    context => {assert.match(lastToolText(context,"fixture_plugin"),/Plugin executed/); return "Plugin verified.";},
    context => {assert.doesNotMatch(JSON.stringify(context.messages.filter(m => m.role === "system")), /fixture_plugin/); return "Disabled plugin unavailable.";},
  ]);
  const toAgent = new TransformStream(), toClient = new TransformStream();
  const server = await startEidoAgent(dir,join(dir,"sessions"),{readable:toAgent.readable,writable:toClient.writable},fixture.runtime);
  const output: string[] = [];
  const connection = client({name:"eido-plugin-test"})
    .onNotification(methods.client.session.update, ({params}) => {const u = params.update; if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") output.push(u.content.text);})
    .onRequest(methods.client.session.requestPermission, () => ({outcome:{outcome:"selected",optionId:"allow_once"}}))
    .connect({readable:toClient.readable,writable:toAgent.writable});
  try {
    await connection.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{}});
    const a = await connection.agent.request(methods.agent.session.new,{cwd:dir,mcpServers:[]});
    await connection.agent.request(methods.agent.session.prompt,{sessionId:a.sessionId,prompt:[{type:"text",text:"Run installed plugin"}]});
    const state = await center.execute() as {packages: Array<{source:string}>};
    await center.execute({operation:"toggle-package",source:state.packages[0]!.source,enabled:false});
    const b = await connection.agent.request(methods.agent.session.new,{cwd:dir,mcpServers:[]});
    await connection.agent.request(methods.agent.session.prompt,{sessionId:b.sessionId,prompt:[{type:"text",text:"Inspect tools"}]});
    assert.equal(fixture.requests(),3);
    assert.match(output.join(""), /Plugin verified/); assert.match(output.join(""), /Disabled plugin unavailable/);
  } finally {await server.agent.dispose();connection.close();server.connection.close();await rm(dir,{recursive:true,force:true});}
});

test("existing ACP adapter retains sessions and delegates edits to editor buffers", { timeout: 30_000 }, async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "eido-acp-")));
  const path = join(cwd, "sample.ts");
  let buffer = "export const value = 'unsaved';\n";
  const writes: string[] = [];
  const updates: string[] = [];
  const replayed: string[] = [];
  const locations: string[] = [];
  await writeFile(path, "export const value = 'disk';\n");
  await writeFile(join(cwd, "settings.json"), JSON.stringify({ defaultProvider: "eido-fixture", defaultModel: "scripted", defaultThinkingLevel: "off" }));
  const fixture = await fixtureModel(cwd, [
    () => call("read", {path: "sample.ts"}),
    context => { assert.match(lastToolText(context,"read"), /unsaved/); return call("edit", { path, edits: [{oldText: "'unsaved'",newText: "'edited'"}] }); },
    context => { assert.match(lastToolText(context,"edit"), /Successfully/); return "Updated the editor buffer."; },
    context => { assert.ok(JSON.stringify(context.messages).includes("apricot")); return "The earlier marker was apricot."; },
    context => { assert.ok(!JSON.stringify(context.messages).includes("apricot")); return "Independent task."; },
  ]);
  const toAgent = new TransformStream();
  const toClient = new TransformStream();
  const server = await startEidoAgent(cwd, join(cwd,"sessions"), {readable:toAgent.readable,writable:toClient.writable}, fixture.runtime);
  const app = client({name:"eido-fixture"})
    .onRequest(methods.client.fs.readTextFile, () => ({content:buffer}))
    .onRequest(methods.client.fs.writeTextFile, ({params}) => { assert.equal(params.path,path);buffer=params.content;writes.push(buffer);return {}; })
    .onRequest(methods.client.session.requestPermission, () => ({outcome:{outcome:"selected",optionId:"allow_once"}}))
    .onNotification(methods.client.session.update, ({params}) => {
      updates.push(params.sessionId);
      if (params.update.sessionUpdate === "tool_call") locations.push(...(params.update.locations ?? []).map(location => location.path));
      if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content.type === "text") replayed.push(params.update.content.text);
    });
  const connection = app.connect({readable:toClient.readable,writable:toAgent.writable});
  try {
    const initialized = await connection.agent.request(methods.agent.initialize, {protocolVersion:1,clientCapabilities:{fs:{readTextFile:true,writeTextFile:true}},clientInfo:{name:"eido-test",version:"0.0.1"}});
    assert.equal(initialized.protocolVersion,1);
    assert.equal(initialized.agentInfo?.name,"eido-pi");
    assert.equal(initialized.agentInfo?.version,"1.1.0");
    const a = await connection.agent.request(methods.agent.session.new,{cwd,mcpServers:[]});
    const prompt = (sessionId: string,text: string) => connection.agent.request(methods.agent.session.prompt,{sessionId,prompt:[{type:"text",text}]});
    assert.equal((await prompt(a.sessionId,"Remember apricot. Read and edit sample.ts using the editor tools.")).stopReason,"end_turn");
    assert.equal(writes.length,1);
    assert.deepEqual(locations, [path, path], "relative read and absolute edit locations must both resolve to the session file");
    assert.match(buffer,/'edited'/);
    assert.match(await readFile(path,"utf8"),/'disk'/);
    assert.equal((await prompt(a.sessionId,"What was my marker?")).stopReason,"end_turn");
    const b = await connection.agent.request(methods.agent.session.new,{cwd,mcpServers:[]});
    assert.notEqual(a.sessionId,b.sessionId);
    assert.equal((await prompt(b.sessionId,"Start an independent task.")).stopReason,"end_turn");
    assert.ok(updates.includes(a.sessionId)&&updates.includes(b.sessionId));
    assert.equal(fixture.requests(),5);
    await connection.agent.request(methods.agent.session.close,{sessionId:a.sessionId});
    replayed.length = 0;
    locations.length = 0;
    await connection.agent.request(methods.agent.session.load,{sessionId:a.sessionId,cwd,mcpServers:[]});
    assert.match(replayed.join(""), /apricot/);
    assert.match(replayed.join(""), /Updated the editor buffer/);
    assert.deepEqual(locations, [path, path], "restored file navigation must match the live turn");
    assert.equal(fixture.requests(),5, "history replay must not call the model");
  } catch (error) {
    console.error("ACP fixture diagnostic", error instanceof Error && "data" in error ? error.data : error);
    throw error;
  } finally {
    await server.agent.dispose();connection.close();server.connection.close();await rm(cwd,{recursive:true,force:true});
  }
});

test("cancelling a pending editor read leaves other ACP tasks usable", { timeout: 30_000 }, async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "eido-acp-cancel-")));
  const path = join(cwd, "sample.ts");
  await writeFile(path, "unchanged");
  await writeFile(join(cwd, "settings.json"), JSON.stringify({ defaultProvider: "eido-fixture", defaultModel: "scripted", defaultThinkingLevel: "off" }));
  const fixture = await fixtureModel(cwd, [() => call("read", { path }), () => "Other task is responsive."]);
  let readStarted!: () => void;
  const started = new Promise<void>(resolve => { readStarted = resolve; });
  let finishRead!: (value: {content: string}) => void;
  const heldRead = new Promise<{content: string}>(resolve => { finishRead = resolve; });
  let writes = 0;
  const toAgent = new TransformStream();
  const toClient = new TransformStream();
  const server = await startEidoAgent(cwd, join(cwd,"sessions"), {readable:toAgent.readable,writable:toClient.writable}, fixture.runtime);
  const connection = client({name:"eido-cancel-fixture"})
    .onRequest(methods.client.fs.readTextFile, () => { readStarted(); return heldRead; })
    .onRequest(methods.client.fs.writeTextFile, () => { writes++; return {}; })
    .onRequest(methods.client.session.requestPermission, () => ({outcome:{outcome:"selected",optionId:"allow_once"}}))
    .connect({readable:toClient.readable,writable:toAgent.writable});
  try {
    await connection.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{fs:{readTextFile:true,writeTextFile:true}}});
    const a = await connection.agent.request(methods.agent.session.new,{cwd,mcpServers:[]});
    const b = await connection.agent.request(methods.agent.session.new,{cwd,mcpServers:[]});
    const pending = connection.agent.request(methods.agent.session.prompt,{sessionId:a.sessionId,prompt:[{type:"text",text:"Read sample.ts"}]});
    await started;
    const independent = await connection.agent.request(methods.agent.session.prompt,{sessionId:b.sessionId,prompt:[{type:"text",text:"Reply in another task"}]});
    assert.equal(independent.stopReason,"end_turn");
    await connection.agent.notify(methods.agent.session.cancel,{sessionId:a.sessionId});
    assert.equal((await pending).stopReason,"cancelled");
    finishRead({content:"late result"});
    assert.equal(writes,0);
    assert.equal(await readFile(path,"utf8"),"unchanged");
    assert.equal(fixture.requests(),2);
  } finally {
    finishRead({content:"cleanup"});
    await server.agent.dispose();connection.close();server.connection.close();await rm(cwd,{recursive:true,force:true});
  }
});

test("new ACP tasks reload global pi defaults and ignore project settings", { timeout: 30_000 }, async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "eido-acp-settings-")));
  const configuration = (id: string) => JSON.stringify({ providers: { "eido-fixture": {
    api:"openai-completions", baseUrl:"https://example.invalid/v1", models:[{id,reasoning:false}],
  } } });
  const defaults = (model: string) => JSON.stringify({defaultProvider:"eido-fixture",defaultModel:model,defaultThinkingLevel:"off"});
  await writeFile(join(cwd,"models.json"),configuration("first-model"));
  await writeFile(join(cwd,"settings.json"),defaults("first-model"));
  await writeFile(join(cwd,"auth.json"),JSON.stringify({"eido-fixture":{type:"api_key",key:"fixture-only"}}));
  await mkdir(join(cwd,".pi"));
  const projectConfig = join(cwd,".pi/settings.json");
  const projectOverride = defaults("project-model-must-not-be-used");
  await writeFile(projectConfig,projectOverride);
  const toAgent = new TransformStream(); const toClient = new TransformStream();
  const server = await startEidoAgent(cwd,join(cwd,"sessions"),{readable:toAgent.readable,writable:toClient.writable});
  const connection = client({name:"eido-config-test"}).connect({readable:toClient.readable,writable:toAgent.writable});
  try {
    await connection.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{fs:{readTextFile:true,writeTextFile:true}}});
    const first = await connection.agent.request(methods.agent.session.new,{cwd,mcpServers:[]});
    assert.match(JSON.stringify(first.configOptions?.find(option=>option.id==="model")?.currentValue),/first-model/);
    assert.equal(await readFile(projectConfig,"utf8"),projectOverride);
    await writeFile(projectConfig,"invalid project settings must not be read");
    await writeFile(join(cwd,"models.json"),configuration("second-model"));
    await writeFile(join(cwd,"settings.json"),defaults("second-model"));
    const second = await connection.agent.request(methods.agent.session.new,{cwd,mcpServers:[]});
    assert.match(JSON.stringify(second.configOptions?.find(option=>option.id==="model")?.currentValue),/second-model/);
    assert.equal(await readFile(projectConfig,"utf8"),"invalid project settings must not be read");
    assert.notEqual(first.sessionId,second.sessionId);
  } finally {
    await server.agent.dispose(); connection.close(); server.connection.close(); await rm(cwd,{recursive:true,force:true});
  }
});


test("pi sees the current global access mode on each turn", { timeout: 30_000 }, async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "eido-access-")));
  const settings = { defaultProvider: "eido-fixture", defaultModel: "scripted", defaultThinkingLevel: "off", eido: {fullAccess:false} };
  const save = () => writeFile(join(cwd, "settings.json"), JSON.stringify(settings));
  await save();
  const fixture = await fixtureModel(cwd, [
    context => { assert.match(JSON.stringify(context), /Eido access mode: Ask Before Actions/); return "Review mode."; },
    context => { assert.match(JSON.stringify(context), /Eido access mode: Full Access/); return "Autonomous mode."; },
    context => {
      const messages = JSON.stringify(context);
      assert.ok(messages.lastIndexOf("Eido access mode: Ask Before Actions") > messages.lastIndexOf("Eido access mode: Full Access"));
      return "Review mode restored.";
    },
  ]);
  const toAgent = new TransformStream(), toClient = new TransformStream();
  const server = await startEidoAgent(cwd, join(cwd,"sessions"), {readable:toAgent.readable,writable:toClient.writable}, fixture.runtime);
  const connection = client({name:"eido-access-test"})
    .onNotification(methods.client.session.update, () => {})
    .connect({readable:toClient.readable,writable:toAgent.writable});
  try {
    await connection.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{}});
    const task=await connection.agent.request(methods.agent.session.new,{cwd,mcpServers:[]});
    const prompt=()=>connection.agent.request(methods.agent.session.prompt,{sessionId:task.sessionId,prompt:[{type:"text",text:"Check current mode."}]});
    assert.equal((await prompt()).stopReason,"end_turn");
    settings.eido.fullAccess=true; await save();
    assert.equal((await prompt()).stopReason,"end_turn");
    settings.eido.fullAccess=false; await save();
    assert.equal((await prompt()).stopReason,"end_turn");
    assert.equal(fixture.requests(),3);
  } finally {
    await server.agent.dispose(); connection.close(); server.connection.close(); await rm(cwd,{recursive:true,force:true});
  }
});

test("deleting a pi thread removes only its journal and rejects busy or externally owned sessions", {timeout:30_000}, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "eido-delete-thread-")));
  await writeFile(join(dir, "settings.json"), JSON.stringify({defaultProvider:"eido-fixture", defaultModel:"scripted", compaction:{enabled:false}}));
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const finish = new Promise<void>(resolve => { release = resolve; });
  const fixture = await fixtureModel(dir, [() => "First answer", () => "Second answer", async () => {started(); await finish; return "Finished";}]);
  const toAgent = new TransformStream(), toClient = new TransformStream();
  const server = await startEidoAgent(dir, join(dir,"sessions"), {readable:toAgent.readable,writable:toClient.writable}, fixture.runtime);
  const connection = client({name:"eido-delete-thread-test"})
    .onNotification(methods.client.session.update, () => {})
    .connect({readable:toClient.readable,writable:toAgent.writable});
  const request = connection.agent;
  try {
    const init = await request.request(methods.agent.initialize, {protocolVersion:1, clientCapabilities:{}});
    assert.deepEqual(init.agentCapabilities?.sessionCapabilities?.delete, {});
    const first = await request.request(methods.agent.session.new, {cwd:dir,mcpServers:[]});
    const second = await request.request(methods.agent.session.new, {cwd:dir,mcpServers:[]});
    for (const session of [first, second]) await request.request(methods.agent.session.prompt, {sessionId:session.sessionId,prompt:[{type:"text",text:"Remember this question"}]});
    const before = await request.request(methods.agent.session.list, {});
    assert.equal(before.sessions.length, 2);
    await request.request(methods.agent.session.delete, {sessionId:first.sessionId});
    assert.deepEqual((await request.request(methods.agent.session.list, {})).sessions.map(s=>s.sessionId), [second.sessionId]);
    await assert.rejects(request.request(methods.agent.session.load, {sessionId:first.sessionId,cwd:dir,mcpServers:[]}));
    await request.request(methods.agent.session.close, {sessionId:second.sessionId});
    const {sessionOwners} = await import('../src/session-owner.ts');
    const unlock = await sessionOwners(dir)(second.sessionId);
    try {await assert.rejects(request.request(methods.agent.session.delete, {sessionId:second.sessionId}), /already open/);}
    finally {await unlock();}
    assert.equal((await request.request(methods.agent.session.list, {})).sessions.length, 1);
    await request.request(methods.agent.session.load, {sessionId:second.sessionId,cwd:dir,mcpServers:[]});
    const prompt = request.request(methods.agent.session.prompt, {sessionId:second.sessionId,prompt:[{type:"text",text:"Wait for completion"}]});
    await running;
    await assert.rejects(request.request(methods.agent.session.delete, {sessionId:second.sessionId}), (error: any) => error.data?.errorKind === "session_busy");
    release(); await prompt;
    await request.request(methods.agent.session.close, {sessionId:second.sessionId});
    await request.request(methods.agent.session.delete, {sessionId:second.sessionId});
    await request.request(methods.agent.session.delete, {sessionId:second.sessionId});
    assert.equal((await request.request(methods.agent.session.list, {})).sessions.length, 0);
  } finally {release(); await server.agent.dispose(); connection.close(); server.connection.close(); await rm(dir,{recursive:true,force:true});}
});
