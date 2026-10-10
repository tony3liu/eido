// Continuous CDP recording at original timestamps, equivalent to record_flights.py.
// Copyright 2026 Browser Use. MIT license in ./LICENSE.
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import type {FastBrowser} from './browser.ts';
export async function startRecording(browser:FastBrowser,folder:string) {
  await mkdir(join(folder,'frames'),{recursive:true});await mkdir(join(folder,'screencast'),{recursive:true});
  const initial=await browser.call('Page.captureScreenshot',{format:'jpeg',quality:85});
  await writeFile(join(folder,'frames','000000.jpg'),Buffer.from(initial.data,'base64'));
  const errors:string[]=[];let pending=Promise.resolve(),epoch=Date.now()/1000,stopped=false,count=0;
  const listener=(params:any)=>{
    if(stopped) return;
    // Queue writes and acknowledgements to retain event order and backpressure.
    const timestamp=Math.max(0,Math.round((params.metadata.timestamp-epoch)*1000));
    pending=pending.then(async()=>{
      await writeFile(join(folder,'screencast',String(timestamp).padStart(6,'0')+'.jpg'),Buffer.from(params.data,'base64'));
      await browser.call('Page.screencastFrameAck',{sessionId:params.sessionId});count++;
    }).catch(()=>{errors.push('Screencast frame could not be saved or acknowledged');});
  };
  browser.session.on('Page.screencastFrame',listener);
  try {await browser.call('Page.startScreencast',{format:'jpeg',quality:80,maxWidth:1120,maxHeight:780,everyNthFrame:2});}
  catch(error) {browser.session.off('Page.screencastFrame',listener);throw error;}
  epoch=Date.now()/1000;
  return {folder,anchor:()=>{epoch=Date.now()/1000;},stop:async()=>{
    if(!stopped) {
      await delay(80);stopped=true;browser.session.off('Page.screencastFrame',listener);
      await pending;
      try {await browser.call('Page.stopScreencast');} catch {errors.push('Screencast stopped when the browser session ended');}
      await writeFile(join(folder,'recording.json'),JSON.stringify({frames:count,recording_errors:errors},null,2));
    }
    return {frames:count,recording_errors:errors};
  }};
}
