import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, lstat, open, rename, rm, readdir, chmod, link} from 'node:fs/promises';
import {join, dirname, resolve} from 'node:path';
import {createRequire} from 'node:module';
import {bundledPiEntry, piDirectory} from '../paths.mjs';
import {ResearchError} from './config.mjs';

const lockfile = createRequire(bundledPiEntry)('proper-lockfile');
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const id = () => randomUUID();
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export const researchRoot = (directory = piDirectory()) => join(directory,'research','v1');

export async function secureDirectory(path) {
  const absolute = resolve(path);
  // Reject existing symlinks before mkdir can follow them, including managed ancestors.
  const parent = dirname(absolute);
  if (parent !== absolute) {
    try { const info = await lstat(parent); if (info.isSymbolicLink() || !info.isDirectory()) throw new ResearchError('unsafe_path','Research storage cannot use symbolic links.'); }
    catch(error) { if(error.code === 'ENOENT') await secureDirectory(parent); else throw error; }
  }
  try { const info = await lstat(absolute); if (info.isSymbolicLink() || !info.isDirectory()) throw new ResearchError('unsafe_path','Research storage cannot use symbolic links.'); }
  catch(error) {
    if(error.code !== 'ENOENT') throw error;
    try { await mkdir(absolute,{mode:0o700}); }
    catch(error) { if(error.code !== 'EEXIST') throw error; }
    const info = await lstat(absolute);
    if(info.isSymbolicLink() || !info.isDirectory()) throw new ResearchError('unsafe_path','Research storage cannot use symbolic links.');
  }
}
export async function readJsonFile(path, fallback) {
  try {
    const info = await lstat(path);
    if(!info.isFile() || info.isSymbolicLink()) throw new ResearchError('unsafe_path','Research data must be a regular file.');
    return JSON.parse(await readFile(path,'utf8'));
  } catch(error) {
    if(error.code === 'ENOENT') return structuredClone(fallback);
    if(error instanceof ResearchError) throw error;
    throw new ResearchError('corrupt_store','Research records could not be read. Existing data was preserved.');
  }
}
export async function atomicJson(path, value) {
  const temp = `${path}.${process.pid}.${id()}.tmp`;
  let handle;
  try {
    handle = await open(temp,'wx',0o600);
    await handle.writeFile(JSON.stringify(value)+'\n'); await handle.sync(); await handle.close(); handle = null;
    await rename(temp,path); await chmod(path,0o600);
    const directory = await open(dirname(path),'r'); try { await directory.sync(); } finally { await directory.close(); }
  } finally { await handle?.close(); await rm(temp,{force:true}); }
}
export async function withResearchLock(directory, action) {
  await secureDirectory(directory);
  const release = await lockfile.lock(directory,{realpath:false, stale:3000, update:1000, retries:{retries:80,minTimeout:10,maxTimeout:100}});
  try { return await action(); } finally { await release(); }
}
function initialManifest(sessionId, workspaceIdentity) {
  return {schemaVersion:1,sessionId,workspaceIdentity,revision:0,generation:0,sources:[],citations:[],extractions:[],requirements:[],links:[],operations:[],deletions:[]};
}
function validateManifest(manifest, sessionId) {
  if(!manifest || manifest.schemaVersion !== 1) throw new ResearchError('unsupported_schema','Unsupported Research record version. Existing data was preserved.');
  if(manifest.sessionId !== sessionId || !Number.isSafeInteger(manifest.revision) ||
    ['sources','citations','extractions','requirements','links','operations','deletions'].some(key=>!Array.isArray(manifest[key]))) {
    throw new ResearchError('corrupt_store','Research records have an invalid owner or structure. Existing data was preserved.');
  }
  return manifest;
}
export class ResearchStore {
  constructor({directory = piDirectory(), sessionId, workspaceIdentity = ''}) {
    if(typeof sessionId !== 'string' || !sessionId || sessionId.length > 4096) throw new ResearchError('invalid_session','A Research session is required.');
    this.sessionId = sessionId; this.workspaceIdentity = workspaceIdentity;
    this.root = researchRoot(directory); this.path = join(this.root,'tasks',sha256(sessionId));
  }
  async manifest() {
    await secureDirectory(this.path);
    return validateManifest(await readJsonFile(join(this.path,'manifest.json'),initialManifest(this.sessionId,this.workspaceIdentity)),this.sessionId);
  }
  async mutate(action, {expectedRevision, generation} = {}) {
    return withResearchLock(this.path,async()=>{
      const manifest = await this.manifest();
      if(expectedRevision !== undefined && manifest.revision !== expectedRevision) throw new ResearchError('conflict','Research records changed. Reload before editing.');
      if(generation !== undefined && manifest.generation !== generation) throw new ResearchError('cancelled','Research operation is no longer active.');
      const value = await action(manifest);
      manifest.revision++;
      await atomicJson(join(this.path,'manifest.json'),manifest);
      return {value,revision:manifest.revision};
    });
  }
  async putObject(bytes) {
    const data = Buffer.from(bytes), hash = sha256(data);
    if(data.length > 20971520) throw new ResearchError('file_limit','Research object exceeds the 20 MiB limit.');
    const directory = join(this.path,'objects'); await secureDirectory(directory);
    const path = join(directory,hash);
    let handle; const temporary = join(this.path,`.object-${id()}.tmp`);
    try { handle = await open(temporary,'wx',0o600); await handle.writeFile(data); await handle.sync(); await handle.close(); handle = null; await link(temporary,path); }
    catch(error) { if(error.code !== 'EEXIST') throw error; if(sha256(await this.object(hash)) !== hash) throw new ResearchError('corrupt_store','Research object hash mismatch.'); }
    finally { await handle?.close(); await rm(temporary,{force:true}); }
    return {hash,size:data.length};
  }
  async object(hash) {
    if(typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new ResearchError('unsafe_path','Invalid Research object ID.');
    await secureDirectory(join(this.path,'objects'));
    const path = join(this.path,'objects',hash);
    try {
      const info = await lstat(path);
      if(!info.isFile() || info.isSymbolicLink() || info.size > 20971520) throw new ResearchError('unsafe_path','Invalid Research object.');
      const bytes = await readFile(path);
      if(sha256(bytes) !== hash) throw new ResearchError('corrupt_store','Research object hash mismatch.');
      return bytes;
    } catch(error) { if(error.code === 'ENOENT') throw new ResearchError('source_unavailable','Source unavailable. Local source bytes are missing.'); throw error; }
  }
  async beginOperation({operationId = id(),turnId,kind}) {
    if(!validId(operationId) || typeof turnId !== 'string' || !turnId) throw new ResearchError('invalid_operation','A valid operation and turn are required.');
    return (await this.mutate(manifest=>{
      const old = manifest.operations.find(item=>item.operationId===operationId);
      if(old) return old;
      const operation = {operationId,turnId,ownerSession:this.sessionId,kind,status:'queued',generation:manifest.generation,createdAt:Date.now(),receipt:'pending'};
      manifest.operations.push(operation); return operation;
    })).value;
  }
  async setOperation(operationId, changes) {
    return (await this.mutate(manifest=>{
      const operation = manifest.operations.find(item=>item.operationId===operationId);
      if(!operation) throw new ResearchError('invalid_operation','Research operation was not found.');
      const allowed = ['status','sourceRefs','citationRefs','usageRefs','finishedAt','receipt','attemptId'];
      if(Object.keys(changes).some(key=>!allowed.includes(key))) throw new ResearchError('invalid_operation','Unsupported operation update.');
      Object.assign(operation,changes); return operation;
    })).value;
  }
  async addSource(input, {body,raw,operationId,generation} = {}) {
    if(!['search_summary','web','document'].includes(input.kind)) throw new ResearchError('invalid_source','Unsupported Research source kind.');
    return (await this.mutate(async manifest=>{
      if(operationId) {
        const operation = manifest.operations.find(item=>item.operationId===operationId);
        if(!operation || operation.generation !== manifest.generation || ['cancelled_local','interrupted_unknown'].includes(operation.status)) throw new ResearchError('cancelled','Research operation is no longer active.');
      }
      if(input.parentVersionId && !manifest.sources.some(source=>source.versionId===input.parentVersionId)) throw new ResearchError('invalid_source','The source version does not belong to this task.');
      const bodyObject = body === undefined ? undefined : await this.putObject(Buffer.from(body));
      const rawObject = raw === undefined ? undefined : await this.putObject(raw);
      const source = {...input,sourceId:input.sourceId??manifest.sources.find(s=>s.versionId===input.parentVersionId)?.sourceId??id(),versionId:id(),capturedAt:new Date().toISOString(),
        bodyHash:bodyObject?.hash,rawHash:rawObject?.hash,ownerSession:this.sessionId,
        readState:input.readState??(bodyObject?.size?'read':'unread'),limitations:input.limitations??[]};
      manifest.sources.push(source);
      if(operationId) {
        const operation = manifest.operations.find(item=>item.operationId===operationId);
        operation.sourceRefs = [...(operation.sourceRefs??[]),source.versionId];
      }
      return source;
    },{generation})).value;
  }
  async source(versionId) {
    const manifest = await this.manifest();
    const source = manifest.sources.find(item=>item.versionId===versionId);
    if(!source) throw new ResearchError(manifest.deletions.some(item=>item.versionIds.includes(versionId))?'source_deleted':'source_unavailable',
      manifest.deletions.some(item=>item.versionIds.includes(versionId))?'Local source deleted.':'Source unavailable in this task.');
    return source;
  }
  async read(versionId, offset = 0, limit = 32768) {
    const source = await this.source(versionId);
    if(!source.bodyHash) return {source,text:'',offset:0,next:null,truncated:false};
    const bytes = await this.object(source.bodyHash);
    if(!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length || (offset < bytes.length && (bytes[offset]&0xc0)===0x80)) throw new ResearchError('invalid_range','The source offset must be a UTF-8 boundary.');
    if(!Number.isSafeInteger(limit) || limit < 1 || limit > 32768) throw new ResearchError('invalid_range','Source reads are limited to 32768 bytes.');
    let end = Math.min(bytes.length,offset+limit);
    while(end < bytes.length && (bytes[end]&0xc0)===0x80) end--;
    if(end===offset && offset<bytes.length) throw new ResearchError('invalid_range','The limit must fit a complete UTF-8 character.');
    return {source,text:bytes.subarray(offset,end).toString('utf8'),offset,next:end<bytes.length?end:null,truncated:end<bytes.length};
  }
  async cite(versionId, quote, range, operationId) {
    if(operationId){const manifest=await this.manifest(),old=manifest.operations.find(o=>o.operationId===operationId);if(old){const citation=manifest.citations.find(c=>c.citationId===old.citationRefs?.[0]);if(citation)return {...citation,url:`eido-source://${citation.sourceVersionId}/${citation.citationId}`};}}
    const source = await this.source(versionId);
    if(typeof quote !== 'string' || !quote || Buffer.byteLength(quote)>32768) throw new ResearchError('invalid_quote','Provide a non-empty quotation of at most 32768 bytes.');
    const bytes = source.bodyHash ? await this.object(source.bodyHash) : Buffer.alloc(0), needle = Buffer.from(quote);
    let start = bytes.indexOf(needle), matchState = start<0?'unmatched':bytes.indexOf(needle,start+needle.length)>=0?'ambiguous':'exact';
    if(range) {
      const [a,b] = range;
      if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a<0||b<a||b>bytes.length||
        (a<bytes.length&&(bytes[a]&0xc0)===0x80)||(b<bytes.length&&(bytes[b]&0xc0)===0x80)) throw new ResearchError('invalid_range','Citation range must use exact UTF-8 byte boundaries.');
      start = a; matchState = bytes.subarray(a,b).equals(needle)?'exact':'unmatched';
    }
    if(source.readState==='summary_only') matchState='summary_only';
    const citation = {citationId:id(),sourceVersionId:versionId,quote,range:matchState==='exact'?[start,start+needle.length]:null,matchState,locationType:'text'};
    // Location is derived from immutable extraction mappings, never caller-supplied coordinates.
    if(source.kind==='document' && matchState==='exact') {
      const regions = (source.regions??[]).filter(region=>region.end>start&&region.start<start+needle.length);
      citation.regions = regions; citation.locationType = 'page';
      if(!regions.length || regions.some(region=>!region.boxes?.length)) citation.matchState='unlocated';
    }
    const saved=await this.mutate(manifest=>{
      if(operationId){const old=manifest.operations.find(o=>o.operationId===operationId);if(old)return manifest.citations.find(c=>c.citationId===old.citationRefs?.[0]);}
      if(!manifest.sources.some(item=>item.versionId===versionId)) throw new ResearchError('source_deleted','Local source deleted.');
      manifest.citations.push(citation);
      if(operationId)manifest.operations.push({operationId,turnId:'local',ownerSession:this.sessionId,kind:'cite',citationRefs:[citation.citationId],sourceRefs:[versionId],status:'complete',generation:manifest.generation,createdAt:Date.now(),finishedAt:Date.now(),receipt:'pending'});return citation;
    });
    return {...saved.value,url:`eido-source://${versionId}/${saved.value.citationId}`};
  }
  async cancel(operationId) {
    return this.setOperation(operationId,{status:'cancelled_local',finishedAt:Date.now()});
  }
  async recover() {
    await this.mutate(manifest=>{
      for(const operation of manifest.operations) if(['dispatched','running','reserved'].includes(operation.status)) operation.status='interrupted_unknown';
      for(const extraction of manifest.extractions) if(['running','pending'].includes(extraction.status)) extraction.status='interrupted';
      for(const link of manifest.links)if(link.kind==='check'){link.freshness='inputs_not_rechecked';link.status='Inputs not rechecked';}
    });
    await this.gc();
    return (await this.manifest()).operations.filter(operation=>operation.receipt==='pending');
  }
  async deleteSources(versionIds, expectedRevision, operationId) {
    if(!Array.isArray(versionIds)||!versionIds.length||versionIds.length>100||versionIds.some(value=>!validId(value))||(operationId!==undefined&&!validId(operationId))) throw new ResearchError('invalid_source','Select source versions to delete.');
    const result = await this.mutate(manifest=>{
      if(operationId){const old=manifest.operations.find(o=>o.operationId===operationId);if(old){if(old.kind!=='delete'||JSON.stringify(old.sourceRefs)!==JSON.stringify(versionIds))throw new ResearchError('invalid_operation','Operation ID was used for a different deletion.');return {deleted:0,affectedCitations:0,reused:true};}}
      if(manifest.revision!==expectedRevision)throw new ResearchError('conflict','Research records changed. Reload before deleting.');
      if(versionIds.some(value=>!manifest.sources.some(source=>source.versionId===value))) throw new ResearchError('source_unavailable','Source unavailable in this task.');
      manifest.generation++;
      manifest.deletions.push({deletionId:id(),versionIds,deletedAt:Date.now()});
      const affected=new Set(manifest.citations.filter(c=>versionIds.includes(c.sourceVersionId)).map(c=>c.citationId));
      for(const link of manifest.links)if(manifest.requirements.some(r=>r.requirementId===link.requirementId&&r.citationIds.some(id=>affected.has(id)))){link.freshness='source_deleted';link.status='Needs recheck';}
      manifest.sources=manifest.sources.filter(source=>!versionIds.includes(source.versionId));
      manifest.extractions=manifest.extractions.filter(extraction=>!versionIds.includes(extraction.sourceVersionId));
      for(const operation of manifest.operations) if(['queued','reserved','dispatched','running'].includes(operation.status)) operation.status='cancelled_local';
      if(operationId)manifest.operations.push({operationId,turnId:'local',ownerSession:this.sessionId,kind:'delete',sourceRefs:versionIds,status:'complete',generation:manifest.generation,createdAt:Date.now(),finishedAt:Date.now(),receipt:'pending'});
      return {deleted:versionIds.length,affectedCitations:manifest.citations.filter(citation=>versionIds.includes(citation.sourceVersionId)).length};
    });
    await this.gc(); return result;
  }
  async gc() {
    return withResearchLock(this.path,async()=>{
      const manifest = await this.manifest(), keep = new Set();
      const collect = value => { if(Array.isArray(value)) value.forEach(collect); else if(value&&typeof value==='object') for(const [key,item] of Object.entries(value)) { if(/Hash$/.test(key)&&typeof item==='string') keep.add(item); else collect(item); } };
      collect(manifest.sources); collect(manifest.extractions);
      const directory = join(this.path,'objects'); await secureDirectory(directory);
      for(const name of await readdir(directory)) {
        if(!/^[a-f0-9]{64}$/.test(name)) throw new ResearchError('unsafe_path','Unexpected Research object file. Cleanup stopped.');
        const path=join(directory,name), info=await lstat(path);
        if(!info.isFile()||info.isSymbolicLink()) throw new ResearchError('unsafe_path','Unsafe Research object. Cleanup stopped.');
        if(!keep.has(name)) await rm(path);
      }
    });
  }
  async copyTo(target) {
    if(target.sessionId===this.sessionId) throw new ResearchError('invalid_session','Research copy requires a different task.');
    return withResearchLock(this.path,async()=>{
      const original=await this.manifest(), copy=structuredClone(original), hashes=new Set();
      const collect=value=>{if(Array.isArray(value))value.forEach(collect);else if(value&&typeof value==='object')for(const [key,item]of Object.entries(value)){if(/Hash$/.test(key)&&typeof item==='string')hashes.add(item);else collect(item);}};
      collect(copy.sources); collect(copy.extractions);
      await target.mutate(async manifest=>{
        if(manifest.sources.length||manifest.requirements.length) throw new ResearchError('conflict','The destination task already has Research records.');
        for(const hash of hashes) await target.putObject(await this.object(hash));
        Object.assign(manifest,copy,{sessionId:target.sessionId,workspaceIdentity:target.workspaceIdentity,revision:manifest.revision,generation:0,operations:[]});
        for(const source of manifest.sources) Object.assign(source,{originSessionId:this.sessionId,originVersionId:source.versionId,ownerSession:target.sessionId});
        for(const link of manifest.links) Object.assign(link,{ownerSession:target.sessionId,freshness:'inputs_not_rechecked'});
      });
    });
  }
}
