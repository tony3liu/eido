import {readFile} from 'node:fs/promises';

export async function patchPiTools(directory, patch) {
  const agent = new URL('dist/agent.js', directory);
  const pi = new URL('../../@earendil-works/pi-coding-agent/dist/core/agent-session.js', directory);
  await patch(agent,
    'import { bridgeMcpServers, } from "./mcp-bridge.js";',
    'import { bridgeMcpServers, } from "./mcp-bridge.js";\nimport { createCodemodeExtension, createToolSearchExtension } from "@earendil-works/pi-coding-agent";');
  await patch(agent,
    'extensionFactories: [bridge.inlineExtension, controlExtension],',
    'extensionFactories: [bridge.inlineExtension, controlExtension,\n                    { name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },\n                    { name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true }],');
  // Nested calls must use the same composed ACP permission/role hooks as model
  // calls. Preserve parentToolCallId for pi extensions without invoking twice.
  await patch(pi, 'this.agent.beforeToolCall = (context) => this._beforeToolCall(context);',
    'this.agent.beforeToolCall = (context) => this._beforeToolCall(context, context.parentToolCallId);');
  await patch(pi, 'this.agent.afterToolCall = (context) => this._afterToolCall(context);',
    'this.agent.afterToolCall = (context) => this._afterToolCall(context, context.parentToolCallId);');
  await patch(pi, 'beforeToolCall: (context) => this._beforeToolCall(context, parentId),',
    'beforeToolCall: (context) => this.agent.beforeToolCall?.({ ...context, parentToolCallId: parentId }, signal),');
  await patch(pi, 'afterToolCall: (context) => this._afterToolCall(context, parentId),',
    'afterToolCall: (context) => this.agent.afterToolCall?.({ ...context, parentToolCallId: parentId }, signal),');
  await patch(pi, 'return exposure === "codemode" || exposure === "deferred" || (exposure === "direct" && active.has(tool.name));',
    'return (this[Symbol.for("eido.pi.tools")]?.allows(tool.name) ?? true) && (exposure === "codemode" || exposure === "deferred" || (exposure === "direct" && active.has(tool.name)));');
  await patch(pi, 'return tool && this._getToolExposure(name) !== "hidden" ? [tool] : [];',
    'return tool && this._getToolExposure(name) !== "hidden" && (this[Symbol.for("eido.pi.tools")]?.allows(name) ?? true) ? [tool] : [];');
  const originalLoadout = '        this._setActiveTools([...new Set(nextActiveToolNames)]);';
  const previousLoadout = originalLoadout + '\n        this[Symbol.for("eido.pi.tools")]?.changed();';
  // Resolve the role against the new registry before filtering pi's requested
  // loadout; filtering first would lose newly registered tools forever.
  await patch(pi, (await readFile(pi, 'utf8')).includes(previousLoadout) ? previousLoadout : originalLoadout,
    '        const eidoPolicy = this[Symbol.for("eido.pi.tools")];\n        if (eidoPolicy) eidoPolicy.registered([...new Set(nextActiveToolNames)]);\n        else this._setActiveTools([...new Set(nextActiveToolNames)]);');
  // pi 1.0.2 drops configured defaults whose plugin registers later. Use its
  // existing pending loadout, including its explicit-deactivation semantics.
  await patch(pi, '        // Pending tools that are registered now become active.',
    '        for (const name of nextActiveToolNames) {\n            if (!this._toolRegistry.has(name) && this._isAllowedTool(name)) this._pendingToolNames.add(name);\n        }\n        // Pending tools that are registered now become active.');
  await patch(pi, '        if (previous.some((name) => !active.has(name)))',
    '        if (previous.some((name) => !active.has(name) && (this[Symbol.for("eido.pi.tools")]?.allows(name) ?? true)))');
  await patch(new URL('dist/session.js', directory),
    '                content: failedResult.content,\n                ...(failedResult.details',
    '                content: failedResult.content,\n                ...(failedResult.structuredContent === undefined ? {} : { structuredContent: failedResult.structuredContent }),\n                ...(failedResult.details');
}
