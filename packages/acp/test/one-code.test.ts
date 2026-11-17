import {test} from 'node:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {stripTypeScriptTypes} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {client,methods} from '@agentclientprotocol/sdk';
import {startEidoAgent} from '../src/server.ts';
import {fixtureModel,declaredTools,call,lastToolText} from './fixture-model.ts';

async function journey(deps: {startEidoAgent:typeof startEidoAgent;fixtureModel:typeof fixtureModel;declaredTools:typeof declaredTools;call:typeof call;lastToolText:typeof lastToolText;client:typeof client;methods:typeof methods;root:string}) {
  const {startEidoAgent, fixtureModel, declaredTools, call, lastToolText, client, methods, root} = deps;
  const assert:typeof import('node:assert/strict') = (await import('node:assert/strict')).default;
  const {mkdtemp,mkdir,writeFile,rm,readFile,realpath} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {spawn} = await import('node:child_process');
  const dir = await realpath(await mkdtemp(join(tmpdir(),'eido-one-code-')));
  const cwdA=join(dir,'workspace-a'), cwdB=join(dir,'workspace-b');
  await mkdir(cwdA);await mkdir(cwdB);
  const prior={pi:process.env.PI_CODING_AGENT_DIR,claude:process.env.CLAUDE_CONFIG_DIR};
  process.env.PI_CODING_AGENT_DIR=dir;process.env.CLAUDE_CONFIG_DIR=join(dir,'claude');
  await mkdir(join(dir,'claude/skills/fixture-guide'),{recursive:true});
  await writeFile(join(dir,'claude/skills/fixture-guide/SKILL.md'),'---\nname: fixture-guide\ndescription: Fixture guide instructions\n---\nEIDO_REAL_SKILL_MARKER: Follow this exact fixture guide.');
  await mkdir(join(dir,'extensions'));
  await writeFile(join(dir,'extensions/fixture.js'),`export default pi => {
    for(const [name,exposure] of [['fixture_deferred','deferred'],['fixture_denied','hidden']]) pi.registerTool({name,label:name,description:name,exposure,parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'EIDO_DEFERRED_RESULT'}]})});
    pi.registerCommand('fixture-tools',{handler:async(_args,ctx)=>ctx.ui.notify('EIDO_TOOLS:'+JSON.stringify(pi.getAllTools()))});
  };`);
  const setting=(enabled=true)=>({defaultProvider:'eido-fixture',defaultModel:'scripted',compaction:{enabled:false},cacheWarming:{enabled:false},eido:{fullAccess:true,builtinPackages:{oneCode:{enabled}}},packages:['npm:one-code-extension@0.8.0']});
  const save=(enabled:boolean)=>writeFile(join(dir,'settings.json'),JSON.stringify(setting(enabled)));
  await save(true);
  const path=join(cwdA,'created.ts');let buffer='',permissions=0;
  const checkEnhanced=(context:Parameters<typeof declaredTools>[0],cwd:string)=>{
    const text=JSON.stringify(context);assert.match(text,/system-reminder/);assert.match(text,/fixture-guide/);
    assert.ok(text.includes(cwd));assert.match(text,/Eido access mode: Full Access/);
    assert.ok(declaredTools(context).includes('skill'));
    for(const message of context.messages)if(message.role==='assistant')assert.equal(message.model,cwd===cwdA?'scripted':'scripted-second');
    return text;
  };
  const steps:Parameters<typeof fixtureModel>[1]=[
    context=>{checkEnhanced(context,cwdA);return call('skill',{skill:'fixture-guide'});},
    context=>{assert.match(JSON.stringify(context),/EIDO_REAL_SKILL_MARKER/);return call('write',{path,content:'export const created = 1;\n'});},
    context=>{lastToolText(context,'write');return call('read',{path});},
    context=>{assert.match(lastToolText(context,'read'),/created = 1/);return call('edit',{path,edits:[{oldText:'created = 1',newText:'created = 2'}]});},
    context=>{lastToolText(context,'edit');return call('bash',{command:'printf EIDO_NATIVE_SHELL_RESULT',files:[]});},
    context=>{assert.match(lastToolText(context,'bash'),/EIDO_NATIVE_SHELL_RESULT/);return call('tool_search',{query:'select:fixture_deferred'});},
    context=>{lastToolText(context,'tool_search');assert.ok(declaredTools(context).includes('fixture_deferred'));assert.ok(!declaredTools(context).includes('fixture_denied'));return call('fixture_deferred');},
    context=>{assert.match(lastToolText(context,'fixture_deferred'),/EIDO_DEFERRED_RESULT/);return 'Native tools and upstream enhancement verified.';},
  ];
  const fixture=await fixtureModel(dir,steps,{modelIds:['scripted','scripted-second']});
  const register=fixture.runtime.registerProvider.bind(fixture.runtime);let providerReplacements=0;
  fixture.runtime.registerProvider=(name,...args)=>{if(name==='anthropic')providerReplacements++;return register(name,...args);};
  const a=new TransformStream(),b=new TransformStream();
  const server=await startEidoAgent(dir,join(dir,'sessions'),{readable:a.readable,writable:b.writable},fixture.runtime);
  const updates:any[]=[],terminals=new Map<string,any>();let tools:any[]=[];
  const connection=client({name:'one-code-fixture'})
    .onNotification(methods.client.session.update,({params})=>{updates.push(params);const u=params.update;if(u.sessionUpdate==='agent_message_chunk'&&u.content.type==='text'&&u.content.text.startsWith('EIDO_TOOLS:'))tools=JSON.parse(u.content.text.slice(11));})
    .onRequest(methods.client.session.requestPermission,()=>{permissions++;return {outcome:{outcome:'selected',optionId:'allow_once'}};})
    .onRequest(methods.client.fs.readTextFile,({params})=>{assert.equal(params.path,path);return {content:buffer,_meta:{...params._meta,'eido.dev/conditionalWrite':true}};})
    .onRequest(methods.client.fs.writeTextFile,({params})=>{assert.equal(params.path,path);buffer=params.content;return {};})
    .onRequest(methods.client.terminal.create,async({params})=>{
      const child=spawn(params.command,params.args??[],{cwd:params.cwd??undefined,stdio:['ignore','pipe','pipe']});
      const id=crypto.randomUUID(),t={child,output:'',exited:false};terminals.set(id,t);
      child.stdout.on('data',data=>{t.output+=data.toString();});child.stderr.on('data',data=>{t.output+=data.toString();});child.on('exit',()=>{t.exited=true;});await new Promise<void>(resolve=>child.once('spawn',resolve));return {terminalId:id};
    })
    .onRequest(methods.client.terminal.output,({params})=>{const t=terminals.get(params.terminalId);return {output:t.output,truncated:false,...(t.exited?{exitStatus:{exitCode:t.child.exitCode??1}}:{})};})
    .onRequest(methods.client.terminal.release,async({params})=>{const t=terminals.get(params.terminalId);if(t&&!t.exited){t.child.kill('SIGTERM');await new Promise<void>(resolve=>t.child.once('exit',resolve));}return {};})
    .connect({readable:b.readable,writable:a.writable});
  const prompt=(id:string,text:string)=>connection.agent.request(methods.agent.session.prompt,{sessionId:id,prompt:[{type:'text',text}]});
  try {
    await connection.agent.request(methods.agent.initialize,{protocolVersion:1,clientCapabilities:{elicitation:{form:{}},fs:{readTextFile:true,writeTextFile:true},terminal:true}});
    const main=await connection.agent.request(methods.agent.session.new,{cwd:cwdA,mcpServers:[]});
    await prompt(main.sessionId,'/fixture-tools');
    const search=tools.filter(tool=>tool.name==='tool_search');assert.equal(search.length,1,JSON.stringify({tools,updates}));assert.match(search[0].sourceInfo.path,/one-code(?:-runtime)?\/eido\/search.ts$/);
    for(const name of ['read','edit','write','bash'])assert.equal(tools.find(tool=>tool.name===name).sourceInfo.source,'sdk');
    await prompt(main.sessionId,'Verify the bundled enhancements.');
    assert.equal(fixture.requests(),8,JSON.stringify(updates));assert.equal(buffer,'export const created = 2;\n');assert.equal(permissions,0);assert.equal(providerReplacements,0);
    await save(false);
    await writeFile(join(dir,'settings.json'),JSON.stringify({...setting(false),defaultModel:'scripted-second'}));
    steps.push(context=>{checkEnhanced(context,cwdA);return 'Current task keeps its extensions until reload.';});
    await prompt(main.sessionId,'Continue before reload.');
    const second=await connection.agent.request(methods.agent.session.new,{cwd:cwdB,mcpServers:[]});
    assert.match(JSON.stringify(second.configOptions?.find(option=>option.id==='model')?.currentValue),/scripted-second/);
    assert.doesNotMatch(JSON.stringify(main.configOptions?.find(option=>option.id==='model')?.currentValue),/scripted-second/);
    steps.push(context=>{assert.ok(!declaredTools(context).includes('skill'));return 'New task disabled.';});
    await prompt(second.sessionId,'Check the disabled task.');
    await prompt(main.sessionId,'/reload');
    steps.push(context=>{assert.ok(!declaredTools(context).includes('skill'));return 'Reload disabled.';});
    await prompt(main.sessionId,'Check the reloaded task.');
    await save(true);await prompt(second.sessionId,'/reload');
    steps.push(context=>{checkEnhanced(context,cwdB);assert.ok(!JSON.stringify(context).includes(cwdA));return 'Second task enabled and isolated.';});
    await prompt(second.sessionId,'Check the enabled task.');
    await connection.agent.request(methods.agent.session.close,{sessionId:main.sessionId});
    await connection.agent.request(methods.agent.session.load,{sessionId:main.sessionId,cwd:cwdA,mcpServers:[]});
    steps.push(context=>{checkEnhanced(context,cwdA);return 'Restored task verified.';});
    await prompt(main.sessionId,'Check restored state.');
    let started!:()=>void;
    const waiting=new Promise<void>(resolve=>{started=resolve;});
    steps.push(async(_context,signal)=>{started();await new Promise<void>(resolve=>signal!.addEventListener('abort',()=>resolve(),{once:true}));return 'Cancelled fixture request.';});
    const cancelled=prompt(main.sessionId,'Wait for cancellation.');
    await waiting;
    steps.push(context=>{checkEnhanced(context,cwdB);return 'Other task progressed during cancellation.';});
    await prompt(second.sessionId,'Continue the independent task.');
    await connection.agent.notify(methods.agent.session.cancel,{sessionId:main.sessionId});
    assert.equal((await cancelled).stopReason,'cancelled');
    assert.equal(fixture.requests(),15);assert.equal(providerReplacements,0);
    const {pathToFileURL}=await import('node:url');
    const {DefaultResourceLoader,SettingsManager}=await import(pathToFileURL(join(root,'packages/acp/node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
    const {oneCodeDescriptor}=await import(pathToFileURL(join(root,'packages/runtime/src/pi/bundled-one-code.mjs')).href);
    const probe=new DefaultResourceLoader({cwd:cwdA,agentDir:dir,settingsManager:SettingsManager.inMemory({}),
      noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,additionalExtensionPaths:[join(oneCodeDescriptor().path,'eido/wire.ts')]});
    await probe.reload();
    assert.deepEqual(probe.getExtensions().errors,[]);
    const wire=probe.getExtensions().extensions[0];
    assert.equal(wire.handlers.has('cache_warming_decision'),false);
    const payload={messages:[{role:'user',content:'Anthropic threads remain native'}]};
    for(const handler of wire.handlers.get('before_provider_request')??[])assert.equal(await handler({payload},{model:{api:'anthropic-messages'}}),undefined);
    assert.deepEqual(payload,{messages:[{role:'user',content:'Anthropic threads remain native'}]});
    assert.doesNotMatch(JSON.stringify(updates),/Failed to load|Extension error|Deterministic model assertion failed/);
    assert.equal(JSON.parse(await readFile(join(dir,'settings.json'),'utf8')).packages[0],'npm:one-code-extension@0.8.0');
  } finally {
    await server.agent.dispose();connection.close();server.connection.close();
    for(const t of terminals.values())if(!t.exited)t.child.kill('SIGTERM');
    if(prior.pi===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=prior.pi;
    if(prior.claude===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=prior.claude;
    await rm(dir,{recursive:true,force:true});
  }
}


test('real bundled One Code skill, native tools, search, settings, reload and session isolation', {timeout:90_000}, async()=>{
  const app=process.env.EIDO_ONE_CODE_APP;
  if(!app)return journey({startEidoAgent,fixtureModel,declaredTools,call,lastToolText,client,methods,root:resolve('.')});
  const root=join(resolve(app),'Contents/Resources/runtime');
  const node=join(resolve(app),'Contents/Helpers/node');
  const entry=(name:string)=>join(root,'packages/acp/node_modules',name,name==='@agentclientprotocol/sdk'?'dist/acp.js':'dist/index.js');
  const dir=await mkdtemp(join(tmpdir(),'eido-one-code-app-fixture-'));
  try {
    // Run the identical journey with the candidate app's Node, ACP and pi graph.
    // Only the existing deterministic model helper is copied, never product code.
    let model=stripTypeScriptTypes(await readFile(new URL('./fixture-model.ts',import.meta.url),'utf8'));
    for(const name of ['@earendil-works/pi-ai','@earendil-works/pi-coding-agent'])model=model.replaceAll('"'+name+'"',JSON.stringify(pathToFileURL(entry(name)).href));
    await writeFile(join(dir,'fixture-model.mjs'),model);
    const script=`import {startEidoAgent} from ${JSON.stringify(pathToFileURL(join(root,'packages/acp/src/server.js')).href)};
import {fixtureModel,declaredTools,call,lastToolText} from './fixture-model.mjs';
import {client,methods} from ${JSON.stringify(pathToFileURL(entry('@agentclientprotocol/sdk')).href)};
const __name=(value)=>value;
${journey.toString()}
await journey({startEidoAgent,fixtureModel,declaredTools,call,lastToolText,client,methods,root:${JSON.stringify(root)}});
console.log('Packaged One Code fixture passed');`;
    await writeFile(join(dir,'journey.mjs'),script);
    const result=await promisify(execFile)(node,[join(dir,'journey.mjs')],{timeout:80_000,env:{...process.env,EIDO_ROOT:root},maxBuffer:2*1024*1024});
    console.log(result.stdout);
  } finally {await rm(dir,{recursive:true,force:true});}
});
