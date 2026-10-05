import type {AgentContext} from "@agentclientprotocol/sdk";

export const NATIVE_UI_ACTION = "_eido/ui/action";

export async function nativeUiAction(client: AgentContext, sessionId: string, action: string, data: Record<string, unknown> = {}, signal?: AbortSignal) {
  const response = await client.request<{result: Record<string, unknown>}>(NATIVE_UI_ACTION,
    {sessionId, action, data}, {cancellationSignal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)])});
  return response.result;
}
