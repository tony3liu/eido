import {readResearchConfig,resolveResearchAuth,ResearchError} from './config.mjs';
import {ResearchUsage} from './usage.mjs';
import {researchRoot,withResearchLock,readJsonFile,atomicJson} from './store.mjs';
import {join} from 'node:path';
import {parseOcrResponse} from './ocr.mjs';

export function searchInput(input) {
  const query=input?.query, count=input?.count??5;
  if(typeof query!=='string'||!query.trim()||Array.from(query).length>128||!Number.isInteger(count)||count<1||count>50||
      input.need_content!==undefined&&typeof input.need_content!=='boolean') throw new ResearchError('invalid_request','Search needs 1–128 Unicode characters and a count from 1 to 50.');
  return {query,count,need_content:input.need_content??false};
}
export function fetchInput(input) {
  let url;
  try {url=new URL(input?.url);}catch{}
  if(typeof input?.url!=='string'||input.url.length>8192||!url?.hostname||!['http:','https:'].includes(url.protocol)||url.username||url.password) throw new ResearchError('invalid_request','Fetch needs an HTTP(S) URL without credentials, at most 8192 characters.');
  return {url:url.href};
}
export function utf8Prefix(text,limit) {
  const bytes=Buffer.from(text);let end=Math.min(bytes.length,limit);
  while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;
  return bytes.subarray(0,end).toString('utf8');
}
async function responseBytes(response,limit,signal) {
  const reader=response.body?.getReader();if(!reader)return Buffer.alloc(0);
  const chunks=[];let size=0;
  try {while(true){signal.throwIfAborted();const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new ResearchError('response_limit','Research response exceeded the configured size limit.');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  return Buffer.concat(chunks);
}
function validate(kind,data) {
  if(!data||typeof data!=='object'||Array.isArray(data))throw new ResearchError('invalid_response','Research returned an invalid response.');
  if(data.error)throw new ResearchError('service_error','Research returned a service error. No complete result was accepted.');
  if(kind==='search'&&(!Array.isArray(data.results)||data.results.length>50||data.results.some(item=>!item||typeof item.url!=='string'||typeof item.title!=='string'||['snippet','summary','content'].some(key=>item[key]!==undefined&&typeof item[key]!=='string'))))throw new ResearchError('invalid_response','Search returned invalid results.');
  if(kind==='search')for(const item of data.results)fetchInput(item);
  if(kind==='fetch'&&(typeof data.title!=='string'||typeof data.content!=='string'))throw new ResearchError('invalid_response','Fetch returned invalid content.');
  if(kind==='ocr')parseOcrResponse(data,0);
  return data;
}
function statusFor(error) {return error?.code==='authentication_failed'?'Authentication failed':error?.code==='rate_limited'?'Rate limited':'Unavailable';}
export class ResearchClient {
  constructor({directory,modelRuntime,usage=new ResearchUsage(directory),fetch:fetchImpl=globalThis.fetch}){this.directory=directory;this.modelRuntime=modelRuntime;this.usage=usage;this.fetch=fetchImpl;}
  async check(kind,revision,error) {
    const root=researchRoot(this.directory);
    await withResearchLock(root,async()=>{
      const old=await readJsonFile(join(root,'checks.json'),{}),now=Date.now();
      const checks=old.revision===revision?old:{revision,capabilities:{}};
      checks.lastCheckedAt=now;checks.status=error?statusFor(error):'Connected';
      checks.capabilities[kind]={status:checks.status,checkedAt:now};
      await atomicJson(join(root,'checks.json'),checks);
    });
  }
  async request(kind,input,{operationId,ownerSession,turnId,signal=new AbortController().signal,onAttempt,originalBytes=0}={}) {
    if(!['search','fetch','ocr'].includes(kind))throw new ResearchError('invalid_request','Unknown Research capability.');
    const payload=kind==='search'?searchInput(input):kind==='fetch'?fetchInput(input):input;
    if(kind==='ocr'&&(!(payload?.png instanceof Uint8Array)||!Buffer.from(payload.png).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))))throw new ResearchError('invalid_document','OCR accepts a native canonical PNG page.');
    const config=await readResearchConfig(this.directory);
    if(!config.enabled)throw new ResearchError('disabled','Research & Documents is disabled in global settings.');
    const combined=AbortSignal.any([signal,AbortSignal.timeout(kind==='ocr'?config.limits.ocrTimeoutMs:config.limits.searchTimeoutMs)]);
    const attempts=[];
    for(let retry=0;retry<2;retry++) {
      combined.throwIfAborted();
      let attempt,dispatched=false,response,raw;
      try {
        const key=await resolveResearchAuth(this.modelRuntime,combined);
        attempt=await this.usage.reserve({operationId,ownerSession,turnId,kind,uploadBytes:kind==='ocr'?payload.png.length:0,originalBytes});attempts.push(attempt.attemptId);
        await onAttempt?.(attempt);
        combined.throwIfAborted();
        let body,headers={Authorization:`Bearer ${key}`};
        if(kind==='ocr'){body=new FormData();body.append('file',new Blob([payload.png],{type:'image/png'}),'page.png');body.append('purpose','text_recognition');}
        else{headers['Content-Type']='application/json';body=JSON.stringify(payload);}
        await this.usage.dispatch(attempt.attemptId);dispatched=true;
        await onAttempt?.({...attempt,status:'dispatched'});
        response=await this.fetch(`${config.baseUrl}/tools/${kind}`,{method:'POST',headers,body,signal:combined,redirect:'error'});
        raw=await responseBytes(response,config.limits.responseBytes,combined);
        if(!response.ok) {
          const code=[401,403].includes(response.status)?'authentication_failed':response.status===429?'rate_limited':'http_error';
          const error=new ResearchError(code,`Research ${kind} returned HTTP ${response.status}.`);
          await this.usage.settle(attempt.attemptId,{status:'failed'});
          if(kind!=='ocr'&&retry===0&&([408,429].includes(response.status)||response.status>=500))continue;
          throw error;
        }
        let data;
        try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw).trimStart());}catch{throw new ResearchError('invalid_response','Research returned incomplete or invalid JSON.');}
        validate(kind,data);
        const billable=kind==='search'?data.results.length>0:kind==='fetch'?data.content.trim().length>0:true;
        const partial=kind==='ocr'&&data.pages?.some(page=>page.finish_reason==='length');
        await this.usage.settle(attempt.attemptId,{status:partial?'partial':'complete',billable,returnedPages:kind==='ocr'&&Array.isArray(data.pages)?data.pages.length:0});
        await this.check(kind,config.revision);
        return {data,raw,attempts,config,partial};
      } catch(error) {
        if(attempt)await this.usage.settle(attempt.attemptId,{status:dispatched?'failed':'cancelled_local',billingUnknown:dispatched&&(!response||error.code==='invalid_response'||error.code==='response_limit')});
        // Only the caller's cancellation before dispatch is safe to continue locally.
        const cancelledLocally=!dispatched&&signal.aborted&&error===signal.reason;
        const safe=cancelledLocally?new ResearchError('cancelled_local','Research was cancelled before dispatch. No request was sent.'):error instanceof ResearchError?error:new ResearchError(combined.aborted?'interrupted_unknown':'unavailable',combined.aborted?'Research stopped locally. A dispatched request may still be billed.':'Research could not reach the service. A dispatched request may still be billed.');
        safe.attempts=attempts;await this.check(kind,config.revision,safe);throw safe;
      } finally {await this.modelRuntime?.settleCredentialWrites?.();}
    }
  }
}
