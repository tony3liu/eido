import {randomUUID} from 'node:crypto';
import type {AgentSession} from '@earendil-works/pi-coding-agent';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import type {McpClientHandle, McpSessionBinding} from '../adapter/src/mcp-bridge.js';
import {withMcpModelContent, getMcpModelContent} from '../adapter/src/mcp-bridge.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const inputTools = new Set(['click', 'double_click', 'right_click', 'drag', 'type_text', 'type_text_chars', 'press_key', 'hotkey', 'set_value', 'scroll', 'invoke_menu', 'set_window_frame']);
const notice = (text: string) => ({type: 'text' as const, text});
const toolDescriptions: Record<string,string> = {
  get_window_state: 'Observe one exact pid/window_id from list_windows. Returns live AX element_token handles, current values, target/route facts and an optional screenshot. Use query to narrow AX content; missing rows in a bounded or incomplete walk do not prove absence. Screenshot coordinates address the returned PNG. Prefer semantic handles for native controls; weak AX requires a usable screenshot and an image-capable model. Each input already returns a fresh post-action observation. Re-observe after an error or before using old handles.',
  set_value: 'Set the whole value of an exact observed native AX control. Use type_text for insertion at the current selection. Web AXValue readback does not establish renderer/DOM acceptance; verify actual content in the returned observation. A successful mutation is not proof of sending or task completion. Never repeat an uncertain send.',
  type_text: 'Insert at the current selection using the observed exact element_token, or x/y to focus an observed pixel control. Native controls use exact AX focus and selected-text insertion. Keyboard fallback stays subject to same-process window ambiguity checks. Web AX readback is not renderer proof; inspect the returned screenshot or use browser DOM tools. Background is the default; foreground briefly activates the target and can disturb user work. delay_ms paces synthesized characters. Cancellation stops the unposted suffix; re-observe partial results before continuing.',
  click: 'Act on an observed exact element_token or x/y in the returned screenshot PNG. action:focus verifies native AX focus without raising the window; press invokes AXPress. Background coordinates require a valid capture. Use delivery_mode:foreground only as an explicit last resort. Inspect the fresh post-action observation; successful event delivery alone is not proof of its effect.',
};
const propertyDescriptions: Record<string,string> = {
  session:'Eido owns this label and overrides caller values.',
  element_token:'Live handle from the latest exact-window observation; becomes stale after a new snapshot.',
  capture_id:'Immutable screenshot handle from the latest observation; required for exact pixel binding.',
  delivery_mode:'background preserves the user foreground; foreground temporarily activates the exact target.',
  include_accessibility_tree:'Return AX elements and live handles. Default true.',
  include_screenshot:'Return an image. Default follows the current pi model. Set false for semantic-only observations.',
  max_elements:'Maximum AX nodes walked. A limited walk can omit needed controls.',
  max_depth:'Maximum AX walk depth. A limited walk can omit needed controls.',
};

// Preserve every application row and its live handles; omit default menu-bar
// subtrees and repeated markdown only in the model transcript. Explicit AX
// queries retain menu matches. Full structured evidence stays available to UI
// and Code Mode, including truncation, route refusals and exact-target facts.
export function compactComputerObservation(data: RecordValue, includeMenus = false) {
  const {tree_markdown, _note, elements, ...metadata} = data;
  let menuDepth: number | undefined;
  const rows = (Array.isArray(elements) ? elements : []).map(record).filter(element => {
    const depth = Number(element.depth);
    if (menuDepth !== undefined && depth <= menuDepth) menuDepth = undefined;
    if (String(element.role).startsWith('AXMenu')) menuDepth ??= depth;
    return includeMenus || menuDepth === undefined;
  });
  return {...metadata, elements: rows, model_projection: {omitted_menu_rows: (Array.isArray(elements) ? elements.length : 0) - rows.length,
    detail: 'Application rows retain their original indices and tokens. Use an explicit query to inspect menus. The AX walk may be incomplete; missing rows are not proof of absence.'}};
}

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

