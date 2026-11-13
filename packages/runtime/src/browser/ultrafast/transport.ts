// Reuse bundled pi's HTTP client dependency without modifying its dispatcher.
// One pooled connection per origin, HTTP/2 when supported, with proxy support.
import {createRequire} from 'node:module';
import {bundledPiEntry} from '../../paths.mjs';
const {EnvHttpProxyAgent, fetch} = createRequire(bundledPiEntry)('undici') as typeof import('../../../../acp/node_modules/undici/index.js');
const dispatcher=new EnvHttpProxyAgent({allowH2:true,connections:1});
export const modelFetch=(url:string,options:Parameters<typeof fetch>[1])=>fetch(url,{...options,dispatcher});
