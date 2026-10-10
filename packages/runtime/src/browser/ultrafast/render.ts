// Render original screencast timestamps at 1x; no acceleration or fabricated page content.
// Browser Use's fixture/flights renderers adapted to a native canvas transport.
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
export async function renderRecording(source:string,ffmpeg:string,mode:'flights'|'fixture'='flights') {
  const folder=resolve(source),state=JSON.parse(await readFile(join(folder,'state.json'),'utf8'));
  if(!state.verification?.passed) throw new Error('Render requires independent final-page verification');
  let recordingErrors=state.recording_errors??[];
  try {recordingErrors=JSON.parse(await readFile(join(folder,'recording.json'),'utf8')).recording_errors;} catch { /* Per-step recordings have no recording.json. */ }
  if(recordingErrors.length) throw new Error('Render requires a recording without errors');
  const frames=[];
  for(const directory of ['frames','screencast']){
    let files:string[]=[];try{files=await readdir(join(folder,directory));}catch{/* Optional frame collection. */}
    for(const name of files.filter(name=>/^\d+\.jpg$/.test(name)))frames.push({timestamp:Number(name.slice(0,-4)),path:join(folder,directory,name)});
  }
  if(!frames.length)for(const name of (await readdir(folder)).filter(name=>/^\d+\.jpg$/.test(name)))frames.push({timestamp:Number(name.slice(0,-4)),path:join(folder,name)});
  frames.sort((a,b)=>a.timestamp-b.timestamp);
  if(!frames.length||frames[0]!.timestamp!==0)throw new Error('Recording needs an initial frame at timestamp zero');
  const width=mode==='flights'?1536:1240,height=mode==='flights'?1000:960,end=state.elapsed_ms;
  const destination=join(folder,'video-frames');await mkdir(destination,{recursive:true});
  const browser=await chromium.launch();
  try {
    const page=await browser.newPage({viewport:{width,height}});
    // tsx preserves nested function names through this helper during development.
    await page.evaluate('window.__name=(fn)=>fn');
    await page.setContent(`<canvas width="${width}" height="${height}"></canvas>`);
    const count=Math.round((end+(mode==='flights'?500:2000))*30/1000);
    let selected=-1;
    for(let i=0;i<count;i++){
      const t=Math.min(end,Math.max(0,Math.round(i*1000/30)-(mode==='fixture'?750:0)));
      let index=0;while(index+1<frames.length&&frames[index+1]!.timestamp<=t)index++;
      if(selected!==index){
        selected=index;const frame=await readFile(frames[index]!.path);
        await page.evaluate(async data=>{const image=new Image();image.src='data:image/jpeg;base64,'+data;await image.decode();(window as any).frame=image;},frame.toString('base64'));
      }
      await page.evaluate(({t,end,state,mode,width,height})=>{
        const ctx=document.querySelector('canvas')!.getContext('2d')!,image=(window as any).frame;
        const text=(value:string,x:number,y:number,size=20,color='#172a20',bold=false)=>{ctx.font=`${bold?'bold ':''}${size}px Arial`;ctx.fillStyle=color;ctx.fillText(value,x,y);};
        ctx.fillStyle='#f3f4ec';ctx.fillRect(0,0,width,height);
        const history=state.history.filter((h:any)=>(h.executed_ms??h.elapsed_ms)<=t);
        if(mode==='fixture'){
          ctx.drawImage(image,60,105,1120,780);text('EIDO × JEV ULTRAFAST',60,58,23);text(`${(t/1000).toFixed(2)}s / 1×`,945,58,17,'#487645');
          text(`Jev Ultrafast     ${history.length} browser actions     Live API calls`,60,930,17,'#64745c');return;
        }
        text('Eido × Jev Ultrafast',36,49,23,'#172a20',true);text('REAL WEB · 1× SPEED',1310,47,14,'#2a743f',true);
        text(`Zürich → London. In ${(end/1000).toFixed(1)} seconds.`,36,121,43,'#172a20',true);
        text('One goal. Dynamic elements. LLM-generated text.',38,159);
        ctx.fillStyle='#202124';ctx.fillRect(35,191,1122,752);text('google.com/travel/flights',145,214,13,'#d4d6d5');
        // Same upstream task-area crop; account controls are excluded consistently.
        ctx.drawImage(image,0,64,1120,716,36,226,1120,716);
        text('JEV ULTRAFAST',1192,222,16,'#2a743f',true);text((t/1000).toFixed(2),1189,294,52);text('SECONDS ELAPSED',1193,320,13,'#6a766c');
        const steps=[['One way','One way'],['Zürich','Zürich, Switzerland'],['London','London, United Kingdom'],['20 September','Done. Search'],['Search flights','Search']];
        steps.forEach(([label,key],j)=>{const done=history.some((h:any)=>h.action===key||(key==='Done. Search'&&h.action.startsWith(key)));text((done?'✓ ':'○ ')+label,1194,390+j*54,21,done?'#172a20':'#6a766c',done);});
        const search=state.history.find((h:any)=>h.action==='Search');
        text(t>=end?'Flights found':search&&t>=search.executed_ms?'Waiting for Google…':'Choose. Act. Repeat.',1200,717,22,'#2a743f',true);
        text(t>=end?'Route + date verified':`${history.length} actions executed`,1200,757,16,'#6a766c');
        const latencies=state.decisions.filter((d:any)=>d.elapsed_ms<=t).map((d:any)=>d.latency_ms).sort((a:number,b:number)=>a-b);
        const median=latencies.length?(latencies[Math.floor((latencies.length-1)/2)]+latencies[Math.ceil((latencies.length-1)/2)])/2:null;
        text(median===null?'—':`${median.toFixed(0)} ms`,1194,865,30);text('median decision latency',1194,898,16,'#6a766c');
        ctx.fillStyle='#d3d9cc';ctx.fillRect(37,960,1461,2);ctx.fillStyle='#2a743f';ctx.fillRect(37,960,1461*t/end,3);
        text(`Operation + index by Jev. Text by ${state.text_calls[0]?.model??'text helper'}. Original timing; waits included.`,37,991,14,'#6a766c');
      },{t,end,state,mode,width,height});
      await writeFile(join(destination,String(i).padStart(4,'0')+'.png'),await page.locator('canvas').screenshot());
    }
    await writeFile(join(folder,'result.png'),await page.locator('canvas').screenshot());
    for(const [name,args] of [['demo.mp4',['-c:v','libx264','-pix_fmt','yuv420p','-crf','18','-movflags','+faststart']],
      ['demo.gif',['-vf','fps=12,scale=1152:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse','-loop','0']]] as const){
      await new Promise<void>((resolve,reject)=>{
        const child=spawn(ffmpeg,['-y','-loglevel','error','-framerate','30','-i',join(destination,'%04d.png'),...args,join(folder,name)],{stdio:['ignore','ignore','pipe']});
        let error='';child.stderr.on('data',data=>error+=data);child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`Video encoder failed: ${error.slice(0,1000)}`)));
      });
    }
    return {frames:count,elapsed_ms:end,video:join(folder,'demo.mp4'),gif:join(folder,'demo.gif'),result:join(folder,'result.png')};
  }finally{await browser.close();}
}
