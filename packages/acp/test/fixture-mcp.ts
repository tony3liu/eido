import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';

export async function oauthFixture(options: {manual?:boolean} = {}) {
  let origin='', access='initial-mcp-access', refresh='initial-mcp-refresh';
  let codeChallenge='', refreshes=0, calls=0, browserFlows=0, mode: 'normal'|'scope'|'reject' = 'normal';
  const server=createServer(async(req,res)=> {
    const url=new URL(req.url!,origin);
    const json=(data:unknown,status=200)=>res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(data));
    if(url.pathname.startsWith('/.well-known/oauth-protected-resource'))return json({resource:origin+'/mcp',authorization_servers:[origin],scopes_supported:['tools']});
    if(url.pathname==='/.well-known/oauth-authorization-server')return json({issuer:origin,authorization_endpoint:origin+'/authorize',token_endpoint:origin+'/token',registration_endpoint:origin+'/register',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256']});
    let body='';for await(const chunk of req)body+=chunk;
    if(url.pathname==='/register')return json({...JSON.parse(body),client_id:'eido-local-client'},201);
    if(url.pathname==='/authorize') {
      if(options.manual && !url.searchParams.has('approved')) {
        url.searchParams.set('approved','1');
        return res.writeHead(200,{'content-type':'text/html'}).end(`<html><title>Eido local OAuth test</title><body><h1>Eido local OAuth test</h1><p>Disposable local fixture. No account or external service.</p><a href="${url.href.replaceAll('&','&amp;')}">Approve local test</a></body></html>`);
      }
      browserFlows++;
      assert.equal(url.searchParams.get('code_challenge_method'),'S256');
      codeChallenge=url.searchParams.get('code_challenge')!;
      const callback=new URL(url.searchParams.get('redirect_uri')!);callback.searchParams.set('code','fixture-code');callback.searchParams.set('state',url.searchParams.get('state')!);
      return res.writeHead(302,{location:callback.href}).end();
    }
    if(url.pathname==='/token') {
      const form=new URLSearchParams(body);
      if(form.get('grant_type')==='authorization_code') {
        if(form.get('code')!=='fixture-code'||createHash('sha256').update(form.get('code_verifier')??'').digest('base64url')!==codeChallenge)return json({error:'invalid_grant'},400);
      }else {
        if(form.get('refresh_token')!==refresh||mode==='reject')return json({error:'invalid_grant'},400);
        refreshes++;access=`refreshed-access-${refreshes}`;refresh=`refreshed-refresh-${refreshes}`;
      }
      return json({access_token:access,refresh_token:refresh,token_type:'Bearer',expires_in:3600,scope:'tools'});
    }
    if(mode==='scope')return res.writeHead(403,{'www-authenticate':`Bearer error="insufficient_scope", scope="admin", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`}).end();
    if(req.headers.authorization!==`Bearer ${access}`||mode==='reject')return res.writeHead(401,{'www-authenticate':`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`}).end();
    if(req.method==='GET')return res.writeHead(405).end();
    if(req.method==='DELETE')return res.writeHead(200).end();
    const message=JSON.parse(body);
    if(message.id===undefined)return res.writeHead(202).end();
    const result=message.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'Eido OAuth fixture',version:'1'}}
      :message.method==='tools/list'?{tools:[{name:'ping',description:'Test local OAuth',inputSchema:{type:'object',properties:{}}}]}
      :message.method==='tools/call'?(calls++,{content:[{type:'text',text:'OAuth fixture reached'}]}):{};
    return json({jsonrpc:'2.0',id:message.id,result});
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');origin=`http://127.0.0.1:${address.port}`;
  return {url:origin+'/mcp',origin,refreshes:()=>refreshes,calls:()=>calls,browserFlows:()=>browserFlows,
    expire:()=>{access='expired-by-server';},setMode:(value:typeof mode)=>{mode=value;},
    close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
