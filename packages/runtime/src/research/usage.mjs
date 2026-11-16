import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {piDirectory} from '../paths.mjs';
import {researchRoot, readJsonFile, atomicJson, withResearchLock} from './store.mjs';
import {readResearchConfig, ResearchError} from './config.mjs';

export const researchPrice = Object.freeze({version:'2026-11-16',asOf:'2026-11-16',currency:'CNY',search:0.005,fetch:0.005,ocr:0.0015,
  source:'https://api-docs.deepseek.com/quick_start/pricing'});
function ownerAlive(pid) {
  try { process.kill(pid,0); return true; } catch(error) { return error.code !== 'ESRCH'; }
}
function held(attempt, now) {
  return attempt.status==='reserved' || (attempt.status==='dispatched' && attempt.leaseUntil>now) ||
    (attempt.status==='interrupted_unknown' && attempt.kind==='ocr' && attempt.leaseUntil>now);
}
function recover(ledger,now) {
  for(const attempt of ledger.attempts) {
    if(attempt.status==='reserved' && (!ownerAlive(attempt.ownerPid) || attempt.leaseUntil<=now)) {
      attempt.status='cancelled_local'; attempt.billingState='not_dispatched'; attempt.finishedAt=now;
    } else if(attempt.status==='dispatched' && (!ownerAlive(attempt.ownerPid) || attempt.leaseUntil<=now)) {
      attempt.status='interrupted_unknown'; attempt.billingState='unknown'; attempt.finishedAt=now;
    }
  }
}
const counted = attempt => attempt.billingState !== 'not_dispatched';
export function summarizeUsage(attempts,now=Date.now(),limits) {
  const active=attempts.filter(item=>item.createdAt>now-86400000 && counted(item));
  const uploadedBytes=active.reduce((total,item)=>total+item.reserved.uploadBytes,0);
  const ocrPages=active.reduce((total,item)=>total+item.reserved.ocrPages,0);
  const billed=attempts.filter(item=>item.billingState==='estimated');
  const unknown=attempts.filter(item=>item.billingState==='unknown');
  return {attempts:attempts.filter(counted).length,successful:attempts.filter(item=>item.status==='complete').length,
    partial:attempts.filter(item=>item.status==='partial').length,unknown:unknown.length,
    searchCalls:attempts.filter(item=>item.kind==='search'&&counted(item)).length,
    fetchCalls:attempts.filter(item=>item.kind==='fetch'&&counted(item)).length,
    ocrPages:attempts.filter(counted).reduce((total,item)=>total+item.reserved.ocrPages,0),
    uploadedBytes:attempts.filter(counted).reduce((total,item)=>total+item.reserved.uploadBytes,0),
    originalBytes:attempts.filter(counted).reduce((total,item)=>total+(item.originalBytes??0),0),
    estimatedCny:billed.reduce((total,item)=>total+item.estimatedCny,0),
    unknownMaximumCny:unknown.length?unknown.reduce((total,item)=>total+item.reserved.maximumCny,0):null,
    currency:'CNY',priceVersion:researchPrice.version,priceSource:researchPrice.source,
    remaining:limits?{attempts24h:Math.max(0,limits.attempts24h-active.length),uploadBytes24h:Math.max(0,limits.uploadBytes24h-uploadedBytes),ocrPages24h:Math.max(0,limits.ocrPages24h-ocrPages)}:undefined};
}
export class ResearchUsage {
  constructor(directory=piDirectory()) { this.directory=directory; this.path=researchRoot(directory); }
  async transaction(action) {
    return withResearchLock(this.path,async()=>{
      const ledger=await readJsonFile(join(this.path,'usage.json'),{schemaVersion:1,revision:0,attempts:[]});
      if(ledger?.schemaVersion!==1 || !Array.isArray(ledger.attempts)) throw new ResearchError('corrupt_store','Research usage is unavailable. Existing records were preserved.');
      recover(ledger,Date.now());
      const result=await action(ledger); ledger.revision++;
      await atomicJson(join(this.path,'usage.json'),ledger); return result;
    });
  }
  async reserve({operationId,attemptId=randomUUID(),ownerSession,turnId,kind,uploadBytes=0,ocrPages=kind==='ocr'?1:0,originalBytes=0}) {
    if(!['search','fetch','ocr'].includes(kind)||![operationId,attemptId,ownerSession,turnId].every(value=>typeof value==='string'&&value&&value.length<=4096)||
      ![uploadBytes,ocrPages,originalBytes].every(value=>Number.isSafeInteger(value)&&value>=0) || (kind==='ocr'?ocrPages!==1:ocrPages!==0)) throw new ResearchError('invalid_attempt','Invalid Research usage reservation.');
    return this.transaction(async ledger=>{
      const duplicate=ledger.attempts.find(item=>item.attemptId===attemptId);
      if(duplicate) {
        if(duplicate.ownerSession!==ownerSession||duplicate.operationId!==operationId) throw new ResearchError('invalid_attempt','Attempt belongs to another operation.');
        return duplicate;
      }
      const config=await readResearchConfig(this.directory),limits=config.limits,now=Date.now();
      if(!config.enabled) throw new ResearchError('disabled','Research & Documents is disabled in global settings.');
      const recent=ledger.attempts.filter(item=>item.createdAt>now-86400000 && counted(item));
      const exceed=(condition,label)=>{if(condition)throw new ResearchError('budget_limit',`${label} reached. Saved sources and completed pages remain available.`);};
      exceed(recent.length>=limits.attempts24h,'24-hour request limit');
      exceed(recent.reduce((sum,item)=>sum+item.reserved.uploadBytes,0)+uploadBytes>limits.uploadBytes24h,'24-hour upload limit');
      exceed(recent.reduce((sum,item)=>sum+item.reserved.ocrPages,0)+ocrPages>limits.ocrPages24h,'24-hour OCR page limit');
      exceed(ledger.attempts.filter(item=>item.ownerSession===ownerSession&&item.turnId===turnId&&counted(item)).length>=limits.attemptsPerTurn,'Turn request limit');
      exceed(ledger.attempts.filter(item=>held(item,now)).length>=limits.httpConcurrency,'Concurrent request limit');
      exceed(kind==='ocr'&&ledger.attempts.filter(item=>item.kind==='ocr'&&held(item,now)).length>=limits.ocrConcurrency,'Concurrent OCR limit');
      exceed(uploadBytes>limits.pageBytes,'Rendered page size limit');
      const attempt={attemptId,operationId,ownerSession,turnId,kind,configRevision:config.revision,ownerPid:process.pid,
        status:'reserved',billingState:'reserved',createdAt:now,leaseUntil:now+10000,originalBytes,
        reserved:{uploadBytes,ocrPages,maximumCny:researchPrice[kind]},currency:'CNY',priceVersion:researchPrice.version};
      ledger.attempts.push(attempt); return attempt;
    });
  }
  async dispatch(attemptId) {
    return this.transaction(async ledger=>{
      const attempt=ledger.attempts.find(item=>item.attemptId===attemptId);
      if(!attempt||attempt.status!=='reserved') throw new ResearchError('invalid_attempt','Research attempt is no longer queued.');
      const config=await readResearchConfig(this.directory);
      if(!config.enabled) throw new ResearchError('disabled','Research & Documents was disabled before dispatch.');
      const now=Date.now();
      const recent=ledger.attempts.filter(item=>item.createdAt>now-86400000&&counted(item));
      if(recent.length>config.limits.attempts24h || recent.reduce((sum,item)=>sum+item.reserved.uploadBytes,0)>config.limits.uploadBytes24h ||
        recent.reduce((sum,item)=>sum+item.reserved.ocrPages,0)>config.limits.ocrPages24h ||
        ledger.attempts.filter(item=>item.ownerSession===attempt.ownerSession&&item.turnId===attempt.turnId&&counted(item)).length>config.limits.attemptsPerTurn ||
        ledger.attempts.filter(item=>held(item,now)).length>config.limits.httpConcurrency ||
        attempt.kind==='ocr'&&ledger.attempts.filter(item=>item.kind==='ocr'&&held(item,now)).length>config.limits.ocrConcurrency) {
        throw new ResearchError('budget_limit','Research limits changed before dispatch. Release this queued request and review the limits.');
      }
      Object.assign(attempt,{status:'dispatched',billingState:'unknown',dispatchedAt:now,
        leaseUntil:now+(attempt.kind==='ocr'?180000:config.limits.searchTimeoutMs)});
      return attempt;
    });
  }
  async settle(attemptId,{status,billable=false,billingUnknown=false,returnedPages=0}) {
    if(!['complete','partial','failed','cancelled_local','interrupted_unknown'].includes(status)) throw new ResearchError('invalid_attempt','Unsupported Research attempt result.');
    return this.transaction(ledger=>{
      const attempt=ledger.attempts.find(item=>item.attemptId===attemptId);
      if(!attempt) throw new ResearchError('invalid_attempt','Research attempt was not found.');
      if(['complete','partial','failed','cancelled_local'].includes(attempt.status)) return attempt;
      const notDispatched=!attempt.dispatchedAt;
      Object.assign(attempt,{status,finishedAt:Date.now(),returnedPages,
        billingState:notDispatched?'not_dispatched':billingUnknown?'unknown':billable?'estimated':'not_billable',
        estimatedCny:!notDispatched&&billable?researchPrice[attempt.kind]:null});
      if(billingUnknown) attempt.status='interrupted_unknown';
      return attempt;
    });
  }
  async summary(ownerSession) {
    return this.transaction(async ledger=>{
      const config=await readResearchConfig(this.directory);
      return {global:summarizeUsage(ledger.attempts,Date.now(),config.limits),
        task:ownerSession?summarizeUsage(ledger.attempts.filter(item=>item.ownerSession===ownerSession)):null};
    });
  }
}
