// Adapted from browser-use/jev-ultrafast @ 1231850a0bf1a0c0341fe408ef1668dbbfdfac46.
// Copyright 2026 Browser Use. MIT license in ./LICENSE.
import {setTimeout as delay} from 'node:timers/promises';
import {modelFetch} from './transport.ts';
import {NEXT_ACTION, TARGET, TEXT_VALUE} from './questions.ts';
import {pythonJson} from './json.ts';
import type {Action, Choice, Decision, History, ModelConfig, Operation, Snapshot, TextConfig} from './types.ts';

export async function postJson(config:ModelConfig, body:unknown, signal?:AbortSignal):Promise<any> {
  if (!config.key) throw new Error('Configure the browser model API key in global settings before running this operation.');
  for (let attempt=0; attempt<3; attempt++) {
    signal?.throwIfAborted();
    let response:Awaited<ReturnType<typeof modelFetch>>;
    try {
      response=await modelFetch(config.apiUrl,{method:'POST',headers:{Authorization:`Bearer ${config.key}`,'Content-Type':'application/json'},
        body:JSON.stringify(body),signal:AbortSignal.any([AbortSignal.timeout(25_000),...(signal?[signal]:[])])});
    } catch {signal?.throwIfAborted();throw new Error('Model connection failed; no action executed.');}
    if ([429,529,503].includes(response.status) && attempt<2) {
      await response.body?.cancel(); await delay(500*2**attempt,undefined,{signal});continue;
    }
    if (!response.ok) {await response.body?.cancel();throw new Error(`Model provider returned HTTP ${response.status}; no action executed.`);}
    try {return await response.json();} catch {throw new Error('Invalid model response; no action executed.');}
  }
  throw new Error('Model unavailable');
}

