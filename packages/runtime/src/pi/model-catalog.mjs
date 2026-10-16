// Pi owns provider filtering, credentials and the persisted model catalog.
// Refresh OpenRouter's per-key list only at an explicit native reload boundary.
export async function refreshOpenRouterCatalog(runtime, signal) {
  if (process.env.PI_OFFLINE !== undefined || !runtime.hasConfiguredAuth('openrouter')) return '';
  const timeout = AbortSignal.timeout(15_000);
  const result = await runtime.refresh({providers:['openrouter'], allowNetwork:true,
    signal:signal ? AbortSignal.any([signal, timeout]) : timeout});
  signal?.throwIfAborted();
  if (result.aborted || result.errors.size) {
    return 'OpenRouter model catalog could not be refreshed; using cached models.';
  }
  return 'OpenRouter model catalog refreshed.';
}
