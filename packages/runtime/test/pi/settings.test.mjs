import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiSettings, checkPiUpdate, bundledVersion } from "../../src/pi/settings.mjs";
import {computerSettings, computerMcp} from '../../src/computer.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "eido-pi-settings-"));
  t.after(() => rm(root, {recursive:true, force:true}));
  const target = join(root, "target"), source = join(root, "source");
  await mkdir(target); await mkdir(source);
  const put = (dir, name, value) => writeFile(join(dir, name), JSON.stringify(value));
  const get = (dir, name) => readFile(join(dir, name), "utf8").then(JSON.parse);
  const config = {providers:{"eido-fixture":{api:"openai-completions",baseUrl:"https://example.invalid/v1",models:[{id:"test-model",name:"Test",reasoning:false,contextWindow:32000,maxTokens:2048}]}}};
  await put(target, "models.json", config);
  await put(target, "settings.json", {defaultProvider:"eido-fixture",defaultModel:"test-model",defaultThinkingLevel:"off",customSetting:{retain:true}});
  return {target,source,put,get,config,bridge:createPiSettings(target,source)};
}

test('Computer Use uses one global executable, reports absence and rejects stale settings', async t => {
  const f = await fixture(t);
  assert.equal((await computerSettings(f.target, {PATH:''})).enabled, false);
  const initial = await f.bridge.execute({operation:'status'});
  const configured = await f.bridge.execute({operation:'computer-use', path:process.execPath, enabled:true, expected:initial.computerUseRevision});
  assert.equal(configured.computerUse.status, 'configured');
  assert.deepEqual(await computerMcp(f.target), [{name:'eido_computer', command:process.execPath, args:['mcp'], env:[]}]);
  await assert.rejects(f.bridge.execute({operation:'computer-use', path:'relative', enabled:true}), /absolute/);
  await assert.rejects(f.bridge.execute({operation:'computer-use', path:process.execPath, enabled:false, expected:null}), /changed/);
  await f.bridge.execute({operation:'computer-use', path:join(f.target,'absent-driver'), enabled:true, expected:configured.computerUseRevision});
  assert.equal((await computerSettings(f.target)).status, 'not_installed');
  assert.deepEqual(await computerMcp(f.target), []);
  assert.deepEqual((await f.get(f.target,'settings.json')).customSetting, {retain:true});
});

test('bundled desktop runtime owns its MCP child and custom paths retain precedence', async t => {
  const f = await fixture(t);
  const root = join(f.target, 'Eido.app/Contents/Resources/runtime');
  const helper = join(f.target, 'Eido.app/Contents/Helpers/cua-driver-local');
  await mkdir(join(f.target, 'Eido.app/Contents/Helpers'), {recursive:true});
  await writeFile(helper, '#!/bin/sh\nexit 0\n', {mode:0o755});
  await f.put(f.target, 'settings.json', {eido:{computerUse:{enabled:true}}});
  assert.equal((await computerSettings(f.target, {PATH:''}, root)).executable, helper);
  const bundled = (await computerMcp(f.target, root))[0];
  assert.deepEqual(bundled.args, ['mcp','--direct']);
  assert.deepEqual(bundled.env, [{name:'CUA_DRIVER_EMBEDDED',value:'1'}, {name:'CUA_DRIVER_HOST_BUNDLE_ID',value:'dev.eido.app'}]);
  await f.put(f.target, 'settings.json', {eido:{computerUse:{enabled:true,path:process.execPath}}});
  assert.equal((await computerMcp(f.target, root))[0].command, process.execPath);
  assert.deepEqual((await computerMcp(f.target, root))[0].args, ['mcp']);
  await f.put(f.target, 'settings.json', {eido:{computerUse:{enabled:false}}});
  assert.deepEqual(await computerMcp(f.target, root), []);
});

test("defaults roundtrip uses pi model validation and preserves unrelated settings", async t => {
  const f=await fixture(t);
  const result=await f.bridge.execute({operation:"defaults",provider:"eido-fixture",model:"test-model",thinking:"off"});
  assert.equal(result.version,"1.0.4");
  assert.equal(result.defaultModel,"test-model");
  assert.deepEqual((await f.get(f.target,"settings.json")).customSetting,{retain:true});
  const before=await readFile(join(f.target,"settings.json"),"utf8");
  await assert.rejects(f.bridge.execute({operation:"defaults",provider:"eido-fixture",model:"missing",thinking:"off"}));
  assert.equal(await readFile(join(f.target,"settings.json"),"utf8"),before);
});

