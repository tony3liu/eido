import {join} from 'node:path';
import {methods} from '@agentclientprotocol/sdk';
import {changedDependencies,type Dependencies} from './preview-dependencies.ts';
import {randomUUID} from 'node:crypto';
import type {RequirementReference} from './prompt-content.ts';
import {readResearchConfig,ResearchError} from '../../runtime/src/research/config.mjs';
import {ResearchStore,sha256,type ResearchOperation} from '../../runtime/src/research/store.mjs';
import {ResearchClient,utf8Prefix} from '../../runtime/src/research/client.mjs';
import {ResearchRequirements,requirementHooks} from './research-requirements.ts';
import {ResearchDocuments,type DocumentDescriptor} from './documents.ts';
import {ResearchUsage} from '../../runtime/src/research/usage.mjs';
import {withMcpModelContent} from '../adapter/src/mcp-bridge.js';
import type {BuiltinMcpClient,McpClientHandle,McpSessionBinding} from '../adapter/src/mcp-bridge.js';
import type {AgentSession} from '@earendil-works/pi-coding-agent';
import type {CallToolResult,Tool} from '@modelcontextprotocol/sdk/types.js';
import {appendEidoEntry} from './session-persistence.ts';

export const RESEARCH = Symbol.for('eido.pi.research');
const EVENT = 'eido.research.event.v1';
const object = (value:unknown):Record<string,unknown> => {
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new ResearchError('invalid_request','Research expects an object.');
  return value as Record<string,unknown>;
};
const string = (value:unknown,label:string):string => {
  if(typeof value!=='string'||!value||value.length>8192) throw new ResearchError('invalid_request',`${label} is required and must be at most 8192 characters.`);
  return value;
};
const sourceTool:Tool={name:'source',description:'Read this task’s immutable saved sources or verify an exact quotation. Local only. Search summaries are not read webpage bodies. Cite the returned eido-source URL; never invent verification.',
  inputSchema:{type:'object',properties:{action:{enum:['list','read','cite']},versionId:{type:'string'},quote:{type:'string'},range:{type:'array',items:{type:'integer'},minItems:2,maxItems:2},offset:{type:'integer',minimum:0}},required:['action'],additionalProperties:false}};

