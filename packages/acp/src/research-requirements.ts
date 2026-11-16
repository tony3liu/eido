import {randomUUID} from 'node:crypto';
import {ResearchError} from '../../runtime/src/research/config.mjs';
import {ResearchStore,type Requirement,type Criterion} from '../../runtime/src/research/store.mjs';
const allowed=(value:Record<string,unknown>,keys:string[])=>{if(Object.keys(value).some(key=>!keys.includes(key)))throw new ResearchError('invalid_requirement','Unsupported requirement fields. Model assessments cannot set verification results.');};
const text=(value:unknown,label:string,max=16384)=>{if(typeof value!=='string'||!value.trim()||Buffer.byteLength(value)>max)throw new ResearchError('invalid_requirement',`${label} is required and must fit within ${max} bytes.`);return value;};
const strings=(value:unknown,label:string,max=50):string[]=>{if(!Array.isArray(value)||value.length>max||value.some(v=>typeof v!=='string'||!v||v.length>4096))throw new ResearchError('invalid_requirement',`${label} must be a bounded list of strings.`);return [...new Set(value)] as string[];};
export class ResearchRequirements {
  constructor(readonly store:ResearchStore){}
  async get(id:string,revision?:number) {const list=(await this.store.manifest()).requirements.filter(r=>r.requirementId===id);const requirement=revision===undefined?list.at(-1):list.find(r=>r.revision===revision);if(!requirement)throw new ResearchError('requirement_unavailable','Requirement revision is unavailable in this task.');return requirement;}
  async execute(args:Record<string,unknown>,operation?:{operationId:string;turnId:string}) {
    if(operation){const old=(await this.store.manifest()).operations.find(o=>o.operationId===operation.operationId);if(old?.status==='complete')return (old as any).result;}
    if(args.action==='list'){const manifest=await this.store.manifest();return {requirements:manifest.requirements.filter(r=>!manifest.requirements.some(l=>l.requirementId===r.requirementId&&l.revision>r.revision)).slice(0,100),revision:manifest.revision};}
    if(args.action==='get')return {requirement:await this.get(text(args.requirementId,'Requirement ID'),args.revision as number|undefined),status:'Not checked'};
    if(!['create','update'].includes(String(args.action)))throw new ResearchError('invalid_requirement','Unsupported requirement action.');
    allowed(args,['action','requirementId','expectedRevision','title','text','citationIds','relatedFiles','criteria']);
    const title=text(args.title,'Title',512),body=text(args.text,'Requirement'),citationIds=strings(args.citationIds??[],'Citation IDs'),relatedFiles=strings(args.relatedFiles??[],'Related files');
    if(!Array.isArray(args.criteria)||args.criteria.length<1||args.criteria.length>50)throw new ResearchError('invalid_requirement','Provide 1–50 acceptance criteria.');
    const old=args.action==='update'?await this.get(text(args.requirementId,'Requirement ID')):undefined;
    if(old&&args.expectedRevision!==old.revision)throw new ResearchError('conflict','Requirement changed. Reload before editing.');
    const criteria:Criterion[]=args.criteria.map(raw=>{
      if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new ResearchError('invalid_requirement','Invalid criterion.');
      allowed(raw,['criterionId','text','checkType','checkSpec','sourceCitationIds']);
      if(!['command','manual'].includes(raw.checkType))throw new ResearchError('invalid_requirement','Criterion check type must be command or manual.');
      const id=raw.criterionId??randomUUID();if(typeof id!=='string'||id.length>128||raw.criterionId&&!old?.criteria.some(c=>c.criterionId===id))throw new ResearchError('invalid_requirement','Criterion belongs to another requirement.');
      if(raw.checkType==='command')text(raw.checkSpec,'Check command',4096);
      return {criterionId:id,text:text(raw.text,'Criterion',8192),checkType:raw.checkType,checkSpec:raw.checkSpec,sourceCitationIds:strings(raw.sourceCitationIds??citationIds,'Criterion citations')};
    });
    if(new Set(criteria.map(c=>c.criterionId)).size!==criteria.length)throw new ResearchError('invalid_requirement','Criterion IDs must be distinct.');
    const requirement:Requirement={requirementId:old?.requirementId??randomUUID(),revision:(old?.revision??0)+1,title,text:body,citationIds,relatedFiles,criteria,createdAt:Date.now()};
    let confirmed=true;
    let saved:unknown;
    await this.store.mutate(manifest=>{
      const completed=operation?manifest.operations.find(o=>o.operationId===operation.operationId):undefined;if(completed?.status==='complete'){saved=(completed as any).result;return;}
      if(old&&manifest.requirements.filter(r=>r.requirementId===old.requirementId).at(-1)?.revision!==old.revision)throw new ResearchError('conflict','Requirement changed. Reload before editing.');
      for(const id of new Set([...citationIds,...criteria.flatMap(c=>c.sourceCitationIds)])){
        const citation=manifest.citations.find(c=>c.citationId===id);if(!citation||!manifest.sources.some(s=>s.versionId===citation.sourceVersionId))throw new ResearchError('source_unavailable','A requirement citation is unavailable in this task.');
        if(citation.matchState!=='exact')confirmed=false;
      }
      manifest.requirements.push(requirement);
      for(const link of manifest.links)if(link.requirementId===requirement.requirementId){link.freshness='needs_recheck';link.status='Needs recheck';}
      saved={requirement,status:'Not checked',sources:confirmed&&citationIds.length?'Confirmed':'Unconfirmed'};
      if(operation)manifest.operations.push({...operation,ownerSession:this.store.sessionId,kind:'requirements',status:'complete',generation:manifest.generation,createdAt:Date.now(),finishedAt:Date.now(),receipt:'pending',result:saved} as any);
    });
    return saved;
  }
}