test('model overrides use pi precedence and preserve other models and concurrent fields', async t => {
  const f = await fixture(t);
  const id = 'family/model.v1';
  f.config.providers['eido-fixture'].models.push({id, name:'Thinking fixture', reasoning:true, contextWindow:64000, maxTokens:4096});
  await f.put(f.target, 'models.json', f.config);
  const original = await f.get(f.target, 'settings.json');
  original.compaction = {reserveTokens:2048, keepRecentTokens:8192,
    modelOverrides:{'other/provider-model':{reserveTokens:100}}};
  original.modelThinkingLevels = {'other/provider-model':'high'};
  await f.put(f.target, 'settings.json', original);
  const model = status => status.providers.find(p=>p.id==='eido-fixture').models.find(m=>m.id===id);
  const initial = model(await f.bridge.status()).settings;
  assert.deepEqual(initial.values, {thinkingLevel:null, reserveTokens:null, keepRecentTokens:null});
  assert.deepEqual(initial.effective, {reserveTokens:2048, keepRecentTokens:8192});
  const update = (changes, expected) => f.bridge.execute({operation:'model-settings',provider:'eido-fixture',model:id,changes,expected});
  const changed = {thinkingLevel:'high',reserveTokens:4096};
  let result = await update(changed, initial.values);
  assert.equal(model(result).settings.values.thinkingLevel,'high');
  assert.deepEqual(model(result).settings.effective, {reserveTokens:4096,keepRecentTokens:8192});
  let stored = await f.get(f.target,'settings.json');
  assert.equal(stored.compaction.modelOverrides['eido-fixture/'+id].reserveTokens,4096);
  assert.equal(stored.compaction.modelOverrides['other/provider-model'].reserveTokens,100);
  assert.equal(stored.modelThinkingLevels['other/provider-model'],'high');
  assert.equal(stored.defaultThinkingLevel,'off');
  assert.equal(stored.customSetting.retain,true);
  const saved = await readFile(join(f.target,'settings.json'),'utf8');
  for (const changes of [{thinkingLevel:'not-a-level'},{reserveTokens:-1},{keepRecentTokens:0.1},{other:true}]) {
    await assert.rejects(update(changes,model(result).settings.values));
    assert.equal(await readFile(join(f.target,'settings.json'),'utf8'),saved);
  }
  await assert.rejects(update({reserveTokens:6000},initial.values),/changed while/);
  await assert.rejects(f.bridge.execute({operation:'model-settings',provider:'eido-fixture',model:'test-model',changes:{thinkingLevel:'high'},expected:{thinkingLevel:null}}));
  // An unrelated field written since opening must survive a sparse save.
  stored.compaction.modelOverrides['eido-fixture/'+id].keepRecentTokens = 9999;
  await f.put(f.target,'settings.json',stored);
  result = await update({reserveTokens:null,thinkingLevel:null},model(result).settings.values);
  assert.equal(model(result).settings.effective.keepRecentTokens,9999);
  await update({keepRecentTokens:null},model(result).settings.values);
  assert.deepEqual(await f.get(f.target,'settings.json'),original);
});

test('tool defaults preserve modifiers, explicit empty lists and concurrent edits', async t => {
  const f = await fixture(t);
  assert.equal((await f.bridge.status()).defaultTools, null);
  const tools = ['+codemode','-edit','+custom_tool','mcp__fixture__*'];
  assert.deepEqual((await f.bridge.execute({operation:'tool-defaults',tools,expected:null})).defaultTools,tools);
  assert.equal((await f.get(f.target,'settings.json')).customSetting.retain,true);
  await assert.rejects(f.bridge.execute({operation:'tool-defaults',tools:[],expected:null}),/changed while/);
  for (const invalid of [['bad name'],['+'],[''], 'read', Array(257).fill('read')]) {
    await assert.rejects(f.bridge.execute({operation:'tool-defaults',tools:invalid,expected:tools}));
    assert.deepEqual((await f.bridge.status()).defaultTools,tools);
  }
  assert.deepEqual((await f.bridge.execute({operation:'tool-defaults',tools:[],expected:tools})).defaultTools,[]);
  assert.equal((await f.bridge.execute({operation:'tool-defaults',tools:null,expected:[]})).defaultTools,null);
  assert.equal(Object.hasOwn(await f.get(f.target,'settings.json'),'defaultTools'),false);
});

