import {createHash} from 'node:crypto';
import {closeSync, fsyncSync, openSync} from 'node:fs';
import {RequestError, type PromptRequest, type PromptResponse} from '@agentclientprotocol/sdk';
import type {AgentSession} from '@earendil-works/pi-coding-agent';

export const DELIVERY = Symbol.for('eido.pi.delivery');
export const DELIVERY_RECORD = 'eido.delivery.v1';
type Receipt = {sessionId:string; id:string; hash:string; state:'accepted'|'completed'|'interrupted'; response?:PromptResponse};

/** Receipts live in pi's journal, outside the model context and across tree navigation. */
export function createDeliveryLedger(pi:AgentSession) {
  const receipts = new Map<string,Receipt>();
  const running = new Set<string>();
  for(const entry of pi.sessionManager.getEntries()) {
    if(entry.type==='custom'&&entry.customType===DELIVERY_RECORD) {
      const receipt=entry.data as Receipt;
      if(receipt?.sessionId===pi.sessionId&&typeof receipt.id==='string')receipts.set(receipt.id,receipt);
    }
  }
  const record=(receipt:Receipt)=>{
    pi.sessionManager.appendCustomEntry(DELIVERY_RECORD,receipt);
    // Do not start tools until the receipt is on disk. A failed write leaves
    // an ambiguous in-memory receipt, which also blocks a blind replay.
    receipts.set(receipt.id,receipt);
    const file=pi.sessionManager.getSessionFile();
    if(!file)throw new Error('Delivery requires a persistent pi session.');
    const fd=openSync(file,'r');
    try{fsyncSync(fd);}finally{closeSync(fd);}
  };
  return {
    status(ids:string[]) {
      return {deliveries:ids.map(id=>({id,state:running.has(id)?'running':receipts.get(id)?.state==='accepted'?'interrupted':receipts.get(id)?.state??'unknown'}))};
    },
    async deliver(params:PromptRequest, invoke:()=>Promise<PromptResponse>) {
      const id=params._meta?.eidoDeliveryId;
      if(id===undefined)return invoke();
      if(typeof id!=='string'||! /^[a-zA-Z0-9-]{1,128}$/.test(id))throw new RequestError(-32602,'Invalid delivery ID.');
      const hash=createHash('sha256').update(JSON.stringify(params.prompt)).digest('hex');
      const previous=receipts.get(id);
      if(previous) {
        if(previous.hash!==hash)throw new RequestError(-32602,'This delivery ID belongs to a different message.');
        if(previous.state==='completed'&&previous.response)return structuredClone(previous.response);
        throw new RequestError(-32602,'Delivery may already have run. Review the agent history before sending a new message.');
      }
      const receipt:Receipt={sessionId:pi.sessionId,id,hash,state:'accepted'};
      // Reserve before writing so a persistence error cannot enable a retry.
      receipts.set(id,receipt);
      record(receipt);running.add(id);
      try {
        const response=await invoke();
        record({...receipt,state:response.stopReason==='end_turn'?'completed':'interrupted',response});
        return response;
      } catch(error) {
        record({...receipt,state:'interrupted'});
        throw error;
      } finally {running.delete(id);}
    },
  };
}