// A thin adapter around the existing Cua Driver connection. Native driver
// adaptations live in native/cua; pi stays unmodified. Direct tools and Code
// Mode share this boundary.
export function computerUse(handle: McpClientHandle, binding: McpSessionBinding, now = Date.now) {
  const rawCall = handle.callTool.bind(handle), rawList = handle.listTools.bind(handle), rawClose = handle.close.bind(handle);
  const observations = new Map<string, Observation>();
  const supportsSession = new Set<string>();
  let label: string | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let closing = false;
  let epoch = 0;
  const active = new Set<AbortController>();
  const stopInput = () => {epoch++; observations.clear(); for (const controller of active) controller.abort(new Error('The Computer Use turn has ended.'));};
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
    if (!label) return {content: [notice('The Eido-owned desktop session has already ended.')], structuredContent: {status: 'already_ended'}};
    const signal = AbortSignal.timeout(5000);
    let result = await rawCall('end_session', {session: label}, signal, 5000);
    // Core acknowledges termination before admitted native work has unwound.
    // Poll that lifecycle status within one shared deadline; do not report
    // pending cleanup as complete or wait for an uncancelled text tail.
    while (result.isError && record(result.structuredContent).code === 'session_cleanup_pending') {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const done = () => {signal.removeEventListener('abort', aborted); resolve();};
        const timer = setTimeout(done, 25);
        const aborted = () => {clearTimeout(timer); reject(signal.reason);};
        signal.addEventListener('abort', aborted, {once:true});
      });
      result = await rawCall('end_session', {session: label}, signal, 5000);
    }
    if (result.isError) throw new Error(`Computer Use session cleanup failed. The session may still be active. ${result.content.filter(c => c.type === 'text').map(c => c.text).join(' ').slice(0,1000)}`);
    label = undefined;
    return result;
  };
  function remember(result: CallToolResult, target: Target, includeMenus = false) {
    const vision = computerVision(binding.getPi()), data = record(result.structuredContent);
    const exact = record(record(data.background_input).exact_window);
    if (!result.isError && !('desktop' in target) && (data.pid !== target.pid || data.window_id !== target.window_id
      || typeof exact.status === 'string' && exact.status !== 'matched')) {
      result = {...result, isError: true, content: [...result.content, notice('The observation did not confirm the requested pid/window_id. Do not act on this result.')]};
    }
    const elements = Array.isArray(data.elements) ? data.elements.map(record) : [];
    // Menus and window chrome do not establish chat content or input focus.
    // A menu can also contain AXTextField (macOS Help search), so exclude its
    // descendants as well as the menu nodes themselves.
    let menuDepth: number | undefined;
    const meaningfulAx = elements.some(e => {
      const depth = Number(e.depth);
      if (menuDepth !== undefined && depth <= menuDepth) menuDepth = undefined;
      if (String(e.role).startsWith('AXMenu')) menuDepth ??= depth;
      return menuDepth === undefined && e.role !== 'AXWindow'
      && !/^AX(Close|Zoom|Minimize)Button$/.test(String(e.subrole)) && e.label !== data.window_title
      && depth > 0 && !!(e.label || e.value) && !e.identifier?.toString().startsWith('_');
    });
    const visual = vision.enabled && data.screenshot_frame_valid !== false && result.content.some(c => c.type === 'image');
    const obs: Observation = {id: randomUUID(), target, at: now(), signature: vision.signature, visual, meaningfulAx,
      tokens: new Set(elements.map(e => e.element_token).filter((v): v is string => typeof v === 'string')),
      capture: typeof data.capture_id === 'string' ? data.capture_id : undefined};
    if (!result.isError) observations.set(targetKey(target), obs);
    else observations.delete(targetKey(target));
    const guidance = notice(`Eido observation ${obs.id}. ${visual || meaningfulAx ? 'Confirm the exact target/control and verify the outcome after input.' : 'Application content is not observable. Do not guess coordinates, focus or recipients; input is blocked until a usable observation is available.'}`);
    const full: CallToolResult = {...result, structuredContent: {...data, eido_observation: obs.id}, content: [...result.content, guidance]};
    return {obs, result: result.isError ? full : withMcpModelContent(full, [notice(JSON.stringify(compactComputerObservation(full.structuredContent!, includeMenus))),
      ...result.content.filter(c => c.type !== 'text'), guidance])};
  }
  async function observe(target: Target, signal: AbortSignal, timeout: number, progress?: (p: unknown) => void, requested: RecordValue = {}) {
    observations.delete(targetKey(target));
    const vision = computerVision(binding.getPi());
    const name = 'desktop' in target ? 'get_desktop_state' : 'get_window_state';
    const args = 'desktop' in target ? {...requested} : {...requested, ...target, include_screenshot: vision.enabled && requested.include_screenshot !== false};
    const result = await rawCall(name, withSession(name, args), signal, timeout, progress);
    let observed = remember(result, target, typeof requested.query === 'string' && !!requested.query.trim());
    if (!observed.result.isError && !('desktop' in target) && vision.enabled && !observed.obs.visual && !observed.obs.meaningfulAx) {
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
      if (toolDescriptions[tool.name]) tool = {...tool, description:toolDescriptions[tool.name], inputSchema:{...tool.inputSchema,
        properties:Object.fromEntries(Object.entries(tool.inputSchema.properties ?? {}).map(([key,value])=>[key,
          propertyDescriptions[key] ? {...record(value),description:propertyDescriptions[key]} : value]))}};
      if (!inputTools.has(tool.name)) return tool;
      return {...tool, description: `${tool.description ?? ''}\nEido: confirm the target/recipient and control in a fresh observation. Cite its element_token, capture_id or eido_observation. Read the returned post-action state before continuing; input delivery does not prove task success.`,
        inputSchema: {...tool.inputSchema, properties: {...tool.inputSchema.properties,
          eido_observation: {type: 'string', description: 'ID from the latest Eido observation of this exact target. Required unless a current element_token or capture_id identifies that observation.'}}}};
    })};
  };
  handle.callTool = (name, value, outerSignal, timeout, progress) => {
    const admittedEpoch = epoch;
    return serial(async () => {
    const controller = new AbortController();
    const signal = AbortSignal.any([outerSignal, controller.signal]);
    signal.throwIfAborted();
    if (admittedEpoch !== epoch) return failure('Input was not sent. The Computer Use turn has ended.');
    if (closing) return failure('Computer Use connection is closing.');
    active.add(controller);
    try {
      const args = {...record(value)};
      if (name === 'end_session') return end();
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
        if (name === 'click' && pixelInput && obs.capture && args.from_zoom !== true && !args.debug_image_out) args.capture_id = obs.capture;
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
          const full: CallToolResult = {...result, structuredContent: {...record(result.structuredContent), eido_post_observation: after.structuredContent},
            isError: after.isError === true || !current || !(current.visual || current.meaningfulAx), content: [...result.content,
            notice('Post-action observation follows. Check the target and actual result; successful input delivery alone is not success.'),
            ...after.content, ...(after.structuredContent ? [notice(JSON.stringify(after.structuredContent))] : [])]};
          return withMcpModelContent(full, [...result.content, ...(result.structuredContent ? [notice(JSON.stringify(result.structuredContent))] : []),
            notice('Post-action observation follows. Verify the actual outcome.'), ...(getMcpModelContent(after) ?? [...after.content,
              ...(after.structuredContent ? [notice(JSON.stringify(after.structuredContent))] : [])])]);
        }
        return result;
      } catch (error) {
        observations.clear();
        if (signal.aborted) throw error;
        return failure('Computer Use could not verify the operation. It may have executed. Re-observe the exact target before deciding whether to continue; do not repeat an uncertain send.');
      }
    } finally {active.delete(controller);}
  });};
  handle.close = () => {closing = true; stopInput(); return serial(async () => {try {await end();} finally {await rawClose();}});};
  return {handle, finishTurn: () => {stopInput(); return serial(end);}};
}
