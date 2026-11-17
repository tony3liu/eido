import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes, symlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {pathToFileURL} from "node:url";
import {bundledPiEntry, runtimeRoot} from "../../src/paths.mjs";
import {ONE_CODE_ID, oneCodeDescriptor, oneCodeSettingsView} from "../../src/pi/bundled-one-code.mjs";
const {SettingsManager, DefaultPackageManager} = await import(bundledPiEntry.href);
import { createExtensionCenter, configuredMcp } from "../../src/pi/extensions.mjs";

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
    assert.equal(state.packages.filter(p=>!p.builtin).length, 1); assert.equal(state.packages[0].version, "1.0.0"); assert.equal(state.packages[0].name, "pi-fixture");
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
    assert.equal(state.pending.length, 1); assert.equal(state.packages.filter(p=>!p.builtin).length,1);
    await release();
    const releaseNext = await center.acquireRuntime();
    state = await center.execute(); assert.equal(state.packages.filter(p=>!p.builtin).length, 0); assert.equal(state.pending.length,0);
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
    for (const server of [{url:"http://localhost",type:"websocket"},{command:"node",type:"http"},{url:"http://localhost",type:"stdio"}]) {
      await assert.rejects(center.execute({operation:"mcp-save",text:JSON.stringify({mcpServers:{invalid:server}})}),/Invalid transport/);
    }
    assert.equal((await configuredMcp(dir)).length,1);
    const edit = await center.execute({operation:"mcp-read"});
    await center.execute({operation:"mcp-toggle",name:"local",enabled:false}); assert.equal((await configuredMcp(dir)).length,0);
    await assert.rejects(center.execute({operation:"mcp-save",text:edit.text,revision:edit.revision}), /configuration changed/);
    assert.equal((await configuredMcp(dir)).length,0);
    await center.execute({operation:"mcp-remove",name:"local"});
    assert.equal((await center.execute()).mcp.filter(s => !s.builtin).length,1);
    await assert.rejects(center.execute({operation:"search-skills",query:"x"}),/Unsupported/);
  } finally {await rm(dir,{recursive:true,force:true});}
});


test("extension lock serializes startup, prevents overlapping mutations and recovers an abandoned lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eido-extension-lock-"));
  const center = createExtensionCenter(dir);
  const lock = join(dir, ".extensions.lock.lock");
  try {
    await mkdir(lock);
    await assert.rejects(center.execute({operation:"retry"}), /Another extension operation/);
    const pending = center.acquireRuntime();
    let acquired = false;
    pending.then(() => {acquired = true;});
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(acquired, false, "startup waits while another operation holds the lock");
    await rm(lock, {recursive:true});
    const firstRelease = await pending;
    assert.equal((await center.execute()).activeRuntimes, 1);
    await firstRelease();
    await mkdir(lock);
    const old = new Date(Date.now() - 30_000);
    await utimes(lock, old, old);
    const release = await center.acquireRuntime();
    await release();
    await assert.rejects(readFile(lock), {code:"ENOENT"});
  } finally {await rm(dir, {recursive:true, force:true});}
});

