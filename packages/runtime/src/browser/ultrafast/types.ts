// Eido's typed port of browser-use/jev-ultrafast. See ./LICENSE.
export type Operation = 'CLICK' | 'TYPE_TEXT' | 'SELECT' | 'SCROLL_UP' | 'SCROLL_DOWN' | 'WAIT' | 'DONE' | 'BLOCKED';
export interface Action {
  id: string; kind: 'click' | 'fill' | 'select' | 'scroll' | 'wait'; label: string;
  node?: number; role?: string; value?: string; current_value?: string;
  checked?: string|boolean; selected?: string|boolean; expanded?: string|boolean; delta?: number;
  rect?: {x:number;y:number;w:number;h:number};
}
export interface Snapshot {
  url:string; title:string; text:string; w:number; h:number; actions:Action[];
  scroll:{y:number;height:number}; marker:unknown; page_key:unknown;
  guards:Record<string,unknown>; omitted_actions:number; fingerprint:string;
  screenshot?:string;
}
export interface History {
  step:number; action:string; kind:Action['kind']; choice:string; text:string|null;
  page_changed:boolean|null; operation:Operation; target:string|null; url:string;
  latency_ms:number; elapsed_ms:number; [key:string]:unknown;
}
export interface Choice {choice:string;confidence:number;probabilities:Record<string,number>}
export interface Decision {
  choice:string; operation:Operation; target:string|null; confidence:number;
  probabilities:Record<string,number>; operation_probabilities:Record<string,number>;
  target_probabilities:Record<string,number>; target_confidence:number|null;
  raw_answers:unknown; model:string; usage:unknown; latency_ms:number; request:unknown;
  fingerprint?:string; elapsed_ms?:number;
}
export interface Helper {model:string;latency_ms:number;usage:unknown}
export interface ModelConfig {apiUrl:string;model:string;key:string}
export interface TextConfig {apiUrl?:string;model?:string;key?:string;reasoning?:'low'|'none';source?:'pi'|'custom';
  generate?:(context:string,instructions:string,signal?:AbortSignal)=>Promise<{content:string;model:string;usage:unknown}>}
