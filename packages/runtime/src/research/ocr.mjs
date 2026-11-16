import {ResearchError} from './config.mjs';

export function parseOcrResponse(data,pageIndex) {
  if(!data||data.error||data.page_count!==1||!Array.isArray(data.pages)||data.pages.length!==1||data.pages[0]?.index!==0||typeof data.pages[0]?.text!=='string'||!['stop','length'].includes(data.pages[0]?.finish_reason)) {
    throw new ResearchError('invalid_response','OCR did not return exactly one complete page record for the submitted image.');
  }
  const page=data.pages[0], raw=page.text, pattern=/<｜ref｜>([\s\S]*?)<｜\/ref｜>(?:\s*<｜box｜>([\s\S]*?)<｜\/box｜>)?/gu;
  const regions=[],mapping=[];let plain='',cursor=0,ref=0;
  function append(text,start,end,boxes=[],refIds=[]) {
    if(!text)return;
    const plainStart=Buffer.byteLength(plain);plain+=text;
    const plainEnd=Buffer.byteLength(plain);
    mapping.push({rawStart:Buffer.byteLength(raw.slice(0,start)),rawEnd:Buffer.byteLength(raw.slice(0,end)),plainStart,plainEnd});
    regions.push({start:plainStart,end:plainEnd,pageIndex,boxes,refIds});
  }
  for(const match of raw.matchAll(pattern)) {
    append(raw.slice(cursor,match.index),cursor,match.index);
    let boxes=[];
    try {const value=JSON.parse(match[2]);if(Array.isArray(value)&&value.length<=128&&value.every(box=>Array.isArray(box)&&box.length===4&&box.every(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1000)&&box[0]<box[2]&&box[1]<box[3]))boxes=value;}catch{}
    append(match[1],match.index,match.index+match[0].length,boxes,[`page-${pageIndex}-ref-${ref++}`]);cursor=match.index+match[0].length;
  }
  append(raw.slice(cursor),cursor,raw.length);
  return {raw,text:plain,regions,mapping,pageIndex,finishReason:page.finish_reason,status:page.finish_reason==='length'?'partial':'complete',regionState:regions.some(region=>region.boxes.length)?'located':'unlocated'};
}