test('MCP follows pi enabled, env interpolation and validation without resolving secrets during inspection', async()=> {
  const dir=await mkdtemp(join(tmpdir(),'eido-mcp-config-'));
  const center=createExtensionCenter(dir);
  process.env.EIDO_MCP_FIXTURE_SECRET='config-fixture-secret';
  try {
    const config={mcpServers:{legacy:{command:'node',disabled:true},pi:{command:'node',enabled:false},local:{command:'node',enabled:true,disabled:true,env:{KEY:'${EIDO_MCP_FIXTURE_SECRET}'}},remote:{type:'sse',url:'http://127.0.0.1:9001',headers:{Authorization:'Bearer ${EIDO_MCP_FIXTURE_SECRET}'}}}};
    const state=await center.execute({operation:'mcp-save',text:JSON.stringify(config)});
    assert.doesNotMatch(JSON.stringify(state),/config-fixture-secret|EIDO_MCP_FIXTURE_SECRET/);
    const configured=await configuredMcp(dir);
    assert.deepEqual(configured.map(s=>s.name),['local','remote']);
    assert.equal(configured[0].env[0].value,'config-fixture-secret');
    assert.equal(configured[1].type,'sse');
    assert.equal(configured[1].headers[0].value,'Bearer config-fixture-secret');
    const stored=JSON.parse(await readFile(join(dir,'mcp.json'),'utf8'));
    assert.equal(stored.mcpServers.legacy.enabled,false);
    assert.equal(stored.mcpServers.local.enabled,true);
    assert.equal(stored.mcpServers.local.disabled,undefined);
    assert.equal(stored.mcpServers.local.env.KEY,'${EIDO_MCP_FIXTURE_SECRET}');
    for (const server of [{command:'node',timeout:0},{url:'http://localhost',oauth:{callbackUrl:'https://evil.invalid/callback'}},{url:'http://remote.invalid',auth:{provider:'test'}},{command:'node',enabled:'no'},{command:'node',toolExposure:{secret:'typo'}}]) {
      await assert.rejects(center.execute({operation:'mcp-save',text:JSON.stringify({mcpServers:{bad:server}})}));
    }
    delete process.env.EIDO_MCP_FIXTURE_SECRET;
    assert.equal((await center.execute()).mcp.filter(s => !s.builtin).length,4,'inspection does not resolve credentials');
    const unresolved = await configuredMcp(dir);
    assert.deepEqual(unresolved.map(server => server[Symbol.for('eido.pi.mcp.options')].unresolved), [true, true]);
    assert.doesNotMatch(JSON.stringify(unresolved), /EIDO_MCP_FIXTURE_SECRET|config-fixture-secret/);
  }finally {delete process.env.EIDO_MCP_FIXTURE_SECRET;await rm(dir,{recursive:true,force:true});}
});


test("built-in One Code toggle persists without touching package filters or other global choices", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eido-one-code-setting-"));
  const original = {defaultTools:["read", "-edit"], defaultModel:"custom-model", eido:{fullAccess:true, custom:"preserved"}, packages:[]};
  await writeFile(join(dir,"settings.json"),JSON.stringify(original));
  const center = createExtensionCenter(dir);
  try {
    const builtin = (await center.execute()).packages.find(p=>p.builtin);
    assert.equal(builtin.version,"0.8.0");assert.equal(builtin.enabled,true);assert.equal(builtin.loadState,"not-observed");
    for(const enabled of [false,true,false]) {
      await center.execute({operation:"toggle-package",source:builtin.source,enabled});
      const saved=JSON.parse(await readFile(join(dir,"settings.json"),"utf8"));
      assert.equal(saved.eido.builtinPackages.oneCode.enabled,enabled);
      delete saved.eido.builtinPackages;assert.deepEqual(saved,original);
      assert.equal((await createExtensionCenter(dir).execute()).packages.find(p=>p.builtin).enabled,enabled);
    }
    await assert.rejects(center.execute({operation:"remove",source:builtin.source}),/bundled/);
  } finally {await rm(dir,{recursive:true,force:true});}
});


