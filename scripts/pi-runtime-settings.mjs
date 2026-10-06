// Native controls edit only these audited pi settings. Other pi/plugin fields
// remain in the same global file and are preserved by the locked merge.
const fields = [
  ['images.autoResize','Images','Resize large images','boolean',m=>m.getImageAutoResize()],
  ['images.blockImages','Images','Block images in model requests','boolean',m=>m.getBlockImages()],
  ['compaction.enabled','Context','Automatic compaction','boolean',m=>m.getCompactionEnabled()],
  ['compaction.reserveTokens','Context','Reserved tokens','number',m=>m.getCompactionReserveTokens()],
  ['compaction.keepRecentTokens','Context','Recent tokens to keep','number',m=>m.getCompactionKeepRecentTokens()],
  ['branchSummary.reserveTokens','Context','Branch summary reserved tokens','number',m=>m.getBranchSummarySettings().reserveTokens],
  ['branchSummary.skipPrompt','Context','Switch branches without a summary prompt','boolean',m=>m.getBranchSummarySkipPrompt()],
  ['retry.enabled','Recovery','Retry failed turns','boolean',m=>m.getRetryEnabled()],
  ['retry.maxRetries','Recovery','Maximum turn retries','number',m=>m.getRetrySettings().maxRetries],
  ['retry.baseDelayMs','Recovery','Initial retry delay (ms)','number',m=>m.getRetrySettings().baseDelayMs],
  ['retry.maxAgentDelayMs','Recovery','Maximum retry delay (ms)','number',m=>m.getRetrySettings().maxAgentDelayMs],
  ['transport','Requests','Transport',['auto','sse','websocket'],m=>m.getTransport()],
  ['httpIdleTimeoutMs','Requests','HTTP idle timeout (ms; 0 disables)','number',m=>m.getHttpIdleTimeoutMs()],
  ['websocketConnectTimeoutMs','Requests','WebSocket connection timeout (ms)','number',m=>m.getWebSocketConnectTimeoutMs()],
  ['retry.provider.timeoutMs','Requests','Provider request timeout (ms)','number',m=>m.getProviderRetrySettings().timeoutMs],
  ['retry.provider.maxRetries','Requests','Provider request retries','number',m=>m.getProviderRetrySettings().maxRetries],
  ['retry.provider.maxRetryDelayMs','Requests','Provider retry delay limit (ms)','number',m=>m.getProviderRetrySettings().maxRetryDelayMs],
  ['cacheWarming','Requests','Cache warming',['off','streaming','idle'],m=>m.getCacheWarmingMode()],
  ...['minimal','low','medium','high'].map(level=>[`thinkingBudgets.${level}`,'Thinking Budgets',`${level[0].toUpperCase()}${level.slice(1)} (tokens)`,'number',m=>m.getThinkingBudgets()?.[level]]),
  ['codemode.mode','Tools','Code mode',['on','only'],m=>m.getSettings().codemode?.mode ?? 'on'],
  ['codemode.inlineBudget','Tools','Code mode inline budget (tokens)','number',m=>m.getSettings().codemode?.inlineBudget ?? 3000],
  ['enableSkillCommands','Tools','Skill slash commands','boolean',m=>m.getEnableSkillCommands()],
];
const get = (value,path) => path.split('.').reduce((v,key)=>v?.[key],value);
export class PiRuntimeSettingsError extends Error {}
export function runtimeSettings(manager) {
  const raw = manager.getGlobalSettings();
  return fields.map(([path,group,label,kind,effective]) => ({path,group,label,
    kind:Array.isArray(kind)?'choice':kind, choices:Array.isArray(kind)?kind:undefined,
    value:get(raw,path) ?? null, effective:effective(manager) ?? null}));
}
export function mergeRuntimeSettings(current, changes, expected) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)
    || !expected || typeof expected !== 'object' || Array.isArray(expected)) throw new PiRuntimeSettingsError('Invalid runtime settings request.');
  for (const [path,value] of Object.entries(changes)) {
    const field = fields.find(field=>field[0]===path);
    if (!field) throw new PiRuntimeSettingsError('Unknown runtime setting. Reload the page and try again.');
    const kind = field[3];
    if (value !== null && (kind==='boolean' ? typeof value!=='boolean' : kind==='number'
      ? !Number.isSafeInteger(value) || value<0 || value>2_147_483_647 : !kind.includes(value))) {
      throw new PiRuntimeSettingsError(`Invalid value for ${field[2]}. Use a listed choice or a non-negative integer.`);
    }
    if (!Object.hasOwn(expected,path) || JSON.stringify(get(current,path) ?? null)!==JSON.stringify(expected[path])) {
      throw new PiRuntimeSettingsError(`${field[2]} changed while this page was open. Reload before saving.`);
    }
  }
  const result = structuredClone(current);
  for (const [path,value] of Object.entries(changes)) {
    if (value===null && get(result,path)===undefined) continue;
    const keys = path.split('.');
    let target = result;
    const parents = [];
    for (const key of keys.slice(0,-1)) {
      if (target[key] !== undefined && (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key]))) {
        throw new PiRuntimeSettingsError('A runtime settings section has an invalid format. Repair settings.json before saving.');
      }
      parents.push([target,key]);
      target = target[key] ??= {};
    }
    if (value===null) delete target[keys.at(-1)]; else target[keys.at(-1)]=value;
    if (value===null) for (const [parent,key] of parents.reverse()) {
      if (Object.keys(parent[key]).length===0) delete parent[key]; else break;
    }
  }
  return result;
}
