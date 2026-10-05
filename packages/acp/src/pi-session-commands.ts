import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import {SessionManager, type AgentSession, type ExtensionUIContext} from "@earendil-works/pi-coding-agent";
import type {AgentContext} from "@agentclientprotocol/sdk";
import {nativeUiAction} from "./native-ui.ts";

/** A copied transcript retains evidence, but never claims ownership of live children. */
async function detachHistoricalAgents(path: string, parentSession: string | undefined) {
  const lines = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  for (const entry of lines) {
    if (entry.type === 'session') entry.parentSession = parentSession;
    if (entry.type !== 'custom') continue;
    if (entry.customType === 'eido.subagent.v1') {
      const data = entry.data;
      entry.customType = 'eido.notice.v1';
      entry.data = {text:`Historical agent: ${data.title || data.childSessionId}. Original session: ${data.childSessionId}.`};
    } else if (entry.customType === 'eido.agents.event.v1') {
      const update = entry.data?.update;
      const content = (update?.content ?? []).flatMap((item: {type?:string;content?:{type?:string;text?:string}}) =>
        item.type === 'content' && item.content?.type === 'text' ? [item.content.text] : []).join('\n');
      entry.customType = 'eido.notice.v1';
      entry.data = {text:`Historical delegation: ${update?.title ?? 'Agent'} (${update?.status ?? 'recorded'})${content ? `\n${content}` : ''}`};
    }
  }
  await writeFile(path, lines.map(line => JSON.stringify(line)).join('\n')+'\n', {mode:0o600});
}

function validateImport(source: string) {
  let entries: Record<string, unknown>[];
  try {entries = source.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));}
  catch {throw new Error('Import requires valid pi JSONL. A malformed record was found.');}
  const header = entries[0];
  if (!header || header.type !== 'session' || typeof header.id !== 'string' || typeof header.version !== 'number' || header.version < 1 || header.version > 3) {
    throw new Error('Import requires a supported pi session header.');
  }
  const seen = new Set<string>();
  for (const entry of entries.slice(1)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.type !== 'string' || entry.type === 'session') throw new Error('Import contains invalid session records.');
    // v1 journals acquire their tree IDs in pi's migration. Later journals
    // must already form an append-only tree, or branch traversal can loop.
    if (header.version >= 2) {
      if (typeof entry.id !== 'string' || !entry.id || seen.has(entry.id)) throw new Error('Import contains missing or duplicate entry IDs.');
      if (entry.parentId !== null && (typeof entry.parentId !== 'string' || !seen.has(entry.parentId))) throw new Error('Import contains an invalid parent reference.');
      seen.add(entry.id);
    }
    if (entry.type === 'message') {
      const message = entry.message as {role?:unknown;content?:unknown} | undefined;
      if (!message || typeof message.role !== 'string' || (typeof message.content !== 'string' && !Array.isArray(message.content))) throw new Error('Import contains an invalid message.');
    }
  }
}

