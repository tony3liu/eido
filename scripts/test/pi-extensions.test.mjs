import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createExtensionCenter, configuredMcp } from "../pi-extensions.mjs";

test("pi package lifecycle preserves filters, queues changes while loaded, and manages individual skills", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eido-extension-center-"));
  const pkg = join(dir, "fixture-package"), agent = join(dir, "agent");
  await mkdir(pkg); await mkdir(agent);
  await writeFile(join(pkg, "package.json"), JSON.stringify({name:"pi-fixture",version:"1.0.0",pi:{extensions:["extension.js"],skills:["SKILL.md"]}}));
  await writeFile(join(pkg, "extension.js"), "export default () => {};\n");
  await writeFile(join(pkg, "SKILL.md"), "---\nname: fixture-skill\ndescription: Test installed skill\n---\nFixture instructions.\n");
  await writeFile(join(agent, "settings.json"), JSON.stringify({eido:{fullAccess:false},defaultThinkingLevel:"high"}));
  const center = createExtensionCenter(agent);
  try {
    let state = await center.execute({operation:"install",source:pkg});
    assert.equal(state.packages.length, 1); assert.equal(state.packages[0].version, "1.0.0"); assert.equal(state.packages[0].name, "pi-fixture");
    const source = state.packages[0].source;
    const skill = state.skills.find(s => s.name === "fixture-skill"); assert.equal(skill.enabled, true);
    state = await center.execute({operation:"toggle-resource",kind:"skills",path:skill.path,enabled:false});
    assert.equal(state.skills.find(s => s.path === skill.path).enabled, false);
    state = await center.execute({operation:"toggle-package",source,enabled:false});
    assert.equal(state.packages[0].enabled, false); assert.ok(state.extensions.every(e => e.path !== join(pkg,"extension.js") || !e.enabled));
    state = await center.execute({operation:"toggle-package",source,enabled:true});
    assert.equal(state.skills.find(s => s.path === skill.path).enabled, false, "restores the user's filters");
    const release = await center.acquireRuntime();
    state = await center.execute({operation:"remove",source:pkg});
    assert.equal(state.pending.length, 1); assert.equal(state.packages.length,1);
    await release();
    const releaseNext = await center.acquireRuntime();
    state = await center.execute(); assert.equal(state.packages.length, 0); assert.equal(state.pending.length,0);
    await releaseNext();
    const config = JSON.parse(await readFile(join(agent,"settings.json"),"utf8"));
    assert.equal(config.eido.fullAccess,false); assert.equal(config.defaultThinkingLevel,"high");
    await assert.rejects(center.execute({operation:"install",source:"https://github.com/example/plugin"}), /npm/);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("only pi packages are searchable; MCP secrets stay out of list data and invalid edits preserve configuration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eido-mcp-manager-"));
  const center = createExtensionCenter(dir, async url => {
    assert.match(url.searchParams.get("text"), /keywords:pi-package/);
    return new Response(JSON.stringify({objects:[{package:{name:"pi-real",keywords:["pi-package"],version:"1"}},{package:{name:"unrelated",keywords:[]}}]}));
  });
  try {
    const found = await center.execute({operation:"search",query:"browser"}); assert.deepEqual(found.results.map(p => p.name),["pi-real"]);
    const text = JSON.stringify({mcpServers:{local:{command:process.execPath,args:["fixture.js"],env:{KEY:"do-not-list"}},remote:{url:"http://127.0.0.1:9001",headers:{Authorization:"do-not-list"},disabled:true}}});
    const state = await center.execute({operation:"mcp-save",text});
    assert.doesNotMatch(JSON.stringify(state),/do-not-list/);
    const servers = await configuredMcp(dir); assert.equal(servers.length,1); assert.equal(servers[0].env[0].value,"do-not-list");
    await assert.rejects(center.execute({operation:"mcp-save",text:'{"mcpServers":{"broken":{"url":"file:///bad"}}}'}),/Invalid URL/);
    assert.equal((await configuredMcp(dir)).length,1);
    const edit = await center.execute({operation:"mcp-read"});
    await center.execute({operation:"mcp-toggle",name:"local",enabled:false}); assert.equal((await configuredMcp(dir)).length,0);
    await assert.rejects(center.execute({operation:"mcp-save",text:edit.text,revision:edit.revision}), /configuration changed/);
    assert.equal((await configuredMcp(dir)).length,0);
    await center.execute({operation:"mcp-remove",name:"local"});
    assert.equal((await center.execute()).mcp.length,2);
    await assert.rejects(center.execute({operation:"search-skills",query:"x"}),/Unsupported/);
  } finally {await rm(dir,{recursive:true,force:true});}
});


test("extension lock prevents overlapping operations and recovers an abandoned lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eido-extension-lock-"));
  const center = createExtensionCenter(dir);
  const lock = join(dir, ".extensions.lock.lock");
  try {
    await mkdir(lock);
    await assert.rejects(center.acquireRuntime(), /Another extension operation/);
    const old = new Date(Date.now() - 30_000);
    await utimes(lock, old, old);
    const release = await center.acquireRuntime();
    await release();
    await assert.rejects(readFile(lock), {code:"ENOENT"});
  } finally {await rm(dir, {recursive:true, force:true});}
});
