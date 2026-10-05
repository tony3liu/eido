import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {closeSync, fsyncSync, openSync} from 'node:fs';
import {RequestError, type PromptRequest, type PromptResponse} from '@agentclientprotocol/sdk';
import type {AgentSession} from '@earendil-works/pi-coding-agent';

export const DELIVERY = Symbol.for('eido.pi.delivery');
export const DELIVERY_RECORD = 'eido.delivery.v1';
type Receipt = {sessionId:string; id:string; hash:string; state:'accepted'|'completed'|'interrupted'|'unclaimed'; response?:PromptResponse};
type SteeringResponse = {outcome:'injected'}|{outcome:'promptRequired';reason:'noRunningTurn'};
type Steering = {receipt:Receipt; entered:boolean; queued:boolean; completed:boolean};

/** Receipts live in pi's journal, outside the model context and across tree navigation. */
export function createDeliveryLedger(pi:AgentSession, changed:(id:string,state:string)=>void=()=>{},
  consumed:(message:Parameters<AgentSession['sessionManager']['appendMessage']>[0],entryId:string)=>void=()=>{}) {
  const receipts = new Map<string,Receipt>();
  const running = new Set<string>();
  const steering = new Map<string,Steering>();
  const enqueueContext = new AsyncLocalStorage<Steering>();
  const messageOwners = new WeakMap<object,Steering>();
  for(const entry of pi.sessionManager.getEntries()) {
    if(entry.type==='custom'&&entry.customType===DELIVERY_RECORD) {
      const receipt=entry.data as Receipt;
      if(receipt?.sessionId===pi.sessionId&&typeof receipt.id==='string')receipts.set(receipt.id,receipt);
    }
  }
  const record=(receipt:Receipt)=>{
    receipts.set(receipt.id,receipt);
    pi.sessionManager.appendCustomEntry(DELIVERY_RECORD,receipt);
    const file=pi.sessionManager.getSessionFile();
    if(!file)throw new Error('Delivery requires a persistent pi session.');
    const fd=openSync(file,'r');
    try{fsyncSync(fd);}finally{closeSync(fd);}
  };
  const identify=(params:PromptRequest)=>{
    const id=params._meta?.eidoDeliveryId;
    if(id===undefined)return;
    if(typeof id!=='string'||! /^[a-zA-Z0-9-]{1,128}$/.test(id))throw new RequestError(-32602,'Invalid delivery ID.');
    const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
      ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,canonical(value)])):value;
    const hash=createHash('sha256').update(JSON.stringify(canonical(params.prompt))).digest('hex');
    const legacyHash=createHash('sha256').update(JSON.stringify(params.prompt)).digest('hex');
    const previous=receipts.get(id);
    if(previous&&previous.hash!==hash&&previous.hash!==legacyHash)throw new RequestError(-32602,'This delivery ID belongs to a different message.');
    return {receipt:{sessionId:pi.sessionId,id,hash,state:'accepted'} as Receipt,previous};
  };
  const ambiguous=()=>new RequestError(-32602,'Delivery may already have run. Review the agent history before sending a new message.');
  const finishSteering=(item:Steering,state:'completed'|'interrupted')=>{
    record({...item.receipt,state,response:state==='completed'?{stopReason:'end_turn'}:undefined});
    item.completed=state==='completed';running.delete(item.receipt.id);steering.delete(item.receipt.id);
    changed(item.receipt.id,state);
  };
  // Keep IDs out of model messages. Track the actual transformed pi message by
  // object identity, then acknowledge only after pi writes it to its journal.
  const queue=pi.agent.steer.bind(pi.agent);
  pi.agent.steer=message=>{
    const item=enqueueContext.getStore();
    if(item){item.queued=true;messageOwners.set(message,item);}
    queue(message);
  };
  const steer=pi.steer.bind(pi);
  pi.steer=async(...args)=>{
    const item=enqueueContext.getStore();if(item)item.entered=true;
    return steer(...args);
  };
  const append=pi.sessionManager.appendMessage.bind(pi.sessionManager);
  pi.sessionManager.appendMessage=message=>{
    const entry=append(message),item=messageOwners.get(message);
    if(item){
      messageOwners.delete(message);
      finishSteering(item,'completed');
      consumed(message,entry);
    }
    return entry;
  };
  return {
    dispose(){enqueueContext.disable();},
    turnEnded(){
      for(const item of [...steering.values()]) {
        if(!item.queued||item.completed)continue;
        try{finishSteering(item,'interrupted');}catch(error){console.error('Could not persist interrupted boundary delivery',error);}
      }
    },
    status(ids:string[]) {
      return {deliveries:ids.map(id=>({id,state:running.has(id)?'running':receipts.get(id)?.state==='accepted'?'interrupted':receipts.get(id)?.state==='unclaimed'?'unknown':receipts.get(id)?.state??'unknown'}))};
    },
    async deliver(params:PromptRequest, invoke:()=>Promise<PromptResponse>) {
      const identity=identify(params);if(!identity)return invoke();
      const {receipt,previous}=identity;
      if(previous&&previous.state!=='unclaimed') {
        if(previous.state==='completed'&&previous.response)return structuredClone(previous.response);
        throw ambiguous();
      }
      record(receipt);running.add(receipt.id);
      try {
        const response=await invoke();
        record({...receipt,state:response.stopReason==='end_turn'?'completed':'interrupted',response});
        return response;
      } catch(error) {
        record({...receipt,state:'interrupted'});
        throw error;
      } finally {running.delete(receipt.id);}
    },
    async steer(params:PromptRequest,invoke:()=>Promise<SteeringResponse>):Promise<SteeringResponse> {
      if(params.prompt.find(block=>block.type==='text')?.text.trimStart().startsWith('/'))
        throw new RequestError(-32602,'Slash commands must run after the current turn. Use the native command queue.');
      const identity=identify(params);if(!identity)return invoke();
      const {receipt,previous}=identity;
      if(previous&&previous.state!=='unclaimed') {
        if(previous.state==='completed')return {outcome:'injected'};
        if(steering.has(receipt.id))return {outcome:'injected'};
        throw ambiguous();
      }
      record(receipt);running.add(receipt.id);
      const item:Steering={receipt,entered:false,queued:false,completed:false};
      steering.set(receipt.id,item);
      try {
        const result=await enqueueContext.run(item,invoke);
        if(item.completed)return {outcome:'injected'};
        if(item.entered&&!item.queued){finishSteering(item,'completed');return {outcome:'injected'};}
        if(result.outcome==='promptRequired') {
          if(item.queued){finishSteering(item,'interrupted');throw ambiguous();}
          record({...receipt,state:'unclaimed'});running.delete(receipt.id);steering.delete(receipt.id);
        }
        return result;
      }catch(error){if(!item.completed)finishSteering(item,'interrupted');throw error;}
    },
  };
}
