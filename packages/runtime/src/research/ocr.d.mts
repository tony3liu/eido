import type {SourceRegion} from './store.mjs';
export interface OcrPage {raw:string;text:string;regions:SourceRegion[];mapping:{rawStart:number;rawEnd:number;plainStart:number;plainEnd:number}[];pageIndex:number;finishReason:'stop'|'length';status:'complete'|'partial';regionState:'located'|'unlocated';}
export function parseOcrResponse(data:unknown,pageIndex:number):OcrPage;