test("legacy One Code disabled choices agree in cards and load views until explicitly overridden", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eido-one-code-legacy-"));
  const source = "npm:one-code-extension@0.8.0";
  const shared = {defaultTools:["read", "-edit"],defaultModel:"retained",eido:{fullAccess:true},packages:[]};
  const cases = [
    {...shared,packages:[{source,autoload:false}]},
    {...shared,packages:[source],eido:{...shared.eido,disabledPackages:{[source]:source}}},
    {...shared,packages:[{source,autoload:false}],eido:{...shared.eido,disabledPackages:{[source]:source}}},
  ];
  try {
    for (const original of cases) {
      await writeFile(join(dir,"settings.json"),JSON.stringify(original));
      const center = createExtensionCenter(dir);
      const manager = SettingsManager.create(dir,dir,{projectTrusted:false});
      const describe = oneCodeSettingsView(manager,dir,dir);
      const verify = expected => {
        assert.equal(describe().enabled,expected);
        assert.equal(oneCodeDescriptor(original,runtimeRoot,dir).enabled,false);
        const view = manager.getGlobalSettings();
        assert.deepEqual(view.packages,[]);
        assert.equal(view.extensions.filter(path=>path.startsWith(describe().path + '/')).length,expected?13:0);
      };
      verify(false);
      assert.equal((await center.execute()).packages.find(p=>p.source===ONE_CODE_ID).enabled,false);
      await manager.reload();verify(false);
      for(const enabled of [true,false]) {
        await center.execute({operation:"toggle-package",source:ONE_CODE_ID,enabled});
        await manager.reload();verify(enabled);
        const saved=JSON.parse(await readFile(join(dir,"settings.json"),"utf8"));
        const fresh=SettingsManager.inMemory(saved,{projectTrusted:false});
        const freshDescriptor=oneCodeSettingsView(fresh,dir,dir);
        assert.equal(freshDescriptor().enabled,enabled,"new tasks share the same legacy/explicit precedence");
        assert.equal((await createExtensionCenter(dir).execute()).packages.find(p=>p.source===ONE_CODE_ID).enabled,enabled);
        delete saved.eido.builtinPackages;assert.deepEqual(saved,original);
      }
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("One Code local source variants dedupe before package resolution with pi scope bases", async () => {
  const dir = await mkdtemp(join(tmpdir(),"eido-one-code-paths-"));
  const agentDir=join(dir,"global"),cwd=join(dir,"workspace"),projectDir=join(cwd,".pi");
  const upstream=await realpath(join(runtimeRoot,"packages/acp/node_modules/one-code-extension"));
  const bundled=oneCodeDescriptor().path;
  await mkdir(agentDir);await mkdir(projectDir,{recursive:true});
  await symlink(upstream,join(agentDir,"official"));
  const unrelated=join(projectDir,"official");await mkdir(unrelated);
  await writeFile(join(unrelated,"package.json"),JSON.stringify({name:"unrelated-fixture",version:"1",pi:{extensions:["index.js"]}}));
  await writeFile(join(unrelated,"index.js"),"throw Error('Resolver tests must never execute a factory');");
  await symlink(upstream,join(projectDir,"project-official"));
  const resources = manager => new DefaultPackageManager({cwd,agentDir,settingsManager:manager}).resolve(async()=>"skip");
  const executable = result => result.extensions.filter(item=>item.enabled);
  const fromUpstream = async result => (await Promise.all(executable(result).map(item=>realpath(item.path)))).filter(path=>path.startsWith(upstream + '/'));
  try {
    const baseline=await resources(SettingsManager.inMemory({packages:["official"]},{projectTrusted:false}));
    assert.equal((await fromUpstream(baseline)).length,57,"read-only reproduction of the original factory set");
    for (const source of ["official","./official",join(agentDir,"official"),pathToFileURL(join(agentDir,"official")).href," official "]) {
      const config={packages:[source],extensions:["official/extensions/ui/user-message/index.ts"],defaultTools:["read","-edit"]};
      const manager=SettingsManager.inMemory(config,{projectTrusted:true});
      manager.setProjectPackages(["official","project-official"]);
      await manager.flush();
      const before=manager.getProjectSettings();
      oneCodeSettingsView(manager,agentDir,cwd);
      assert.deepEqual(manager.getProjectSettings().packages,["official"],"same spelling resolves from the project base, not agentDir");
      const resolved=await resources(manager);
      assert.equal((await fromUpstream(resolved)).length,0,source);
      assert.equal(executable(resolved).filter(item=>item.path.startsWith(bundled + '/')).length,13,source);
      assert.ok(executable(resolved).some(item=>item.path===join(unrelated,"index.js")),"unrelated project package stays enabled");
      assert.deepEqual(config.defaultTools,["read","-edit"]);
      assert.deepEqual(before.packages,["official","project-official"]);
    }
    const localDisabled={packages:[{source:"official",autoload:false}]};
    assert.equal(oneCodeDescriptor(localDisabled,runtimeRoot,agentDir).enabled,false,"legacy local disable uses agentDir too");
    assert.equal(oneCodeDescriptor(localDisabled,runtimeRoot,projectDir).enabled,true,"unrelated same-spelled package cannot disable the built-in");
  } finally {await rm(dir,{recursive:true,force:true});}
});
