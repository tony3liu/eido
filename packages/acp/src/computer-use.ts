import {randomUUID} from 'node:crypto';
import type {AgentSession} from '@earendil-works/pi-coding-agent';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import type {McpClientHandle, McpSessionBinding} from '../adapter/src/mcp-bridge.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const inputTools = new Set(['click', 'double_click', 'right_click', 'drag', 'type_text', 'press_key', 'hotkey', 'set_value', 'scroll', 'invoke_menu', 'set_window_frame']);
const notice = (text: string) => ({type: 'text' as const, text});

export function computerVision(session: Pick<AgentSession, 'model' | 'settingsManager'> | undefined) {
  const model = session?.model;
  const blocked = session?.settingsManager.getBlockImages() === true;
  const enabled = !!model?.input.includes('image') && !blocked;
  const modelId = model ? `${model.provider}/${model.id}` : 'No model selected';
  const reason = !model ? 'Select a model before using visual controls.' : blocked
    ? 'Images are blocked in global pi settings.' : enabled
    ? 'The current pi model accepts images. Inspect the attached screenshots.'
    : 'The current pi model is declared text-only. Screenshots cannot reach this model; select a model with image input for visual controls.';
  return {enabled, modelId, reason, signature: `${modelId}:${enabled}`};
}

export function computerGuidance(session: AgentSession | undefined) {
  const vision = computerVision(session);
  return `\nEido Computer Use: ${vision.modelId}. ${vision.reason} This describes the current model, superseding earlier image-capability statements in conversation history. Use get_window_state with the exact pid/window_id. When AX omits application content, inspect the screenshot; never infer fields or recipients from a generic window title or menu bar. Before input, confirm the intended recipient/target and focused control from the current observation. Use its element_token, capture_id, or eido_observation ID. Each action returns a fresh observation: inspect it before the next action. Do not batch dependent inputs. An opened/activated window, successful key delivery, or correct clipboard text does not prove navigation, sending, or task completion. After sending, verify the intended recipient and visible message/result. If the target or result cannot be established, stop and report the missing evidence; do not paste or press Enter blindly or repeat an uncertain send. Eido owns and ends this task's desktop session after completion, failure or cancellation; it does not close the user's applications.`;
}

type Target = {pid: number; window_id: number} | {desktop: true};
type Observation = {id: string; target: Target; at: number; signature: string; visual: boolean; meaningfulAx: boolean; tokens: Set<string>; capture?: string};
const targetKey = (target: Target) => 'desktop' in target ? 'desktop' : `${target.pid}:${target.window_id}`;
function explicitTarget(args: RecordValue): Target | undefined {
  const target = record(args.target);
  if (target.kind === 'desktop' || args.scope === 'desktop') return {desktop: true};
  const pid = target.pid ?? args.pid, window = target.window_id ?? args.window_id;
  return Number.isInteger(pid) && Number.isInteger(window) ? {pid: pid as number, window_id: window as number} : undefined;
}

