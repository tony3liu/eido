// Complete loopback inspector adapter for the upstream Jev demo.
// Copyright 2026 Browser Use. MIT license in ./LICENSE.
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {FastAgent} from './agent.ts';
export interface InspectorPort {
  state():Record<string,unknown>;
  command(name:string,body:Record<string,unknown>,origin:string):Promise<Record<string,unknown>>;
}
export async function startInspector(port:InspectorPort,requestedPort=0) {
  const token=randomBytes(32).toString('base64url');let origin='';let busy=false;
  const server=createServer(async(req,res)=>{
    const send=(status:number,content:string|Buffer,mime='application/json')=>{
      const bytes=Buffer.isBuffer(content)?content:Buffer.from(content);
      res.writeHead(status,{'Content-Type':mime,'Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(bytes);
    };
    if(req.headers.host!==new URL(origin).host) return send(403,'Forbidden','text/plain');
    const path=new URL(req.url??'/',origin).pathname;
    if(req.method==='GET') {
      if(path==='/api/state') return send(200,JSON.stringify(port.state()));
      const files:Record<string,[string,string]>={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],
        '/style.css':['style.css','text/css'],'/fixture.html':['scenarios.html','text/html']};
      const file=files[path];if(!file) return send(404,'Not found','text/plain');
      try {const source=await readFile(new URL('./static/'+file[0],import.meta.url),'utf8');
        return send(200,source.replaceAll('__TOKEN__',token),file[1]+'; charset=utf-8');}
      catch {return send(500,'Inspector resources unavailable','text/plain');}
    }
    if(req.method!=='POST'||req.headers['x-demo-token']!==token||(req.headers.origin&&req.headers.origin!==origin))
      return send(403,JSON.stringify({error:'Local demo requests only'}));
    if(busy) return send(409,JSON.stringify({error:'A browser step is already running'}));
    busy=true;
    try {
      const length=Number(req.headers['content-length']);
      if(!Number.isInteger(length)||length<=0||length>=8192) throw new Error('Invalid request size');
      const chunks:Buffer[]=[];let received=0;
      for await(const chunk of req) {received+=chunk.length;if(received>=8192) throw new Error('Invalid request size');chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString());
      if(!body||Array.isArray(body)||typeof body!=='object') throw new Error('Invalid command body');
      if(!['reset','predict','act','tick'].includes(path.replace('/api/',''))) throw new Error('Unknown command');
      return send(200,JSON.stringify(await port.command(path.replace('/api/',''),body,origin)));
    } catch(error) {return send(400,JSON.stringify({error:(error as Error).message}));}
    finally {busy=false;}
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(requestedPort,'127.0.0.1',resolve);});
  origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  return {url:origin,close:async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}
export function inspectorState(agent:FastAgent|null,textModel:string) {
  return {...(agent?agent.snapshot():{page:null,status:'idle',history:[],decision:null}),text_model:textModel,max_steps:60};
}
