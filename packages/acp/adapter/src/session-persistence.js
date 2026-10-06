import {closeSync, existsSync, fsyncSync, linkSync, openSync, unlinkSync, writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

/** Eido retains command-only tasks. Export through pi's public journal API once,
 * then let its normal append-only storage own all later writes. No fake model
 * messages, private fields, or changes to the upstream persistence policy.
 */
export function persistSession(manager) {
  const path=manager.getSessionFile();
  if(!manager.isPersisted() || !path || existsSync(path))return;
  const header=manager.getHeader();
  if(!header)throw new Error('Cannot persist a task without a pi session header.');
  const leaf=manager.getLeafId();
  const temporary=`${path}.${randomUUID()}.tmp`;
  const fd=openSync(temporary,'wx',0o600);
  try {
    writeFileSync(fd,[header,...manager.getEntries()].map(entry=>JSON.stringify(entry)).join('\n')+'\n');
    fsyncSync(fd);
  } catch(error) {unlinkSync(temporary);throw error;} finally {closeSync(fd);}
  try {linkSync(temporary,path);} finally {unlinkSync(temporary);}
  manager.setSessionFile(path);
  if(leaf)manager.branch(leaf);else manager.resetLeaf();
}

export function appendEidoEntry(manager,type,data) {
  const id=manager.appendCustomEntry(type,data);
  persistSession(manager);
  return id;
}