// A thin adapter around the existing Cua Driver connection. No driver or pi
// internals are changed. Both direct tools and Code Mode pass this boundary.
export function computerUse(handle: McpClientHandle, binding: McpSessionBinding, now = Date.now) {
  const rawCall = handle.callTool.bind(handle), rawList = handle.listTools.bind(handle), rawClose = handle.close.bind(handle);
  const observations = new Map<string, Observation>();
  const supportsSession = new Set<string>();
  let label: string | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let closing = false;
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work); queue = next.catch(() => {}); return next;
  };
  const failure = (message: string): CallToolResult => ({isError: true, content: [notice(message)]});
  const withSession = (name: string, args: RecordValue) => {
    if (!supportsSession.has(name)) return args;
    label ??= `eido-${binding.sessionId}-${randomUUID()}`;
    return {...args, session: label};
  };
  const end = async () => {
    observations.clear();
    if (!label) return;
    const result = await rawCall('end_session', {session: label}, AbortSignal.timeout(5000), 5000);
    if (result.isError) throw new Error('Computer Use session cleanup failed. The session may still be active.');
    label = undefined;
  };
  function remember(result: CallToolResult, target: Target) {
    const vision = computerVision(binding.getPi()), data = record(result.structuredContent);
    if (!result.isError && !('desktop' in target) && (data.pid !== target.pid || data.window_id !== target.window_id)) {
      result = {...result, isError: true, content: [...result.content, notice('The observation did not confirm the requested pid/window_id. Do not act on this result.')]};
    }
    const elements = Array.isArray(data.elements) ? data.elements.map(record) : [];
    // Menus and window chrome do not establish chat content or input focus.
    const meaningfulAx = elements.some(e => !String(e.role).startsWith('AXMenu') && e.role !== 'AXWindow'
      && !/^AX(Close|Zoom|Minimize)Button$/.test(String(e.subrole)) && e.label !== data.window_title
      && Number(e.depth) > 0 && !!(e.label || e.value) && !e.identifier?.toString().startsWith('_'));
    const visual = vision.enabled && data.screenshot_frame_valid !== false && result.content.some(c => c.type === 'image');
    const obs: Observation = {id: randomUUID(), target, at: now(), signature: vision.signature, visual, meaningfulAx,
      tokens: new Set(elements.map(e => e.element_token).filter((v): v is string => typeof v === 'string')),
      capture: typeof data.capture_id === 'string' ? data.capture_id : undefined};
    if (!result.isError) observations.set(targetKey(target), obs);
    else observations.delete(targetKey(target));
    return {obs, result: {...result, content: [...result.content, notice(`Eido observation ${obs.id}. ${vision.modelId}: ${vision.reason} ${visual || meaningfulAx ? 'Confirm the intended target and control from this observation before input. Verify the visible outcome after input.' : 'Application content is not observable. Do not guess coordinates, focus or recipients; input is blocked until a usable observation is available.'}`)]}};
  }
  async function observe(target: Target, signal: AbortSignal, timeout: number, progress?: (p: unknown) => void, requested: RecordValue = {}) {
    observations.delete(targetKey(target));
    const vision = computerVision(binding.getPi());
    const name = 'desktop' in target ? 'get_desktop_state' : 'get_window_state';
    const args = 'desktop' in target ? {...requested} : {...requested, ...target, include_screenshot: vision.enabled && requested.include_screenshot !== false};
    const result = await rawCall(name, withSession(name, args), signal, timeout, progress);
    let observed = remember(result, target);
    if (!result.isError && !('desktop' in target) && vision.enabled && !observed.obs.visual && !observed.obs.meaningfulAx) {
      // A text-only AX request is insufficient for Qt/canvas UIs. Capture once,
      // without the caller's file-only output or AX filters suppressing pixels.
      const image = await rawCall(name, withSession(name, {...target, include_screenshot: true, include_accessibility_tree: true}), signal, timeout, progress);
      observed = remember(image, target);
    }
    return observed.result;
  }
  handle.listTools = async (...args) => {
    const listed = await rawList(...args);
    return {...listed, tools: listed.tools.map(tool => {
      if (tool.inputSchema.properties?.session) supportsSession.add(tool.name);
      if (!inputTools.has(tool.name)) return tool;
      return {...tool, description: `${tool.description ?? ''}\nEido: confirm the target/recipient and control in a fresh observation. Cite its element_token, capture_id or eido_observation. Read the returned post-action state before continuing; input delivery does not prove task success.`,
        inputSchema: {...tool.inputSchema, properties: {...tool.inputSchema.properties,
          eido_observation: {type: 'string', description: 'ID from the latest Eido observation of this exact target. Required unless a current element_token or capture_id identifies that observation.'}}}};
    })};
  };
  handle.callTool = (name, value, signal, timeout, progress) => serial(async () => {
    signal.throwIfAborted();
    if (closing) return failure('Computer Use connection is closing.');
    const args = {...record(value)};
    if (name === 'end_session') {await end(); return {content: [notice('The Eido-owned desktop session has ended.')]};}
    if (name === 'get_window_state' || name === 'get_desktop_state') {
      const target = name === 'get_desktop_state' ? {desktop: true as const} : explicitTarget(args);
      if (!target) return failure('Observe an exact pid and window_id from list_windows.');
      return observe(target, signal, timeout, progress, args);
    }
    const input = inputTools.has(name);
    let target = explicitTarget(args);
    if (input) {
      const candidates = [...observations.values()].filter(o => (!target || targetKey(o.target) === targetKey(target))
        && (args.eido_observation === o.id || typeof args.element_token === 'string' && o.tokens.has(args.element_token)
          || typeof args.capture_id === 'string' && args.capture_id === o.capture));
      const obs = candidates.length === 1 ? candidates[0] : undefined;
      if (!obs || now() - obs.at > 60_000 || obs.signature !== computerVision(binding.getPi()).signature) {
        return failure('Input was not sent. Get a fresh observation of the exact target, confirm the recipient/control, and cite its eido_observation, element_token or capture_id.');
      }
      const pixelInput = args.x !== undefined || args.y !== undefined || args.from_x !== undefined;
      if (!obs.visual && (pixelInput || !obs.meaningfulAx)) {
        return failure(`Input was not sent: the target is not visually observable${pixelInput ? ' for coordinate input' : ' and AX does not expose application content'}. ${computerVision(binding.getPi()).reason}`);
      }
      target = obs.target;
      if (!('desktop' in target)) {args.pid = target.pid; args.window_id = target.window_id;}
      if (name === 'click' && pixelInput && obs.capture) args.capture_id = obs.capture;
      delete args.eido_observation;
      observations.clear(); // A single observation never authorizes a batch of inputs.
    }
    try {
      const result = await rawCall(name, withSession(name, args), signal, timeout, progress);
      if (result.isError) {
        observations.clear();
        return {...result, content: [...result.content, notice('Stop and re-observe before another input. This action may have partially executed; do not repeat an uncertain send.')]};
      }
      if (target && (input || name === 'bring_to_front')) {
        const after = await observe(target, signal, timeout, progress);
        const current = observations.get(targetKey(target));
        return {...result, isError: after.isError === true || !current || !(current.visual || current.meaningfulAx), content: [...result.content,
          notice('Post-action observation follows. Check the target and actual result; successful input delivery alone is not success.'),
          ...after.content, ...(after.structuredContent ? [notice(JSON.stringify(after.structuredContent))] : [])]};
      }
      return result;
    } catch (error) {
      observations.clear();
      if (signal.aborted) throw error;
      return failure('Computer Use could not verify the operation. It may have executed. Re-observe the exact target before deciding whether to continue; do not repeat an uncertain send.');
    }
  });
  handle.close = () => serial(async () => {closing = true; try {await end();} finally {await rawClose();}});
  return {handle, finishTurn: () => serial(end)};
}
