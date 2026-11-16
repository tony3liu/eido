import type {ResearchConfig} from './config.mjs';
import type {ResearchUsage} from './usage.mjs';
export function searchInput(input:Record<string,unknown>):{query:string;count:number;need_content:boolean};
export function fetchInput(input:Record<string,unknown>):{url:string};
export function utf8Prefix(text:string,limit:number):string;
export interface ResearchResponse {data:any;raw:Buffer;attempts:string[];config:ResearchConfig;partial:boolean;}
export class ResearchClient {
  constructor(options:{directory:string;modelRuntime?:unknown;usage?:ResearchUsage;fetch?:typeof fetch});
  request(kind:'search'|'fetch'|'ocr',input:unknown,context:{operationId:string;ownerSession:string;turnId:string;signal?:AbortSignal;originalBytes?:number;onAttempt?:(attempt:any)=>Promise<void>}):Promise<ResearchResponse>;
  check(kind:string,revision:number,error?:unknown):Promise<void>;
}
