import {randomUUID} from "node:crypto";
import {methods, type AgentContext} from "@agentclientprotocol/sdk";
import type {AgentSession, ExtensionUIContext} from "@earendil-works/pi-coding-agent";
import type {AuthPrompt, AuthType} from "@earendil-works/pi-ai";

/** pi owns auth methods, OAuth callbacks and credential storage. Native ACP owns input. */
export async function loginPiProvider(pi: AgentSession, client: AgentContext, ui: ExtensionUIContext | undefined, argument: string, signal?: AbortSignal) {
  if (!ui) throw new Error("Sign-in requires native pi forms.");
  const [providerRef, typeRef, extra] = argument.split(/\s+/);
  if (extra || typeRef && !["api_key", "oauth"].includes(typeRef)) throw new Error("Usage: /login [provider] [api_key | oauth].");
  const options = pi.modelRuntime.getProviders().flatMap(provider => (["api_key", "oauth"] as AuthType[]).flatMap(type => {
    const method = type === "api_key" ? provider.auth.apiKey : provider.auth.oauth;
    return method && (!providerRef || provider.id === providerRef || provider.name.toLowerCase() === providerRef.toLowerCase()) && (!typeRef || type === typeRef)
      ? [{provider, type, method, label: `${provider.id} · ${type === "api_key" ? "API key" : "Account sign-in"}`}]
      : [];
  }));
  if (!options.length) throw new Error("No matching pi authentication method. Use /login to select a provider.");
  const selected = options.length === 1 ? options[0] : undefined;
  const label = selected?.label ?? await ui.select("Sign in · Global pi credentials", options.map(option => option.label));
  const option = options.find(option => option.label === label);
  if (!option) return "Sign-in cancelled.";
  if (!option.method.login) return `${option.provider.name} uses environment credentials. Configure the provider environment using pi's global configuration.`;
  const stop = new AbortController();
  const combined = AbortSignal.any([stop.signal, ...(signal ? [signal] : [])]);
  const urls = new Set<string>(), pending: Promise<unknown>[] = [];
  let cancelled = false, completed = false;
  const prompt = async (prompt: AuthPrompt) => {
    const cancellationSignal = AbortSignal.any([combined, ...(prompt.signal ? [prompt.signal] : [])]);
    const response = await client.request(methods.client.elicitation.create, {
      sessionId: pi.sessionId, mode: "form", message: `${option.provider.name} · ${prompt.message}`,
      requestedSchema: {type: "object", properties: {value: prompt.type === "select"
        ? {type: "string", title: "Choose an option", oneOf: prompt.options.map(value => ({const: value.id, title: value.label}))}
        : {type: "string", title: prompt.type === "secret" ? "Credential" : "Value", description: prompt.placeholder,
          _meta: {eidoSecret: prompt.type === "secret" || prompt.type === "manual_code"}}}, required: ["value"]},
    }, {cancellationSignal});
    if (response.action !== "accept") {cancelled = true; stop.abort(); throw new Error("Sign-in cancelled.");}
    const content = "content" in response ? response.content as Record<string, unknown> : undefined;
    cancellationSignal.throwIfAborted();
    if (typeof content?.value !== "string" || !content.value.trim()) throw new Error("The sign-in form did not return a value.");
    if (prompt.type === "select" && !prompt.options.some(option => option.id === content.value)) throw new Error("Unknown sign-in option.");
    return content.value;
  };
  const showUrl = (url: string, message: string) => {
    if (!/^https?:\/\//.test(url)) {stop.abort(); return;}
    const elicitationId = randomUUID(); urls.add(elicitationId);
    pending.push(client.request(methods.client.elicitation.create, {sessionId: pi.sessionId, mode: "url", elicitationId, url, message}, {cancellationSignal: combined})
      .then(response => {if (response.action !== "accept") {cancelled = true; stop.abort();}})
      .catch(() => {if (!combined.aborted) {cancelled = true; stop.abort();}}));
  };
  try {
    await pi.modelRuntime.login(option.provider.id, option.type, {
      signal: combined, prompt,
      notify(event) {
        if (event.type === "auth_url") showUrl(event.url, event.instructions ?? `Sign in to ${option.provider.name}`);
        else if (event.type === "device_code") showUrl(event.verificationUri, `Sign in to ${option.provider.name}. Enter code: ${event.userCode}`);
        else if (event.type === "info") event.links?.forEach(link => showUrl(link.url, event.message));
      },
    }, {getDeviceId: () => pi.settingsManager.getOrCreateDeviceId()});
    completed = true;
    return `Signed in to ${option.provider.name}. Credentials are stored in global pi configuration.`;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (cancelled) return "Sign-in cancelled.";
    // Provider failures may contain callback URLs or credential values.
    throw new Error(`Sign-in to ${option.provider.name} failed. Check the provider configuration and retry /login.`);
  } finally {
    if (completed) for (const elicitationId of urls) await client.notify(methods.client.elicitation.complete, {elicitationId}).catch(() => {});
    stop.abort();
    await Promise.allSettled(pending);
  }
}
