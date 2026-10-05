import { methods, type AgentContext, type ElicitationPropertySchema, type SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentSession, ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";

/** Use the native ACP form surface for pi's dialog API. */
export function createPiUI(pi: AgentSession, client: AgentContext, turnSignal: () => AbortSignal | undefined, emit: (update: SessionUpdate) => void): ExtensionUIContext {
  const request = async (title: string, property: ElicitationPropertySchema | undefined, opts?: ExtensionUIDialogOptions) => {
    const signals = [turnSignal(), opts?.signal].filter((signal): signal is AbortSignal => !!signal);
    const timeout = new AbortController();
    const timer = opts?.timeout === undefined ? undefined : setTimeout(() => timeout.abort(), opts.timeout);
    signals.push(timeout.signal);
    const signal = AbortSignal.any(signals);
    try {
      if (signal.aborted) return undefined;
      const response = await client.request(methods.client.elicitation.create, {
        sessionId: pi.sessionId,
        mode: "form",
        message: title,
        requestedSchema: {type: "object", properties: property ? {value: property} : {}, required: property ? ["value"] : []},
      }, {cancellationSignal: signal});
      if (signal.aborted || response.action !== "accept") return undefined;
      const content = "content" in response && typeof response.content === "object" && response.content !== null ? response.content as Record<string, unknown> : {};
      return property ? content.value : true;
    } catch (error) {
      if (signal.aborted) return undefined;
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  };
  const notice = (text: string) => {
    // Display-only notices are persisted as custom data, outside model context.
    pi.sessionManager.appendCustomEntry("eido.notice.v1", {text});
    emit({
      sessionUpdate: "agent_message_chunk", content: {type: "text", text: `${text}\n\n`},
    });
  };
  return {
    ...pi.extensionRunner.createContext().ui,
    async select(title, options, opts) {
      if (!options.length) return undefined;
      const value = await request(title, {type: "string", title: "Choose an option", enum: options}, opts);
      return typeof value === "string" && options.includes(value) ? value : undefined;
    },
    async confirm(title, message, opts) { return await request(`${title}\n\n${message}`, undefined, opts) === true; },
    async input(title, placeholder, opts) {
      const value = await request(title, {type: "string", title: "Value", description: placeholder}, opts);
      return typeof value === "string" ? value : undefined;
    },
    async editor(title, prefill) {
      const value = await request(title, {type: "string", title: "Text", default: prefill ?? "", _meta: {eidoMultiline: true}});
      return typeof value === "string" ? value : undefined;
    },
    notify: (message, type) => notice(type && type !== "info" ? `${type}: ${message}` : message),
    setTitle: title => pi.setSessionName(title),
  };
}