const remoteTools:Tool[]=[
  {name:'requirements',description:'Create or revise task requirements and acceptance criteria linked to saved citations. All new criteria are Not checked; this tool cannot claim checks passed.',inputSchema:{type:'object',properties:{action:{enum:['list','get','create','update']},requirementId:{type:'string'},revision:{type:'integer'},expectedRevision:{type:'integer'},title:{type:'string'},text:{type:'string'},citationIds:{type:'array',items:{type:'string'}},relatedFiles:{type:'array',items:{type:'string'}},criteria:{type:'array',items:{type:'object',properties:{criterionId:{type:'string'},text:{type:'string'},checkType:{enum:['command','manual']},checkSpec:{type:'string'},sourceCitationIds:{type:'array',items:{type:'string'}}},additionalProperties:false}}},required:['action'],additionalProperties:false}},
  {name:'search',description:'Search public web sources with DeepSeek. Saves immutable results; summaries do not prove a page was read.',inputSchema:{type:'object',properties:{query:{type:'string',minLength:1},count:{type:'integer',minimum:1,maximum:50},need_content:{type:'boolean'}},required:['query'],additionalProperties:false}},
  {name:'fetch',description:'Read a public webpage and save its returned Markdown as an immutable source version. Does not use browser login state.',inputSchema:{type:'object',properties:{url:{type:'string'},parentVersionId:{type:'string'}},required:['url'],additionalProperties:false}},
  {name:'document_extract',description:'Extract text sequentially from a submitted PDF/image attachment. Reuses complete saved pages. Unknown pages are never automatically retried; reextract explicitly authorizes a new charged attempt.',inputSchema:{type:'object',properties:{attachmentId:{type:'string'},pages:{type:'array',items:{type:'integer',minimum:0},minItems:1,maxItems:50},reextract:{type:'boolean'}},required:['attachmentId'],additionalProperties:false}},
];
export class ResearchSession {
  readonly store:ResearchStore;
  readonly usage:ResearchUsage;
  readonly client:ResearchClient;
  readonly documents:ResearchDocuments;
  readonly requirements:ResearchRequirements;
  readonly hooks:ReturnType<typeof requirementHooks>;
  private active=new Set<string>();
  private submittedScope?:{requestId:string;requirements:RequirementReference[]};
  scope(){return this.submittedScope?{...this.submittedScope,ownerSession:this.binding.sessionId,turnId:this.binding.getTurnId?.()}:undefined;}
  async submit(descriptors:DocumentDescriptor[],requirements:RequirementReference[]){for(const ref of requirements)await this.requirements.get(ref.requirementId,ref.revision);this.documents.submit(descriptors);this.submittedScope=requirements.length?{requestId:randomUUID(),requirements}:undefined;}
  private pi?:AgentSession;
  private closed=false;
  constructor(readonly directory:string,readonly binding:McpSessionBinding) {
    this.store=new ResearchStore({directory,sessionId:binding.sessionId,workspaceIdentity:binding.cwd});
    this.usage=new ResearchUsage(directory);
    this.client=new ResearchClient({directory,modelRuntime:binding.modelRuntime,usage:this.usage});
    this.documents=new ResearchDocuments(directory,binding,this.store,this.client);
    this.requirements=new ResearchRequirements(this.store);
    this.hooks=requirementHooks(this.store,()=>this.scope());
  }
  async attach(pi:AgentSession) {
    this.pi=pi; Object.defineProperty(pi,RESEARCH,{value:this,configurable:true});
    for(const operation of await this.store.recover()) if(operation.status!=='queued') await this.receipt(operation);
  }
  async receipt(operation:ResearchOperation) {
    const pi=this.pi??this.binding.getPi(); if(!pi)return;
    const manifest=await this.store.manifest();
    const ref={version:1,sessionId:this.binding.sessionId,operationId:operation.operationId,revision:manifest.revision,
      sourceRefs:operation.sourceRefs??[],citationRefs:operation.citationRefs??[],usageRefs:operation.usageRefs??[],status:operation.status};
    const recorded=pi.sessionManager.getEntries().some(entry=>entry.type==='custom'&&entry.customType===EVENT&&(entry.data as {operationId?:string})?.operationId===operation.operationId);
    if(!recorded) appendEidoEntry(pi.sessionManager,EVENT,{operationId:operation.operationId,eidoResearch:ref});
    await this.store.setOperation(operation.operationId,{receipt:'recorded'});
  }
  async result(value:unknown,operation?:ResearchOperation,isError=false):Promise<CallToolResult> {
    const manifest=await this.store.manifest();
    if(operation) await this.receipt(operation);
    const max=(await readResearchConfig(this.directory)).limits.modelTextBytes;
    const encoded=JSON.stringify(value),text=Buffer.byteLength(encoded)<=max?encoded:JSON.stringify({truncated:true,notice:'Use source read with offset to read the saved content.',text:utf8Prefix(encoded,Math.floor(max/2)-150)});
    const details=value as {source?:{versionId:string};sources?:{versionId:string}[];citationId?:string;sourceVersionId?:string};
    const result:CallToolResult={content:[{type:'text',text}],isError,
      structuredContent:{eidoResearch:{version:1,sessionId:this.binding.sessionId,operationId:operation?.operationId??null,revision:manifest.revision,
        sourceRefs:operation?.sourceRefs??details?.sources?.map(source=>source.versionId)??(details?.source?[details.source.versionId]:details?.sourceVersionId?[details.sourceVersionId]:[]),citationRefs:operation?.citationRefs??(details?.citationId?[details.citationId]:[]),usageRefs:operation?.usageRefs??[],status:operation?.status??'local'}}};
    return withMcpModelContent(result,result.content);
  }
  async source(args:Record<string,unknown>,operationId?:string) {
    switch(args.action) {
      case 'list': {
        const offset=args.offset??0;
        if(!Number.isSafeInteger(offset)||Number(offset)<0)throw new ResearchError('invalid_request','Invalid source list offset.');
        const manifest=await this.store.manifest();
        return {sources:manifest.sources.slice(Number(offset),Number(offset)+50),next:Number(offset)+50<manifest.sources.length?Number(offset)+50:null,revision:manifest.revision};
      }
      case 'read': return this.store.read(string(args.versionId,'Source version'),args.offset===undefined?0:Number(args.offset),20000);
      case 'cite': {
        const range=args.range;
        if(range!==undefined&&(!Array.isArray(range)||range.length!==2||!range.every(Number.isSafeInteger)))throw new ResearchError('invalid_range','Citation range requires two byte offsets.');
        return this.store.cite(string(args.versionId,'Source version'),string(args.quote,'Quotation'),range as [number,number]|undefined,operationId);
      }
      default: throw new ResearchError('invalid_request','Unsupported local source action.');
    }
  }
  async checkedManifest(){
    const manifest=await this.store.manifest(),invalid=new Map<string,string>();
    // Normalize earlier persisted records too: visible status must never outrank stale inputs.
    for(const link of manifest.links.filter(l=>l.kind==='check'&&l.freshness!=='current')){
      const state=['needs_recheck','source_deleted'].includes(String(link.freshness))?'needs_recheck':'inputs_not_rechecked';
      const status=state==='needs_recheck'?'Needs recheck':'Inputs not rechecked';
      if(link.status!==status)invalid.set(`${link.runId}:${link.criterionId}`,state);
    }
    for(const link of manifest.links.filter(l=>l.kind==='check'&&l.freshness==='current')){
      const key=`${link.runId}:${link.criterionId}`;
      try{
        const signal=AbortSignal.timeout(5000);
        for(const file of (link.files??[]) as {path:string;hash:string}[]){const response=await this.binding.client.request<any>(methods.client.fs.readTextFile,{sessionId:this.binding.sessionId,path:join(this.binding.cwd,file.path),_meta:{'eido.dev/observeBuffer':true}},{cancellationSignal:signal});if(response._meta?.['eido.dev/observeBuffer']!==true)throw new Error('Snapshot unavailable');if(sha256(response.content)!==file.hash){invalid.set(key,'needs_recheck');break;}}
        const dependencies=link.dependencyInputs as Dependencies|undefined;if(dependencies?.entries.length){const current=await changedDependencies(this.binding.cwd,dependencies.entries,signal);if(current.changed.length)invalid.set(key,'needs_recheck');if(current.unavailable.length)invalid.set(key,'inputs_not_rechecked');}
      }catch{invalid.set(key,'inputs_not_rechecked');}
    }
    if(invalid.size)await this.store.mutate(current=>{for(const link of current.links){const state=invalid.get(`${link.runId}:${link.criterionId}`);if(state){link.freshness=state;link.status=state==='needs_recheck'?'Needs recheck':'Inputs not rechecked';}}});
    return invalid.size?this.store.manifest():manifest;
  }
  async local(request:Record<string,unknown>) {
    if(this.closed||request.version!==1||request.sessionId!==this.binding.sessionId)throw new ResearchError('invalid_session','Research request has an invalid version or task owner.');
    if(request.action==='status')return {version:1,activeScope:this.scope()??null,config:await readResearchConfig(this.directory),usage:await this.usage.summary(this.binding.sessionId),manifest:await this.checkedManifest()};
    if(request.action==='list'||request.action==='read')return this.source(request);
    if(request.action==='cite'){const id=request.operationId?string(request.operationId,'Operation ID'):randomUUID();const value=await this.source(request,id);await this.receipt((await this.store.manifest()).operations.find(o=>o.operationId===id)!);return value;}
    if(request.action==='manual-check'){
      const requirement=await this.requirements.get(string(request.requirementId,'Requirement ID'));
      const criterion=requirement.criteria.find(c=>c.criterionId===request.criterionId);
      if(requirement.revision!==request.revision||criterion?.checkType!=='manual'||!['Passed','Failed'].includes(String(request.outcome)))throw new ResearchError('invalid_request','Select a current manual criterion and its observed outcome.');
      const note=string(request.observation,'Observed behavior');await this.checkedManifest();
      await this.store.mutate(manifest=>{const evidence=manifest.links.findLast(l=>l.kind==='check'&&l.requirementId===requirement.requirementId&&l.revision===requirement.revision&&l.criterionId===criterion.criterionId);if(!evidence||evidence.freshness!=='current')throw new ResearchError('needs_recheck','Capture current inputs with preview and this criterion before recording a manual observation.');manifest.links.push({...evidence,status:request.outcome,manualObservation:note,observedAt:Date.now(),observer:'user'});});
      return {status:request.outcome};
    }
    if(request.action==='requirements') {
      const operationId=string(request.operationId,'Operation ID');
      const value=await this.requirements.execute(object(request.request),{operationId,turnId:'local'});
      const completed=(await this.store.manifest()).operations.find(o=>o.operationId===operationId);if(completed)await this.receipt(completed);return value;
    }
    if(request.action==='detail'||request.action==='page') {
      const source=await this.store.source(string(request.versionId,'Source version')),manifest=await this.store.manifest();
      const extraction=manifest.extractions.find(e=>e.sourceVersionId===source.versionId);
      const citations=manifest.citations.filter(c=>c.sourceVersionId===source.versionId);
      if(request.citationId!=null&&!citations.some(c=>c.citationId===request.citationId))throw new ResearchError('source_unavailable','Citation is unavailable in this task.');
      if(request.action==='detail')return {source,citations:request.citationId?citations.filter(c=>c.citationId===request.citationId):citations.slice(-100),extraction:extraction?{...extraction,pages:extraction.pages.map(p=>({pageIndex:p.pageIndex,status:p.status,pngHash:p.pngHash,manifest:p.manifest,error:p.error,reused:p.reused}))}:null};
      const page=extraction?.pages.find(p=>p.pageIndex===request.pageIndex);
      if(!page||typeof page.pngHash!=='string')throw new ResearchError('source_unavailable','Saved page rendition unavailable.');
      const bytes=await this.store.object(page.pngHash),offset=Number(request.offset??0);
      if(!Number.isSafeInteger(offset)||offset<0||offset>bytes.length||offset%262144!==0)throw new ResearchError('invalid_range','Invalid saved page offset.');
      const end=Math.min(bytes.length,offset+262144);return {version:1,manifest:page.manifest,hash:page.pngHash,total:bytes.length,content:bytes.subarray(offset,end).toString('base64'),next:end<bytes.length?end:null};
    }
    if(request.action==='delete') {
      if(!Number.isSafeInteger(request.expectedRevision)||!Array.isArray(request.versionIds)||request.versionIds.some(value=>typeof value!=='string'))throw new ResearchError('invalid_request','Select source versions and their current revision.');
      const operationId=string(request.operationId,'Operation ID');
      const deleted=await this.store.deleteSources(request.versionIds as string[],Number(request.expectedRevision),operationId);
      const completed=(await this.store.manifest()).operations.find(o=>o.operationId===operationId)!;
      await this.receipt(completed);return {version:1,...deleted};
    }
    throw new ResearchError('invalid_request','Unsupported local Research action.');
  }
  async remote(name:'search'|'fetch'|'document_extract',args:Record<string,unknown>,signal:AbortSignal,toolCallId:string,onprogress?: (progress:unknown)=>void) {
    const turnId=this.binding.getTurnId?.();if(!turnId)throw new ResearchError('invalid_turn','Research requires an active task turn.');
    const operationId=sha256(`${this.binding.sessionId}:${toolCallId}`);
    if(this.active.has(operationId))throw new ResearchError('operation_running','This Research operation is already running.');
    const operation=await this.store.beginOperation({operationId,turnId,kind:name});
    if(operation.status!=='queued')return this.result({status:operation.status,sourceRefs:operation.sourceRefs??[],reused:true,notice:'Saved operation restored. No remote request was repeated.'},operation,!['complete','partial'].includes(operation.status));
    this.active.add(operationId);
    try {
      const onAttempt=async(attempt:any)=>{const latest=(await this.store.manifest()).operations.find(o=>o.operationId===operationId)!;await this.store.setOperation(operationId,{status:attempt.status,attemptId:attempt.attemptId,usageRefs:[...new Set([...(latest.usageRefs??[]),attempt.attemptId])]});onprogress?.({progress:0,message:name==='search'?'Searching public sources':name==='fetch'?'Reading public page':`Extracting page ${Number(attempt.pageIndex??0)+1}`});};
      let value:unknown,status='complete';
      if(name==='document_extract'){value=await this.documents.extract(args,operation,signal,onAttempt);status=(value as {status:string}).status;}
      else {
        if(args.parentVersionId!==undefined)await this.store.source(string(args.parentVersionId,'Parent source version'));
        const response=await this.client.request(name,args,{operationId,ownerSession:this.binding.sessionId,turnId,signal,onAttempt});
        signal.throwIfAborted();
        if(name==='search') {
          const sources=[];
          for(const item of response.data.results){const {title,url,snippet,summary,content,...metadata}=item;const body=typeof item.content==='string'&&item.content.trim()?item.content:undefined;
            sources.push(await this.store.addSource({kind:body?'web':'search_summary',canonicalUrl:item.url,title:item.title,readState:body?'partial':'summary_only',producer:'deepseek-search',metadata,summary:summary??snippet??'',limitations:body?['Search-provided body completeness is unknown.']:['Search summary only; page body has not been read.']},{body:body??item.summary??item.snippet??'',raw:Buffer.from(JSON.stringify(item)),operationId,generation:operation.generation}));}
          value={sources};
        } else {
          const body=response.data.content;
          const source=await this.store.addSource({kind:'web',canonicalUrl:String(args.url),title:response.data.title,parentVersionId:args.parentVersionId as string|undefined,readState:body.trim()?'read':'unread',producer:'deepseek-fetch',limitations:body.trim()?[]:['No page body was returned.']},{body,raw:response.raw,operationId,generation:operation.generation});
          value={source,preview:utf8Prefix(body,16000),next:Buffer.byteLength(body)>16000?Buffer.byteLength(utf8Prefix(body,16000)):null};
        }
      }
      const completed=await this.store.setOperation(operationId,{status,finishedAt:Date.now()});return this.result(value,completed,!['complete','partial'].includes(status));
    } catch(error) {
      const code=error instanceof ResearchError?error.code:signal.aborted?'cancelled_local':'interrupted_unknown';
      const completed=await this.store.setOperation(operationId,{status:['interrupted_unknown','invalid_response','unavailable','response_limit'].includes(code)?'interrupted_unknown':signal.aborted?'cancelled_local':'failed',finishedAt:Date.now()});
      return this.result({error:{code,message:error instanceof ResearchError?error.message:'Research stopped locally. Saved sources remain available.'}},completed,true);
    } finally {this.active.delete(operationId);}
  }
  handle():McpClientHandle {
    return {getCapabilities:()=>({tools:{}}),listTools:async()=>({tools:[...remoteTools,sourceTool]}),
      callTool:async(name,args,signal,_timeout,progress,execution)=>{
        try {signal.throwIfAborted();if(this.closed)throw new ResearchError('closed','Research session is closed.');
          if(name==='source'){const input=object(args),id=input.action==='cite'&&execution?.toolCallId?sha256(`${this.binding.sessionId}:${execution.toolCallId}`):undefined;const value=await this.source(input,id);return this.result(value,id?(await this.store.manifest()).operations.find(o=>o.operationId===id):undefined);}
          if(name==='requirements'){if(!execution?.toolCallId)throw new ResearchError('invalid_tool','Missing invocation identity.');const operationId=sha256(`${this.binding.sessionId}:${execution.toolCallId}`);const value=await this.requirements.execute(object(args),{operationId,turnId:this.binding.getTurnId?.()??'local'});const operation=(await this.store.manifest()).operations.find(o=>o.operationId===operationId);return this.result(value,operation);}
          if(!['search','fetch','document_extract'].includes(name)||!execution?.toolCallId)throw new ResearchError('invalid_tool','Unknown Research tool or missing invocation identity.');
          return await this.remote(name as 'search'|'fetch'|'document_extract',object(args),signal,execution.toolCallId,progress);
        } catch(error) {return this.result({error:{code:error instanceof ResearchError?error.code:'unavailable',message:error instanceof ResearchError?error.message:'Research operation could not complete.'}},undefined,true);}
      },close:async()=>{await this.close();}};
  }
  async finishTurn(){ this.submittedScope=undefined;await this.documents.finishTurn();await this.binding.modelRuntime?.settleCredentialWrites(); }
  async close(){this.closed=true;await this.finishTurn();}
}

