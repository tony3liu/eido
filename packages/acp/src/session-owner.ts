import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {RequestError} from '@agentclientprotocol/sdk';

const require = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
const lockfile = require('proper-lockfile') as {
  lock(path: string, options: object): Promise<() => Promise<void>>;
};

/** A session's journal, deliveries and tools have exactly one live ACP owner.
 * Session ownership has no time expiry: a suspended process is still an owner.
 * The short filesystem mutex only serializes claim/release, never a model turn.
 */
export function sessionOwners(directory: string) {
  const root = join(directory, 'session-owners');
  const token = randomUUID();
  return async (sessionId: string) => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const path = join(root, `${createHash('sha256').update(sessionId).digest('hex')}.json`);
    async function locked<T>(fn: () => Promise<T>) {
      const release = await lockfile.lock(path, { realpath: false, stale: 10_000,
        retries: { retries: 20, minTimeout: 25, maxTimeout: 100, factor: 1.5 } });
      try { return await fn(); } finally { await release(); }
    }
    async function owner(): Promise<{pid: number; token: string} | undefined> {
      try { return JSON.parse(await readFile(path, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    }
    await locked(async () => {
      const previous = await owner();
      if (previous) {
        if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error('Invalid task ownership record. The task was not opened.');
        let alive = true;
        try { process.kill(previous.pid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
        if (alive) throw new RequestError(-32602, 'This task is already open in another Eido window or process. Continue there, or close the task there before reopening it here.');
      }
      const temp = `${path}.${token}.tmp`;
      try {
        await writeFile(temp, JSON.stringify({pid: process.pid, token}), {mode: 0o600});
        await rename(temp, path);
      } finally { await rm(temp, {force: true}); }
    });
    let released = false;
    return async () => {
      if (released) return;
      await locked(async () => {
        const current = await owner();
        if (current?.token === token && current.pid === process.pid) await rm(path, {force: true});
      });
      released = true;
    };
  };
}
