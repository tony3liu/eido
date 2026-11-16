export type ReadState='read'|'unread'|'summary_only'|'partial'|'failed';
export interface SourceRegion {start:number;end:number;pageIndex:number;refIds?:string[];boxes:number[][];}
export interface SourceVersion {
  sourceId:string;versionId:string;kind:'search_summary'|'web'|'document';ownerSession:string;capturedAt:string;
  canonicalUrl?:string;originalName?:string;title?:string;parentVersionId?:string;bodyHash?:string;rawHash?:string;
  readState:ReadState;limitations:string[];producer?:string;regions?:SourceRegion[];
  [key:string]:unknown;
}
export interface Citation {
  citationId:string;sourceVersionId:string;quote:string;range:[number,number]|null;
  matchState:'exact'|'ambiguous'|'unmatched'|'summary_only'|'unlocated';locationType:string;regions?:SourceRegion[];url?:string;
}
export interface ResearchOperation {
  operationId:string;turnId:string;ownerSession:string;kind:string;status:string;generation:number;createdAt:number;
  receipt:'pending'|'recorded';sourceRefs?:string[];citationRefs?:string[];usageRefs?:string[];attemptId?:string;finishedAt?:number;
}
export interface Criterion {criterionId:string;text:string;checkType:string;checkSpec?:unknown;sourceCitationIds:string[];}
export interface Requirement {requirementId:string;revision:number;title:string;text:string;citationIds:string[];relatedFiles:string[];criteria:Criterion[];createdAt?:number;}
export interface Extraction {extractionId:string;sourceVersionId:string;purpose:string;renderVersion:string;status:string;pages:Record<string,unknown>[];[key:string]:unknown;}
export interface TaskManifest {
  schemaVersion:1;sessionId:string;workspaceIdentity:string;revision:number;generation:number;
  sources:SourceVersion[];citations:Citation[];extractions:Extraction[];requirements:Requirement[];
  links:Record<string,unknown>[];operations:ResearchOperation[];deletions:{deletionId:string;versionIds:string[];deletedAt:number}[];
}
export const sha256:(value:string|Uint8Array)=>string;
export function researchRoot(directory?:string):string;
export function secureDirectory(path:string):Promise<void>;
export function readJsonFile<T>(path:string,fallback:T):Promise<T>;
export function atomicJson(path:string,value:unknown):Promise<void>;
export function withResearchLock<T>(directory:string,action:()=>Promise<T>):Promise<T>;
export class ResearchStore {
  sessionId:string;workspaceIdentity:string;root:string;path:string;
  constructor(options:{directory?:string;sessionId:string;workspaceIdentity?:string});
  manifest():Promise<TaskManifest>;
  mutate<T>(action:(manifest:TaskManifest)=>T|Promise<T>,options?:{expectedRevision?:number;generation?:number}):Promise<{value:T;revision:number}>;
  putObject(bytes:string|Uint8Array):Promise<{hash:string;size:number}>;
  object(hash:string):Promise<Buffer>;
  beginOperation(input:{operationId?:string;turnId:string;kind:string}):Promise<ResearchOperation>;
  setOperation(operationId:string,changes:Partial<ResearchOperation>):Promise<ResearchOperation>;
  addSource(input:Partial<SourceVersion>&Pick<SourceVersion,'kind'>,options?:{body?:string;raw?:Uint8Array;operationId?:string;generation?:number}):Promise<SourceVersion>;
  source(versionId:string):Promise<SourceVersion>;
  read(versionId:string,offset?:number,limit?:number):Promise<{source:SourceVersion;text:string;offset:number;next:number|null;truncated:boolean}>;
  cite(versionId:string,quote:string,range?:[number,number],operationId?:string):Promise<Citation & {url:string}>;
  cancel(operationId:string):Promise<ResearchOperation>;
  recover():Promise<ResearchOperation[]>;
  deleteSources(versionIds:string[],expectedRevision:number,operationId?:string):Promise<{value:{deleted:number;affectedCitations:number};revision:number}>;
  gc():Promise<void>;
  copyTo(target:ResearchStore):Promise<void>;
}