export interface ResearchScope {requestId:string;ownerSession:string;turnId?:string;requirements:{requirementId:string;revision:number;title?:string;citationUrls?:string[]}[];}
export interface ResearchProvenance extends ResearchScope {version:1;toolCallId:string;}
export interface ResearchHooks {
  capture(toolCallId:string,criterionIds?:string[]):Promise<ResearchProvenance|undefined>;
  edit(provenance:ResearchProvenance|undefined,path:string,contentHash:string):Promise<void>;
  checks(provenance:ResearchProvenance|undefined,criterionIds:string[]|undefined,evidence:Record<string,any>):Promise<Record<string,unknown>[]>;
}
/** Scope is supplied by the actual submitted native requirement resource, never tool arguments. */
export function requirementHooks(store:ResearchStore,scope:()=>ResearchScope|undefined):ResearchHooks {
  return {
    async capture(toolCallId,criterionIds){
      const current=scope();
      if(!current?.turnId){if(criterionIds?.length)throw new ResearchError('invalid_scope','Submit a requirement before associating acceptance checks.');return;}
      const manifest=await store.manifest(),criteria=new Set<string>();
      for(const ref of current.requirements){const latest=manifest.requirements.filter(r=>r.requirementId===ref.requirementId).at(-1);if(latest?.revision!==ref.revision)throw new ResearchError('stale_requirement','Requirement changed. Submit its latest revision before making linked changes.');for(const c of latest.criteria)criteria.add(c.criterionId);}
      if(criterionIds?.some(id=>!criteria.has(id)))throw new ResearchError('invalid_scope','Acceptance criterion does not belong to this submitted requirement revision.');
      return {version:1,...structuredClone(current),toolCallId,requirements:current.requirements.map(ref=>{const requirement=manifest.requirements.find(r=>r.requirementId===ref.requirementId&&r.revision===ref.revision)!;return {...ref,title:requirement.title,citationUrls:requirement.citationIds.flatMap(id=>{const c=manifest.citations.find(c=>c.citationId===id);return c?[`eido-source://${c.sourceVersionId}/${c.citationId}`]:[];})};})};
    },
    async edit(provenance,path,contentHash){
      if(!provenance)return;
      await store.mutate(manifest=>{for(const ref of provenance.requirements){for(const link of manifest.links)if(link.requirementId===ref.requirementId&&link.kind==='check'){link.freshness='needs_recheck';link.status='Needs recheck';}manifest.links.push({...provenance,...ref,kind:'edit',path,contentHash,createdAt:Date.now(),freshness:'not_checked'});}});
    },
    async checks(provenance,criterionIds,evidence){
      if(!provenance||!criterionIds?.length)return [];
      const result:Record<string,unknown>[]=[];
      await store.mutate(manifest=>{
        for(const ref of provenance.requirements){
          const requirement=manifest.requirements.find(r=>r.requirementId===ref.requirementId&&r.revision===ref.revision);
          const latest=manifest.requirements.filter(r=>r.requirementId===ref.requirementId).at(-1);
          for(const criterion of requirement?.criteria??[]){
            if(!criterionIds.includes(criterion.criterionId))continue;
            const command=(evidence.project?.checks??[]).find((check:any)=>typeof check.command==='string'&&Array.isArray(check.args)&&[check.command,...check.args].join(' ')===criterion.checkSpec);
            const finished=command&&Number.isFinite(Date.parse(command.finishedAt))&&Number.isInteger(command.exitCode);
            const fresh=latest?.revision===ref.revision&&evidence.freshness?.state==='current';
            const status=!fresh?'Needs recheck':criterion.checkType!=='command'||!finished?'Not checked':command.timedOut||command.exitCode!==0?'Failed':'Passed';
            const link={...provenance,...ref,kind:'check',criterionId:criterion.criterionId,runId:evidence.runId,inputFingerprint:evidence.fingerprint,files:evidence.files,dependencies:evidence.dependencies,dependencyInputs:evidence.dependencyInputs,cwd:evidence.cwd,check:command??null,status,freshness:fresh?'current':'needs_recheck',checkedAt:evidence.freshness?.checkedAt};
            // One immutable result per run; newer status reads may only invalidate its freshness.
            const old=manifest.links.find(l=>l.kind==='check'&&l.runId===link.runId&&l.criterionId===link.criterionId);
            if(!old)manifest.links.push(link);else if(!fresh){old.freshness='needs_recheck';old.status='Needs recheck';}
            result.push(old??link);
          }
        }
      });return result;
    },
  };
}