test('runtime controls save sparse pi settings, validate values and reject stale fields', async t => {
  const f=await fixture(t);
  const original=await f.get(f.target,'settings.json');
  original.compaction={modelOverrides:{'eido-fixture/test-model':{reserveTokens:555}}};
  original.retry={provider:{maxRetries:7}};
  await f.put(f.target,'settings.json',original);
  const before=(await f.bridge.status()).runtime;
  assert.equal(before.find(field=>field.path==='images.autoResize').effective,true);
  const expected=Object.fromEntries(before.map(field=>[field.path,field.value]));
  const changes={'transport':'sse','images.blockImages':true,'retry.baseDelayMs':100,'thinkingBudgets.low':2048,
    'branchSummary.reserveTokens':4096,'branchSummary.skipPrompt':true,'steeringMode':'all','followUpMode':'one-at-a-time'};
  const result=await f.bridge.execute({operation:'runtime',changes,expected});
  for(const [path,value] of Object.entries(changes)) assert.equal(result.runtime.find(field=>field.path===path).effective,value);
  let stored=await f.get(f.target,'settings.json');
  assert.deepEqual(stored.compaction,original.compaction);
  assert.equal(stored.retry.provider.maxRetries,7);
  assert.equal(stored.customSetting.retain,true);
  const saved=await readFile(join(f.target,'settings.json'),'utf8');
  for(const changes of [{'transport':'invalid'},{'steeringMode':'invalid'},{'followUpMode':2},{'images.blockImages':1},{'retry.maxRetries':-1},{'retry.maxRetries':1.5},{'eido.fullAccess':true},{'thinkingBudgets.low':Infinity}]) {
    await assert.rejects(f.bridge.execute({operation:'runtime',changes,expected}));
    assert.equal(await readFile(join(f.target,'settings.json'),'utf8'),saved);
  }
  await assert.rejects(f.bridge.execute({operation:'runtime',changes:{transport:'auto'},expected}),/changed while/);
  await f.bridge.execute({operation:'runtime',changes:{transport:null},expected:{transport:'sse'}});
  stored=await f.get(f.target,'settings.json');
  assert.equal(Object.hasOwn(stored,'transport'),false);
  assert.equal(stored.images.blockImages,true);
  await f.bridge.execute({operation:'runtime',changes:{'images.blockImages':null},expected:{'images.blockImages':true}});
  assert.equal(Object.hasOwn(await f.get(f.target,'settings.json'),'images'),false);
});

test('HTTP proxy settings hide credentials, preserve unrelated fields and reject stale saves', async t => {
  const f = await fixture(t);
  const original = await f.get(f.target, 'settings.json');
  const initial = (await f.bridge.status()).httpProxy;
  assert.equal(initial.configured, false);
  const proxy = 'http://fixture-user:fixture-secret@127.0.0.1:19002';
  const saved = await f.bridge.execute({operation:'http-proxy', proxy, expected:initial.revision});
  assert.equal(saved.httpProxy.configured, true);
  assert.ok(!JSON.stringify(saved).includes('fixture-secret'));
  assert.ok(!JSON.stringify(saved).includes('fixture-user'));
  assert.deepEqual(await f.get(f.target,'settings.json'), {...original, httpProxy:proxy});
  await assert.rejects(f.bridge.execute({operation:'http-proxy', proxy:null, expected:initial.revision}), /changed while/);
  for (const invalid of ['', 10, 'socks5://localhost:8080', 'https://host.invalid/path', 'http://host.invalid/?secret=fixture-secret', 'malformed fixture-secret']) {
    await assert.rejects(f.bridge.execute({operation:'http-proxy',proxy:invalid,expected:saved.httpProxy.revision}), error => !error.message.includes('fixture-secret'));
    assert.equal((await f.get(f.target,'settings.json')).httpProxy,proxy);
  }
  const removed = await f.bridge.execute({operation:'http-proxy',proxy:null,expected:saved.httpProxy.revision});
  assert.equal(removed.httpProxy.configured,false);
  assert.deepEqual(await f.get(f.target,'settings.json'),original);
  assert.equal((await stat(join(f.target,'settings.json'))).mode&0o777,0o600);
});

