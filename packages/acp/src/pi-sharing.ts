import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {AgentSession, ExtensionUIContext} from '@earendil-works/pi-coding-agent';
// Reuse the bundled pi report/export implementations; only its terminal UI is replaced.
import {collectBugReportMetadata, collectBugReportDiagnostics, writeBugReportArchive, bugReportArchiveFileName} from '../node_modules/@earendil-works/pi-coding-agent/dist/core/bug-report.js';
import {uploadBugReport} from '../node_modules/@earendil-works/pi-coding-agent/dist/core/bug-report-upload.js';
import {serializeSessionBranch} from '../node_modules/@earendil-works/pi-coding-agent/dist/core/session-export.js';
import {getRadiusGatewayUrl} from '../node_modules/@earendil-works/pi-coding-agent/dist/core/radius.js';
import {getAuthCredential} from '../node_modules/@earendil-works/pi-coding-agent/dist/cli/auth-command.js';
import {createShareTrailingEntries} from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/session-share.js';
const exec = promisify(execFile);

export async function shareCommand(pi:AgentSession, ui:ExtensionUIContext|undefined, agentDir:string, argument:string, signal?:AbortSignal) {
  if(argument) throw new Error('Usage: /share (no arguments).');
  if(!ui) throw new Error('Sharing requires native confirmation.');
  const destination=await ui.select('Share this conversation', ['Export locally','Secret GitHub gist','Radius organization','Cancel']);
  if(!destination || destination==='Cancel') return 'Share cancelled.';
  const directory=join(agentDir,'exports');
  await mkdir(directory,{recursive:true});
  const file=join(directory,`${pi.sessionId}-${randomUUID()}.html`);
  await pi.exportToHtml(file);
  if(destination==='Export locally') return `Session exported for sharing: [Open HTML](<${file}>).`;
  if(process.env.PI_OFFLINE) throw new Error(`Sharing requires online mode. Local export: ${file}`);
  const host=destination==='Secret GitHub gist'?'github.com':new URL(getRadiusGatewayUrl()).host;
  const body=serializeSessionBranch(pi.sessionManager,(parentId,timestamp)=>createShareTrailingEntries(pi,parentId,timestamp));
  ui.notify(`Review the conversation export before sharing: [Open HTML](<${file}>).`);
  if(!await ui.confirm(`Share with ${host}?`, `${destination}. This uploads this conversation, including messages, file contents and tool output. ${destination==='Secret GitHub gist'?'Anyone with its link can read a secret gist.':'Members of your Radius organization can read it.'}\n\nReview: ${file}`)) return `Share cancelled. Local export: ${file}`;
  signal?.throwIfAborted();
  if(destination==='Secret GitHub gist') {
    let stdout:string;
    try {({stdout}=await exec('gh',['gist','create','--public=false',file],{signal,timeout:120000,maxBuffer:1024*1024}));}
    catch {throw new Error(`GitHub sharing did not complete. Check gh authentication and connectivity. Local export: ${file}. Before retrying, check your gists for a possibly completed upload.`);}
    const url=stdout.trim();
    if(!/^https:\/\/gist\.github\.com\/[\w-]+\/[a-f\d]+$/i.test(url)) throw new Error(`GitHub returned an unexpected result. Check your gists. Local export: ${file}`);
    return `Shared as a secret gist: ${url}`;
  }
  const token=getAuthCredential(await pi.modelRuntime.getAuth('radius',{signal,minOAuthValidityMs:300000}));
  if(!token) throw new Error('Sign in with /login radius before sharing to Radius.');
  const url=new URL('/v1/artifacts',getRadiusGatewayUrl());
  url.searchParams.set('visibility','organization'); url.searchParams.set('title','Pi session');
  const uploadSignal = AbortSignal.any([AbortSignal.timeout(120000), ...(signal ? [signal] : [])]);
  const response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/x-ndjson'},body,signal:uploadSignal});
  const result=await response.json() as {artifact?:{canonical_url?:string}};
  if(!response.ok || !result.artifact?.canonical_url?.startsWith('https://')) throw new Error('Radius sharing did not complete. Check Radius artifacts before retrying.');
  return `Shared with your Radius organization: ${result.artifact.canonical_url}`;
}

export async function bugCommand(pi:AgentSession,ui:ExtensionUIContext|undefined,agentDir:string,argument:string,signal?:AbortSignal) {
  if(!ui) throw new Error('Bug reports require native forms.');
  const description=await ui.editor('Report a bug to pi developers · Earendil',argument);
  if(description===undefined) return 'Bug report cancelled.';
  const include=await ui.select('Include conversation data? Generating a summary sends this transcript to your current model provider.',['Diagnostics only','Include transcript','Generate a summary with the current model','Cancel']);
  if(!include || include==='Cancel') return 'Bug report cancelled.';
  const includeSession=include==='Include transcript';
  const summary=include==='Generate a summary with the current model' ? await pi.summarizeForBugReport({hint:description,signal:signal??new AbortController().signal}) : undefined;
  signal?.throwIfAborted();
  const extensions=pi.resourceLoader.getExtensions();
  const bundle={
    metadata:collectBugReportMetadata({hint:description,sessionId:pi.sessionId,cwd:pi.sessionManager.getCwd(),includeSession,includeSummary:summary!==undefined,messageCount:pi.messages.length,
      model:pi.model,modelRuntime:pi.modelRuntime,thinkingLevel:pi.thinkingLevel,extensions:extensions.extensions,extensionErrors:extensions.errors,
      globalSettings:pi.settingsManager.getGlobalSettings(),projectSettings:{}}),
    diagnostics:collectBugReportDiagnostics(pi.sessionManager),summary,
    sessionJsonl:includeSession?serializeSessionBranch(pi.sessionManager,(parentId,timestamp)=>createShareTrailingEntries(pi,parentId,timestamp)):undefined,
  };
  const directory=join(agentDir,'reports'); await mkdir(directory,{recursive:true});
  const file=join(directory,bugReportArchiveFileName(bundle.metadata.id));
  await writeBugReportArchive(bundle,file);
  const destination=await ui.select(`Report prepared: ${file}\nIncludes ${include.toLowerCase()}, environment and redacted provider/settings metadata.`,['Keep local ZIP','Upload to pi developers','Cancel']);
  if(destination!=='Upload to pi developers') return `Report saved locally: [Open ZIP](<${file}>).`;
  if(process.env.PI_OFFLINE) throw new Error(`Upload requires online mode. Local report: ${file}`);
  const host=new URL(getRadiusGatewayUrl()).host;
  if(!await ui.confirm(`Upload report to ${host}?`,`This sends the prepared report to the pi developers (Earendil).\n\n${file}\n\nConversation data: ${include.toLowerCase()}.`)) return `Upload cancelled. Local report: ${file}`;
  signal?.throwIfAborted();
  const token=getAuthCredential(await pi.modelRuntime.getAuth('radius',{signal,minOAuthValidityMs:300000}));
  const uploadSignal = AbortSignal.any([AbortSignal.timeout(120000), ...(signal ? [signal] : [])]);
  const result=await uploadBugReport(bundle,{token,signal:uploadSignal});
  pi.sessionManager.appendCustomEntry('pi.bug-report',{id:bundle.metadata.id,createdAt:bundle.metadata.createdAt,hint:description,sessionIncluded:includeSession,summaryIncluded:summary!==undefined,delivery:'upload',path:file});
  return `Bug report uploaded to pi developers. Report ID: ${result.id}. Local copy: ${file}`;
}
