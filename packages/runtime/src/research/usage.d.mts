export const researchPrice:Readonly<{version:string;asOf:string;currency:'CNY';search:number;fetch:number;ocr:number;source:string}>;
export interface UsageAttempt {
  attemptId:string;operationId:string;ownerSession:string;turnId:string;kind:'search'|'fetch'|'ocr';configRevision:number;
  ownerPid:number;status:string;billingState:string;createdAt:number;leaseUntil:number;dispatchedAt?:number;finishedAt?:number;
  originalBytes:number;reserved:{uploadBytes:number;ocrPages:number;maximumCny:number};currency:'CNY';priceVersion:string;estimatedCny?:number|null;
}
export interface UsageSummary {
  attempts:number;successful:number;partial:number;unknown:number;searchCalls:number;fetchCalls:number;ocrPages:number;
  uploadedBytes:number;originalBytes:number;estimatedCny:number;unknownMaximumCny:number|null;currency:'CNY';priceVersion:string;priceSource:string;
  remaining?:{attempts24h:number;uploadBytes24h:number;ocrPages24h:number};
}
export function summarizeUsage(attempts:UsageAttempt[],now?:number,limits?:import('./config.mjs').ResearchLimits):UsageSummary;
export class ResearchUsage {
  constructor(directory?:string);
  reserve(input:{operationId:string;attemptId?:string;ownerSession:string;turnId:string;kind:'search'|'fetch'|'ocr';uploadBytes?:number;ocrPages?:number;originalBytes?:number}):Promise<UsageAttempt>;
  dispatch(attemptId:string):Promise<UsageAttempt>;
  settle(attemptId:string,result:{status:string;billable?:boolean;billingUnknown?:boolean;returnedPages?:number}):Promise<UsageAttempt>;
  summary(ownerSession?:string):Promise<{global:UsageSummary;task:UsageSummary|null}>;
}