export function createResearchServices(directory:string) {
  const sessions=new Map<string,ResearchSession>();
  return {
    builtinMcpClients:async(binding:McpSessionBinding):Promise<BuiltinMcpClient[]>=>{
      const session=new ResearchSession(directory,binding);sessions.set(binding.sessionId,session);
      binding.sessionSignal.addEventListener('abort',()=>{void session.close().catch(()=>{}).finally(()=>{if(sessions.get(binding.sessionId)===session)sessions.delete(binding.sessionId);});},{once:true});
      if(!(await readResearchConfig(directory)).enabled)return [];
      return [{name:'eido_research',timeoutMs:190000,connect:async(bound,signal)=>{
        signal.throwIfAborted();
        const handle=session.handle(),close=handle.close.bind(handle);
        handle.close=async()=>{try{await close();}finally{if(sessions.get(bound.sessionId)===session)sessions.delete(bound.sessionId);}};
        return handle;
      }}];
    },
    get:(sessionId:string)=>sessions.get(sessionId),
    submit:(sessionId:string,descriptors:DocumentDescriptor[],requirements:RequirementReference[])=>sessions.get(sessionId)?.submit(descriptors,requirements),
    attach:async(pi:AgentSession)=>{
      // Local history stays accessible even when remote research is disabled.
      const session=sessions.get(pi.sessionId);
      if(session)await session.attach(pi);
    },
    finishTurn:async(sessionId:string)=>{await sessions.get(sessionId)?.finishTurn();},
  };
}