test("auth responses contain metadata only; edits preserve other providers, OAuth and env mappings", async t => {
  const f=await fixture(t);
  const oauth={type:"oauth",access:"private-access-fixture",refresh:"private-refresh-fixture",expires:9999999999999};
  await f.put(f.target,"auth.json",{"eido-fixture":{type:"api_key",key:"old-key-fixture",env:{FOO:"retain-env-fixture"}},anthropic:oauth});
  const result=await f.bridge.execute({operation:"key",provider:"eido-fixture",key:"new-key-fixture"});
  for(const secret of ["new-key-fixture","private-access-fixture","private-refresh-fixture","retain-env-fixture"]) assert.ok(!JSON.stringify(result).includes(secret));
  const auth=await f.get(f.target,"auth.json");
  assert.deepEqual(auth.anthropic,oauth);
  assert.deepEqual(auth["eido-fixture"],{type:"api_key",key:"new-key-fixture",env:{FOO:"retain-env-fixture"}});
  assert.equal((await stat(join(f.target,"auth.json"))).mode&0o777,0o600);
  await f.bridge.execute({operation:"remove-key",provider:"eido-fixture"});
  assert.deepEqual(await f.get(f.target,"auth.json"),{anthropic:oauth});
});

test("custom model editing preserves pi advanced parameters and other models", async t => {
  const f=await fixture(t);
  f.config.providers["eido-fixture"].headers={"X-Test":"retain"};
  await f.put(f.target,"models.json",f.config);
  await f.bridge.execute({operation:"custom-model",provider:"eido-fixture",baseUrl:"https://example.invalid/v2",api:"openai-completions",model:"test-model",name:"Updated"});
  await f.bridge.execute({operation:"custom-model",provider:"eido-fixture",baseUrl:"https://example.invalid/v2",api:"openai-completions",model:"second-model"});
  const provider=(await f.get(f.target,"models.json")).providers["eido-fixture"];
  assert.equal(provider.models.length,2);
  assert.equal(provider.models[0].contextWindow,32000);
  assert.deepEqual(provider.headers,{"X-Test":"retain"});
  const before=await readFile(join(f.target,"models.json"),"utf8");
  await assert.rejects(f.bridge.execute({operation:"custom-model",provider:"eido-fixture",baseUrl:"file:///tmp/test",api:"openai-completions",model:"bad"}));
  assert.equal(await readFile(join(f.target,"models.json"),"utf8"),before);
});

test("import merges models and all auth without mutating the source or dropping target settings", async t => {
  const f=await fixture(t);
  const sourceModel={providers:{"eido-fixture":{api:"openai-completions",baseUrl:"https://example.invalid/v1",models:[{id:"source-model",reasoning:false}]}}};
  const oauth={type:"oauth",access:"fixture-access",refresh:"fixture-refresh",expires:9999999999999};
  await f.put(f.source,"models.json",sourceModel);
  await f.put(f.source,"settings.json",{defaultProvider:"eido-fixture",defaultModel:"source-model",defaultThinkingLevel:"off"});
  await f.put(f.source,"auth.json",{anthropic:oauth,"eido-fixture":{type:"api_key",key:"ENV_FIXTURE"}});
  await f.put(f.target,"auth.json",{openai:{type:"api_key",key:"keep-key"}});
  const before=await Promise.all(["models.json","settings.json","auth.json"].map(n=>readFile(join(f.source,n),"utf8")));
  const result=await f.bridge.execute({operation:"import"});
  assert.equal(result.defaultModel,"source-model");
  assert.equal(result.providers.find(p=>p.id==="eido-fixture").models.length,2);
  assert.deepEqual((await f.get(f.target,"auth.json")).anthropic,oauth);
  assert.equal((await f.get(f.target,"auth.json")).openai.key,"keep-key");
  assert.equal((await f.get(f.target,"settings.json")).customSetting.retain,true);
  assert.deepEqual(await Promise.all(["models.json","settings.json","auth.json"].map(n=>readFile(join(f.source,n),"utf8"))),before);
  assert.deepEqual((await readdir(f.source)).sort(),["auth.json","models.json","settings.json"]);
});

test("invalid import validates all inputs before changing destination files", async t => {
  const f=await fixture(t);
  await f.put(f.target,"auth.json",{openai:{type:"api_key",key:"keep-key"}});
  await f.put(f.source,"settings.json",{defaultProvider:"eido-fixture",defaultModel:"missing"});
  const before=await Promise.all(["models.json","settings.json","auth.json"].map(n=>readFile(join(f.target,n),"utf8")));
  await assert.rejects(f.bridge.execute({operation:"import"}));
  assert.deepEqual(await Promise.all(["models.json","settings.json","auth.json"].map(n=>readFile(join(f.target,n),"utf8"))),before);
  assert.deepEqual(await readdir(f.source),["settings.json"]);
  await f.put(f.source,"settings.json",{});
  await writeFile(join(f.target,"settings.json"),"{invalid-json");
  const models=await readFile(join(f.target,"models.json"),"utf8");
  await assert.rejects(f.bridge.execute({operation:"import"}));
  assert.equal(await readFile(join(f.target,"models.json"),"utf8"),models);
});