export async function sessionCommand(pi: AgentSession, client: AgentContext, ui: ExtensionUIContext | undefined,
  name: string, argument: string, signal?: AbortSignal) {
  const manager = pi.sessionManager, directory = manager.getSessionDir(), cwd = manager.getCwd();
  const open = async (id: string, title?: string, draft?: string) => {
    signal?.throwIfAborted();
    await nativeUiAction(client, pi.sessionId, 'open_session', {id, title, draft}, signal);
  };
  if (name === 'new') {
    if (argument) throw new Error('Usage: /new (no arguments).');
    if ((await pi.extensionRunner.emit({type:'session_before_switch',reason:'new'}))?.cancel) return 'New task cancelled by extension.';
    await nativeUiAction(client, pi.sessionId, 'new_session', {}, signal);
    return 'Opening a new task.';
  }
  if (name === 'resume') {
    const candidates = await SessionManager.list(cwd, directory, undefined, signal);
    const roots = candidates.filter(item => !SessionManager.open(item.path, directory).getEntries().some(entry =>
      entry.type === 'custom' && entry.customType === 'eido.subagent.v1' && (entry.data as {kind?:string})?.kind === 'child'));
    const label = (item: typeof roots[number]) => `${item.name || item.firstMessage.slice(0,80) || 'Untitled'} · ${item.id}`;
    const selected = argument || await ui?.select('Resume task', roots.map(label));
    if (!selected) return 'Resume cancelled.';
    const target = roots.find(item => item.id === selected || label(item) === selected);
    if (!target) throw new Error('Task not found in this workspace. Use /resume to select one.');
    if (target.id === pi.sessionId) return 'This task is already open.';
    if ((await pi.extensionRunner.emit({type:'session_before_switch',reason:'resume',targetSessionFile:target.path}))?.cancel) return 'Resume cancelled by extension.';
    await open(target.id, target.name);
    return `Opening task ${target.name || target.id}.`;
  }
  let leaf = manager.getLeafId(), draft: string | undefined;
  if (name === 'clone' && argument) throw new Error('Usage: /clone (no arguments).');
  if (name === 'fork') {
    const users = manager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'user');
    const text = (entry: typeof users[number]) => entry.type !== 'message' || entry.message.role !== 'user' ? '' : typeof entry.message.content === 'string' ? entry.message.content :
      entry.message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
    const label = (entry: typeof users[number]) => `${entry.id} · ${text(entry).replace(/\s+/g,' ').slice(0,100)}`;
    if (!users.length) return 'No user messages to fork yet.';
    const selected = argument || await ui?.select('Fork before a user message', users.map(label));
    if (!selected) return 'Fork cancelled.';
    const target = users.find(entry => entry.id === selected || label(entry) === selected);
    if (!target) throw new Error('User message not found. Use /fork to select one.');
    if ((await pi.extensionRunner.emit({type:'session_before_fork',entryId:target.id,position:'before'}))?.cancel) return 'Fork cancelled by extension.';
    leaf = target.parentId; draft = text(target);
  } else if (name === 'clone') {
    if (!leaf) return 'Nothing to clone yet.';
    if ((await pi.extensionRunner.emit({type:'session_before_fork',entryId:leaf,position:'at'}))?.cancel) return 'Clone cancelled by extension.';
  }
  const requested = /^(["'])([\s\S]*)\1$/.exec(argument)?.[2] ?? argument;
  if (name === 'import' && !requested) throw new Error('Usage: /import <path.jsonl>.');
  if (name === 'import' && !await ui?.confirm('Import pi session?', `Open ${requested} as a new task in ${cwd}? The original file is preserved.`)) return 'Import cancelled.';
  signal?.throwIfAborted();
  await mkdir(directory, {recursive:true});
  const temporary = await mkdtemp(join(directory,'.session-copy-'));
  let createdPath: string | undefined, opened = false;
  try {
    const snapshot = join(temporary,'source.jsonl');
    if (name === 'import') {
      const sourcePath = resolve(cwd, requested);
      const info = await stat(sourcePath);
      if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('Import requires a JSONL file no larger than 32 MB.');
      const source = await readFile(sourcePath,'utf8');
      if (Buffer.byteLength(source) > 32 * 1024 * 1024) throw new Error('Import exceeds 32 MB.');
      validateImport(source);
      if ((await pi.extensionRunner.emit({type:'session_before_switch',reason:'resume',targetSessionFile:sourcePath}))?.cancel) return 'Import cancelled by extension.';
      await writeFile(snapshot,source,{mode:0o600});
      createdPath = SessionManager.forkFrom(snapshot,cwd,directory).getSessionFile();
    } else {
      pi.exportToJsonl(snapshot);
      if (leaf) {
        const copy = SessionManager.open(snapshot,directory);
        createdPath = copy.createBranchedSession(leaf);
      } else {
        const copy = SessionManager.create(cwd,directory);
        // An empty fork must still have a journal discoverable by session/load.
        copy.appendCustomEntry('eido.command.v1',{command:'/fork',output:'Forked before the first message.',status:'completed'});
        createdPath = copy.getSessionFile();
      }
    }
    signal?.throwIfAborted();
    if (!createdPath) throw new Error('pi did not create a session journal.');
    await detachHistoricalAgents(createdPath, name === 'import' ? resolve(cwd,requested) : manager.getSessionFile());
    const created = SessionManager.open(createdPath,directory);
    const id = created.getSessionId(), title = `${name === 'import' ? 'Imported' : name === 'fork' ? 'Fork' : 'Clone'} · ${pi.sessionName || 'Task'}`;
    created.appendSessionInfo(title);
    // Once navigation is sent, a timeout cannot prove that the client did not load it.
    // Retain the journal so a cancelled/failed UI request remains recoverable.
    signal?.throwIfAborted();
    opened = true;
    try {await open(id,title,draft);}
    catch {throw new Error(`Created task ${id}, but navigation was interrupted. Use /resume ${id} to open it.`);}
    return `Opening ${title} (${id}).`;
  } finally {
    if (createdPath && !opened) await rm(createdPath,{force:true});
    await rm(temporary,{recursive:true,force:true});
  }
}

export async function treeCommand(pi: AgentSession, ui: ExtensionUIContext | undefined, argument: string, signal?: AbortSignal) {
  const manager=pi.sessionManager;
  const depths=new Map<string,number>();
  const entries: ReturnType<typeof manager.getEntries> = [];
  const pending = manager.getTree().toReversed().map(node => ({node, depth:0}));
  while (pending.length) {
    const {node, depth} = pending.pop()!;
    entries.push(node.entry); depths.set(node.entry.id, depth);
    for (const child of node.children.toReversed()) pending.push({node:child, depth:depth+1});
  }
  if (!entries.length) return {output:'No session history yet.',changed:false};
  const label=(entry: typeof entries[number])=>{
    let detail: string = entry.type;
    if(entry.type==='message') {
      detail=entry.message.role;
      if('content' in entry.message) detail+=' · '+(typeof entry.message.content==='string' ? entry.message.content : entry.message.content.flatMap(c=>c.type==='text'?[c.text]:[]).join(' ')).replace(/\s+/g,' ').slice(0,100);
    }
    return `${'  '.repeat(Math.min(depths.get(entry.id) ?? 0, 8))}${entry.id}${entry.id===manager.getLeafId()?' (current)':''} · ${manager.getLabel(entry.id) || detail}`;
  };
  const selected=argument || await ui?.select('Session tree · choose a conversation point',entries.map(label));
  if(!selected) return {output:'Tree navigation cancelled.',changed:false};
  const entry=entries.find(e=>e.id===selected || label(e)===selected);
  if(!entry) throw new Error('Session point not found. Use /tree to select one.');
  if(entry.id===manager.getLeafId()) return {output:'Already at this session point.',changed:false};
  const choice=pi.settingsManager.getBranchSummarySkipPrompt() ? 'No summary' : await ui?.select('Summarize the branch before switching?', ['No summary','Summarize','Summarize with instructions']);
  if(!choice) return {output:'Tree navigation cancelled.',changed:false};
  const instructions=choice==='Summarize with instructions' ? await ui?.editor('Branch summary instructions') : undefined;
  if(choice==='Summarize with instructions' && instructions===undefined) return {output:'Tree navigation cancelled.',changed:false};
  signal?.throwIfAborted();
  const abort=()=>pi.abortBranchSummary();
  signal?.addEventListener('abort',abort,{once:true});
  try {
    const result=await pi.navigateTree(entry.id,{summarize:choice!=='No summary',customInstructions:instructions});
    if(result.cancelled || result.aborted) return {output:'Tree navigation cancelled.',changed:false};
    return {output:`Navigated to ${entry.id}. Code buffers and pending reviews are preserved.`,changed:true,draft:result.editorText};
  } finally {signal?.removeEventListener('abort',abort);}
}
