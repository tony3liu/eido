// Claim before MCP/extension loading; release after the existing disposal and
// child-process cleanup have settled. Failed cleanup retains ownership.
export async function patchSessionOwner(path, patch) {
  // Migrate the earlier insertion point, which overlapped host attachment.
  // Subsequent setup runs must leave exactly one owner wrapper and host attach.
  const original = await readFile(path, 'utf8');
  const oldBlock = '            if (releaseEidoOwner) {\n                const dispose = wrapper.dispose.bind(wrapper);\n                wrapper.dispose = async () => { await dispose(); await releaseEidoOwner(); };\n            }\n';
  const attached = '            pi[Symbol.for("eido.pi.host")]?.attach(wrapper);\n';
  let source = original.replaceAll(oldBlock, '');
  while (source.includes(attached + attached)) source = source.replaceAll(attached + attached, attached);
  if (source !== original) await writeFile(path, source);
  await patch(new URL('deps.js', path),
    '        createAgentSession: partial.createAgentSession ?? createAgentSession,',
    '        eidoClaimSession: partial.eidoClaimSession,\n        createAgentSession: partial.createAgentSession ?? createAgentSession,');
  await patch(path,
    '        const childRegistry = new ChildProcessRegistrySlot(this.deps);\n        try {\n            this.gate(opening);',
    '        const childRegistry = new ChildProcessRegistrySlot(this.deps);\n        let releaseEidoOwner;\n        try {\n            releaseEidoOwner = await this.deps.eidoClaimSession?.(id);\n            this.gate(opening);');
  await patch(path,
    '            await pi.bindExtensions({});',
    '            if (releaseEidoOwner) {\n                const disposeOwnedSession = wrapper.dispose.bind(wrapper);\n                wrapper.dispose = async () => { await disposeOwnedSession(); await releaseEidoOwner(); };\n            }\n            await pi.bindExtensions({});');
  await patch(path,
    '                    const rollback = new FailedOpenCleanup(pi, bridge, childRegistry, lifecycle, this.deps);',
    '                    const rollback = new FailedOpenCleanup(pi, bridge, childRegistry, lifecycle, this.deps);\n                    if (releaseEidoOwner) {\n                        const disposeFailedSession = rollback.dispose.bind(rollback);\n                        rollback.dispose = async () => { await disposeFailedSession(); await releaseEidoOwner(); };\n                    }');
  await patch(path,
    '            if (cleanupError) {\n                opening.cleanupError = cleanupError;\n                throw cleanupError;\n            }\n            throw error;',
    '            if (cleanupError) {\n                opening.cleanupError = cleanupError;\n                throw cleanupError;\n            }\n            await releaseEidoOwner?.();\n            throw error;');
}
import {readFile, writeFile} from 'node:fs/promises';
