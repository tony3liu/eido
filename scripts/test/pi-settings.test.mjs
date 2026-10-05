import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiSettings, checkPiUpdate, bundledVersion } from "../pi-settings.mjs";

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

test("defaults roundtrip uses pi model validation and preserves unrelated settings", async t => {
  const f=await fixture(t);
  const result=await f.bridge.execute({operation:"defaults",provider:"eido-fixture",model:"test-model",thinking:"off"});
  assert.equal(result.version,"1.0.2");
  assert.equal(result.defaultModel,"test-model");
  assert.deepEqual((await f.get(f.target,"settings.json")).customSetting,{retain:true});
  const before=await readFile(join(f.target,"settings.json"),"utf8");
  await assert.rejects(f.bridge.execute({operation:"defaults",provider:"eido-fixture",model:"missing",thinking:"off"}));
  assert.equal(await readFile(join(f.target,"settings.json"),"utf8"),before);
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
  assert.equal((await checkPiUpdate(response("1.0.3"))).status,"update_available");
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
  const {browserDecisionEnvironment} = await import('../browser-config.mjs');
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