export function validateChoice(answer:unknown, ids:Record<string,unknown>):Choice {
  const a=answer as Choice|undefined, p=a?.probabilities;
  if (!a || !p || typeof a.choice!=='string' || !Object.hasOwn(ids,a.choice)
    || Object.keys(p).length!==Object.keys(ids).length || Object.keys(p).some(k=>!Object.hasOwn(ids,k))
    || [...Object.values(p),a.confidence].some(n=>typeof n!=='number'||!Number.isFinite(n)||n<0||n>1)
    || Math.abs(Object.values(p).reduce((sum,n)=>sum+n,0)-1)>=0.02
    || p[a.choice]! < Math.max(...Object.values(p))-1e-6) throw new Error('Invalid TypeSafe response; no action executed.');
  return a;
}
const pick=(source:Record<string,any>,keys:string[])=>Object.fromEntries(keys.filter(k=>k in source).map(k=>[k,source[k]]));
export function actionSpace(actions:Action[]) {
  const elements:Record<string,any>[]=[]; const indices=new Map<number,string>();
  const targets:Record<string,Record<string,Action>>={}, controls:Record<string,Action>={};
  const operations:Record<string,string>={click:'CLICK',fill:'TYPE_TEXT',select:'SELECT'};
  for (const action of actions) {
    const operation=operations[action.kind];
    if (!operation) {controls[action.id.toUpperCase()]=action;continue;}
    if (!Number.isInteger(action.node)) throw new Error('Invalid observed node');
    let index=indices.get(action.node!);
    if (!index) {
      index=String(elements.length+1);indices.set(action.node!,index);
      const element:Record<string,any>={...pick(action,['role','value','checked','selected','expanded']),index,label:action.label.split(' → ')[0],operations:[]};
      if (action.kind==='select') {element.value=action.current_value??'';element.options=[];}
      elements.push(element);
    }
    const group=targets[operation]??={}; const element=elements[Number(index)-1]!;
    if (!element.operations.includes(operation)) element.operations.push(operation);
    let target=index;
    if (action.kind==='select') {target=`${index}:${element.options.length+1}`;element.options.push({index:target,label:action.label,value:action.value});}
    group[target]=action;
  }
  return {elements,targets,controls};
}
export function choiceRequest(state:Snapshot,goal:string,history:History[],model:string) {
  const {elements,targets,controls}=actionSpace(state.actions);
  const labels:Record<string,string>={CLICK:'Click an element, button, menu option, autocomplete suggestion, or calendar day.',
    TYPE_TEXT:'Enter or replace text in an editable field. A small LLM will supply the value from the goal.',SELECT:'Select an observed dropdown value.'};
  const operations:Record<string,string>={...Object.fromEntries(Object.keys(targets).map(k=>[k,labels[k]!])),
    ...Object.fromEntries(Object.entries(controls).map(([k,v])=>[k,v.label])),DONE:'Every requirement is visibly satisfied.',BLOCKED:'No supported operation can progress.'};
  const questions:Record<string,unknown>={operation:{type:'choice',criteria:operations,instructions:{goal,rules:NEXT_ACTION}}};
  for (const [operation,candidates] of Object.entries(targets)) questions[operation.toLowerCase()+'_target']={type:'choice',
    criteria:Object.fromEntries(Object.entries(candidates).map(([index,a])=>[index,{element:`[${index}] ${a.label}`,current_value:a.current_value??a.value??'',...pick(a,['role','checked','selected','expanded'])}])),
    instructions:{goal,operation,rules:[NEXT_ACTION,TARGET]}};
  const request={model,state:{page:pick(state,['url','title','text']),elements,
    recent_actions:history.slice(-10).map(h=>Object.fromEntries(['action','kind','text','page_changed'].map(k=>[k,h[k]??null])))},questions};
  return {request,operations,targets,controls};
}
export async function choose(state:Snapshot,goal:string,history:History[],config:ModelConfig,signal?:AbortSignal):Promise<Decision> {
  const {request,operations,targets,controls}=choiceRequest(state,goal,history,config.model);
  const started=performance.now(), result=await postJson(config,request,signal);
  const op=validateChoice(result?.answers?.operation,operations), operation=op.choice as Operation;
  let target:string|null=null, head:Choice|null=null, choice:string;const probabilities:Record<string,number>={};
  if (targets[operation]) {
    head=validateChoice(result?.answers?.[operation.toLowerCase()+'_target'],targets[operation]);target=head.choice;
    choice=targets[operation][target]!.id;
    for (const [id,action] of Object.entries(targets[operation])) probabilities[action.id]=head.probabilities[id]!;
  } else {choice=controls[operation]?.id??operation; probabilities[choice]=op.probabilities[operation]!;}
  return {choice,operation,target,confidence:op.confidence,probabilities,operation_probabilities:op.probabilities,
    target_probabilities:head?.probabilities??{},target_confidence:head?.confidence??null,raw_answers:result.answers,
    model:result.model,usage:result.usage??{},latency_ms:Math.round(performance.now()-started),request};
}
export function fieldContext(goal:string,action:Action,page:Snapshot,history:History[]) {
  return {goal,field:Object.fromEntries(['label','role','value'].map(k=>[k,(action as any)[k]??null])),
    page:{title:page.title,text:[...page.text].slice(0,6000).join('')},recent_actions:history.slice(-6).map(h=>({action:h.action??null,text:h.text??null}))};
}
export async function fieldText(context:ReturnType<typeof fieldContext>,config:TextConfig,signal?:AbortSignal) {
  const started=performance.now();let content,model,usage;
  if(config.generate) {
    const result=await config.generate(pythonJson(context),TEXT_VALUE,signal);
    content=result.content;model=result.model;usage=result.usage;
  }else {
    if (!config.key || !config.apiUrl || !config.model) throw new Error('TYPE_TEXT needs a text model. Configure the main language model or the optional Browser Text Model override in global settings; nothing was typed.');
    const base=config.apiUrl.replace(/\/+$/,'');
    const reasoning=config.reasoning==='none'?{reasoning:{enabled:false}}:base.includes('api.deepseek.com/')?{thinking:{type:'disabled'}}:{reasoning:{effort:'low'}};
    const result=await postJson({apiUrl:base+'/chat/completions',key:config.key,model:config.model},{model:config.model,max_tokens:1024,response_format:{type:'json_object'},...reasoning,
      messages:[{role:'system',content:TEXT_VALUE},{role:'user',content:pythonJson(context)}]},signal);
    content=result?.choices?.[0]?.message?.content;model=config.model;usage=result.usage??{};
  }
  let output;
  try {output=JSON.parse(content);} catch {throw new Error('Text helper returned no valid field value; nothing typed.');}
  if (!output || Object.keys(output).length!==1 || typeof output.text!=='string' || !output.text.trim() || [...output.text].length>2000)
    throw new Error('Text helper returned no valid field value; nothing typed.');
  return {text:output.text as string,helper:{model:model as string,latency_ms:Math.round(performance.now()-started),usage}};
}
