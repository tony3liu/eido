import {randomUUID} from 'node:crypto';
import {ResearchError,readResearchConfig} from '../../runtime/src/research/config.mjs';
import {parseOcrResponse} from '../../runtime/src/research/ocr.mjs';
import {ResearchClient} from '../../runtime/src/research/client.mjs';
import {ResearchStore,sha256,type ResearchOperation,type SourceRegion} from '../../runtime/src/research/store.mjs';
import type {McpSessionBinding} from '../adapter/src/mcp-bridge.js';

export interface DocumentDescriptor {version:1;attachmentId:string;originalName:string;mimeType:string;size:number;expectedHash:string;selectionIdentity:string;}
export function documentDescriptor(value:unknown):DocumentDescriptor {
  const d=value as DocumentDescriptor;
  if(!d||d.version!==1||!['attachmentId','originalName','selectionIdentity'].every(k=>typeof d[k as keyof DocumentDescriptor]==='string'&&String(d[k as keyof DocumentDescriptor]).length>0&&String(d[k as keyof DocumentDescriptor]).length<=1024)||
    !/^[a-f0-9]{64}$/.test(d.expectedHash)||!Number.isSafeInteger(d.size)||d.size<1||d.size>20971520||!['application/pdf','image/png','image/jpeg','image/webp','image/bmp','image/gif'].includes(d.mimeType))throw new ResearchError('invalid_document','Select the document again. Its attachment descriptor is invalid.');
  return d;
}
interface NativeCapture {version:number;handle:string;descriptor?:DocumentDescriptor;size?:number;manifest?:Record<string,any>;}
function unsuccessfulStatus(code:string|undefined) {
  if(['interrupted_unknown','invalid_response','response_limit','unavailable'].includes(code??''))return 'interrupted_unknown';
  return code==='cancelled_local'?'cancelled_local':'failed';
}
export class ResearchDocuments {
  private selections=new Map<string,DocumentDescriptor>();
  private captures=new Map<string,Record<string,unknown>>();
  constructor(readonly directory:string,readonly binding:McpSessionBinding,readonly store:ResearchStore,readonly client:ResearchClient){}
  submit(descriptors:DocumentDescriptor[]) {for(const descriptor of descriptors)this.selections.set(descriptor.attachmentId,documentDescriptor(descriptor));}
  async rpc(action:string,data:Record<string,unknown>,signal?:AbortSignal) {
    return this.binding.client.request<any>(action==='render'?'_eido/documents/render':'_eido/documents/snapshot',
      {version:1,sessionId:this.binding.sessionId,action,...data},{cancellationSignal:signal??this.binding.sessionSignal});
  }
  async chunks(capture:NativeCapture,identity:Record<string,unknown>,hash:string,size:number,signal:AbortSignal) {
    if(capture.version!==1||typeof capture.handle!=='string'||!Number.isSafeInteger(size)||size<1||size>20971520)throw new ResearchError('invalid_document','Native document capture is invalid.');
    const context={...identity,handle:capture.handle,expectedHash:hash};this.captures.set(capture.handle,context);
    const chunks:Buffer[]=[];let offset=0;
    while(offset<size){signal.throwIfAborted();const reply=await this.rpc('chunk',{...context,offset},signal);
      const bytes=typeof reply.content==='string'?Buffer.from(reply.content,'base64'):Buffer.alloc(0),expected=Math.min(262144,size-offset);
      if(reply.version!==1||reply.offset!==offset||reply.total!==size||reply.hash!==hash||bytes.length!==expected||bytes.toString('base64')!==reply.content||reply.next!==(offset+expected<size?offset+expected:null))throw new ResearchError('invalid_document','Native document chunk failed integrity validation.');
      chunks.push(bytes);offset+=bytes.length;}
    const result=Buffer.concat(chunks);if(sha256(result)!==hash)throw new ResearchError('invalid_document','Native document hash changed.');return result;
  }
  async release(handle:string){const context=this.captures.get(handle);if(context){this.captures.delete(handle);await this.rpc('release',context).catch(()=>{});}}
  async finishTurn(){await Promise.all([...this.captures.keys()].map(handle=>this.release(handle)));this.selections.clear();}
  async extract(args:Record<string,unknown>,operation:ResearchOperation,signal:AbortSignal,onAttempt:(attempt:any)=>Promise<void>) {
    const descriptor=this.selections.get(String(args.attachmentId));
    if(!descriptor)throw new ResearchError('unsubmitted_document','Attach and submit this document in the current task before extracting text.');
    const config=await readResearchConfig(this.directory);
    if(descriptor.size>config.limits.fileBytes)throw new ResearchError('file_limit','The selected document exceeds the configured file limit.');
    const turnId=this.binding.getTurnId?.();if(!turnId)throw new ResearchError('invalid_turn','Document extraction requires an active submitted turn.');
    const identity={turnId,selectionIdentity:descriptor.selectionIdentity};
    let original:NativeCapture|undefined;
    const pages:Record<string,any>[]=[];let pageCount=0,extractionId='',originalSource='',errorCode:string|undefined;
    try {
      try {original=await this.rpc('open',{...identity,attachmentId:descriptor.attachmentId},signal);}catch{throw new ResearchError('document_unavailable','The native document attachment is unavailable. Use a current Eido client and select the file again.');}
      if(Object.entries(documentDescriptor(original?.descriptor)).some(([key,value])=>descriptor[key as keyof DocumentDescriptor]!==value))throw new ResearchError('invalid_document','Native attachment identity changed.');
      const bytes=await this.chunks(original!,identity,descriptor.expectedHash,descriptor.size,signal);
      // A selected original is saved before rendering or any remote request.
      const source=await this.store.addSource({kind:'document',originalName:descriptor.originalName,originalHash:descriptor.expectedHash,mimeType:descriptor.mimeType,readState:'unread',producer:'eido-canonical-1'},{raw:bytes,operationId:operation.operationId,generation:operation.generation});
      originalSource=source.versionId;extractionId=randomUUID();
      await this.store.mutate(manifest=>manifest.extractions.push({extractionId,sourceVersionId:source.versionId,purpose:'text_recognition',renderVersion:'eido-canonical-1',status:'running',pages}),{generation:operation.generation});
      let requested:number[]|undefined;
      if(args.pages!==undefined){if(!Array.isArray(args.pages)||args.pages.length===0||args.pages.length>50||args.pages.some(p=>!Number.isSafeInteger(p)||Number(p)<0)||new Set(args.pages).size!==args.pages.length)throw new ResearchError('invalid_request','Select distinct zero-based page indices.');requested=args.pages as number[];}
      for(let index=0;index<(pageCount||1);index++) {
        signal.throwIfAborted();
        if(requested&&!requested.includes(index)&&index!==0)continue;
        const rendered:NativeCapture=await this.rpc('render',{...identity,handle:original!.handle,expectedHash:descriptor.expectedHash,pageIndex:index},signal);
        const meta=rendered.manifest;
        if(!meta||meta.pageIndex!==index||!Number.isSafeInteger(meta.pageCount)||meta.pageCount<1||meta.pageCount>config.limits.pdfPages||meta.renderVersion!=='eido-canonical-1'||!Number.isInteger(meta.renderWidth)||!Number.isInteger(meta.renderHeight)||meta.renderWidth<1||meta.renderHeight<1||meta.renderWidth>4096||meta.renderHeight>4096||meta.renderWidth*meta.renderHeight>16000000)throw new ResearchError('invalid_document','Native page rendition is invalid or exceeds the configured limit.');
        pageCount=meta.pageCount;if(requested?.some(p=>p>=pageCount))throw new ResearchError('invalid_request','The selected page range exceeds this document.');
        const png=await this.chunks(rendered,identity,meta.pngHash,rendered.size!,signal);await this.release(rendered.handle);
        if(requested&&!requested.includes(index))continue;
        const cacheKey=sha256(`${descriptor.expectedHash}:${meta.pngHash}:text_recognition:${meta.renderVersion}`);
        const manifest=await this.store.manifest();
        const cached=args.reextract===true?undefined:manifest.extractions.flatMap(e=>e.pages).find((p:any)=>p.cacheKey===cacheKey&&p.status==='complete');
        const unknown=args.reextract===true?undefined:manifest.extractions.flatMap(e=>e.pages).find((p:any)=>p.cacheKey===cacheKey&&['interrupted_unknown','failed','partial'].includes(p.status));
        let page:Record<string,any>={pageIndex:index,manifest:meta,cacheKey,status:'pending'};
        await this.store.mutate(async manifest=>{page.pngHash=(await this.store.putObject(png)).hash;manifest.extractions.find(e=>e.extractionId===extractionId)!.pages.push(page);},{generation:operation.generation});
        try {
          if(!cached&&unknown)throw new ResearchError('interrupted_unknown','This page has an earlier incomplete or unknown attempt. Explicitly choose reextract to authorize another request.');
          if(cached){
            // OCR bytes are page-independent; rebuild region identity for this target page.
            const raw=(await this.store.object(String(cached.rawHash))).toString('utf8');
            const parsed=parseOcrResponse({page_count:1,pages:[{index:0,text:raw,finish_reason:cached.finishReason}]},index);
            page={...cached,...parsed,manifest:meta,reused:true,attempts:[]};
          }
          else {
            const response=await this.client.request('ocr',{png},{operationId:operation.operationId,ownerSession:this.binding.sessionId,turnId,signal,onAttempt:attempt=>onAttempt({...attempt,pageIndex:index}),originalBytes:index===0?bytes.length:0});
            const parsed=parseOcrResponse(response.data,index);
            page={...page,...parsed,attempts:response.attempts};
          }
          await this.store.mutate(async manifest=>{
            if(page.raw!==undefined)page.rawHash=(await this.store.putObject(page.raw)).hash;
            if(page.text!==undefined)page.textHash=(await this.store.putObject(page.text)).hash;
            delete page.raw;delete page.text;
            const entry=manifest.extractions.find(e=>e.extractionId===extractionId)!;entry.pages=entry.pages.map(p=>p.pageIndex===index?page:p);
          },{generation:operation.generation});
        } catch(error) {
          errorCode=error instanceof ResearchError?error.code:signal.aborted?'cancelled_local':'interrupted_unknown';
          page={...page,status:unsuccessfulStatus(errorCode),error:errorCode};
          await this.store.mutate(manifest=>{const entry=manifest.extractions.find(e=>e.extractionId===extractionId)!;entry.pages=entry.pages.map(p=>p.pageIndex===index?page:p);},{generation:operation.generation});
          break;
        }
      }
    } catch(error) {errorCode=error instanceof ResearchError?error.code:signal.aborted?'cancelled_local':'interrupted_unknown';if(!extractionId)throw error;}
    finally{if(original?.handle)await this.release(original.handle);}
    const current=(await this.store.manifest()).extractions.find(e=>e.extractionId===extractionId);
    if(!current)throw new ResearchError('source_deleted','Local source deleted during extraction.');
    let body='',hasAcceptedResult=false;const regions:SourceRegion[]=[];
    for(const page of current.pages as Record<string,any>[]){if(!page.textHash)continue;const text=(await this.store.object(page.textHash)).toString('utf8'),offset=Buffer.byteLength(body);hasAcceptedResult ||= page.status==='complete'||page.status==='partial'&&text.trim().length>0;body+=text+'\n';regions.push(...(page.regions??[]).map((r:SourceRegion)=>({...r,start:r.start+offset,end:r.end+offset})));}
    const wanted=Array.isArray(args.pages)?args.pages as number[]:Array.from({length:pageCount},(_,i)=>i),missingPages=wanted.filter(index=>!current.pages.some(p=>p.pageIndex===index&&p.status==='complete'));
    // A complete blank page is an accepted result; an empty truncated page is not.
    const status=errorCode||missingPages.length?(hasAcceptedResult?'partial':unsuccessfulStatus(errorCode)):'complete';
    const final=await this.store.addSource({kind:'document',originalName:descriptor.originalName,originalHash:descriptor.expectedHash,mimeType:descriptor.mimeType,parentVersionId:originalSource,regions,readState:status==='complete'?'read':status==='partial'?'partial':'failed',producer:'eido-canonical-1',extractionId,limitations:[...(missingPages.length?['Some pages are missing or partial.']:[]),...(errorCode?[errorCode]:[])]},{body,operationId:operation.operationId,generation:operation.generation});
    await this.store.mutate(manifest=>{Object.assign(manifest.extractions.find(e=>e.extractionId===extractionId)!,{sourceVersionId:final.versionId,originalSourceVersionId:originalSource,status,missingPages,pageCount,error:errorCode});},{generation:operation.generation});
    return {source:final,extractionId,status,missingPages,pages:current.pages.map(p=>({pageIndex:p.pageIndex,status:p.status,reused:p.reused??false})),error:errorCode};
  }
}