test("update detection compares registry versions without installing packages", async () => {
  const response=version=>async (url,options)=>{
    assert.equal(url,"https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest");
    assert.equal(options.redirect,"error");
    return {ok:true,json:async()=>({name:"@earendil-works/pi-coding-agent",version})};
  };
  assert.equal((await checkPiUpdate(response(bundledVersion))).status,"up_to_date");
  assert.equal((await checkPiUpdate(response("1.0.5"))).status,"update_available");
  assert.equal((await checkPiUpdate(response("0.99.9"))).status,"ahead");
  const failed=await checkPiUpdate(async()=>{throw new Error("private-network-error")});
  assert.equal(failed.status,"error"); assert.ok(!JSON.stringify(failed).includes("private-network-error"));
});


test("Full Access persists globally, validates booleans and survives model setting writes", async t => {
  const f = await fixture(t);
  assert.equal((await f.bridge.status()).fullAccess, false);
  assert.equal((await f.bridge.execute({operation:"access", fullAccess:true})).fullAccess, true);
  assert.deepEqual((await f.get(f.target,"settings.json")).customSetting, {retain:true});
  await f.bridge.execute({operation:"defaults", provider:"eido-fixture", model:"test-model", thinking:"off"});
  assert.equal((await f.bridge.status()).fullAccess, true);
  await assert.rejects(f.bridge.execute({operation:"access", fullAccess:"true"}));
  assert.equal((await f.bridge.status()).fullAccess, true);
  assert.equal((await f.bridge.execute({operation:"access", fullAccess:false})).fullAccess, false);
  assert.equal((await stat(join(f.target,"settings.json"))).mode & 0o777, 0o600);
});

test("Jev configuration uses global settings and pi credentials without exposing keys", async t => {
  const f = await fixture(t);
  const {browserDecisionEnvironment} = await import('../../src/browser/config.mjs');
  const result = await f.bridge.execute({operation: 'browser-decision', apiUrl: 'http://127.0.0.1:19001/v1/systemone', model: 'jev-fixture', key: 'fixture-jev-secret'});
  assert.equal(result.browserDecision.credential, 'configured');
  assert.ok(!JSON.stringify(result).includes('fixture-jev-secret'));
  assert.equal(result.defaultModel, 'test-model');
  assert.equal((await f.get(f.target, 'settings.json')).customSetting.retain, true);
  const env = await browserDecisionEnvironment(f.target);
  assert.deepEqual(env, {JEV_API_URL:'http://127.0.0.1:19001/v1/systemone', JEV_MODEL:'jev-fixture', TYPESAFE_API_KEY:'fixture-jev-secret'});
  assert.equal((await stat(join(f.target, 'auth.json'))).mode & 0o777, 0o600);
  await f.bridge.execute({operation:'browser-decision', apiUrl:'https://example.invalid/v1/systemone', model:'jev-new', key:''});
  assert.equal((await browserDecisionEnvironment(f.target)).TYPESAFE_API_KEY, 'fixture-jev-secret');
  const before = await readFile(join(f.target,'settings.json'),'utf8');
  await assert.rejects(f.bridge.execute({operation:'browser-decision', apiUrl:'file:///private', model:'jev-new', key:'new-secret'}));
  assert.equal(await readFile(join(f.target,'settings.json'),'utf8'), before);
  assert.equal((await browserDecisionEnvironment(f.target)).TYPESAFE_API_KEY, 'fixture-jev-secret');
  await f.put(f.target, 'auth.json', {'eido-jev': {type:'api_key',key:'${EIDO_JEV_TEST_KEY}',env:{EIDO_JEV_TEST_KEY:'fixture-resolved-secret'}}});
  assert.equal((await browserDecisionEnvironment(f.target)).TYPESAFE_API_KEY, 'fixture-resolved-secret');
  await f.bridge.execute({operation:'browser-decision', apiUrl:'https://example.invalid/v1/systemone', model:'jev-new', removeKey:true});
  assert.equal((await f.get(f.target, 'auth.json'))['eido-jev'], undefined);
});
