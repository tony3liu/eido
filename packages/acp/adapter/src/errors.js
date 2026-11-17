// Adapted for Eido from @automatalabs/pi-acp 0.9.4 (Apache-2.0). See ../LICENSE.
import { RequestError } from "@agentclientprotocol/sdk";
const LABELS = {
    auth_error: "provider credentials required",
    rate_limit: "provider rate limit",
    billing_error: "provider billing or quota wall",
    provider_error: "provider error",
    command_error: "command failed",
    invalid_model: "unknown or unselectable model",
    empty_prompt: "prompt has no text or images",
    session_busy: "session has a turn in flight",
    invalid_config_value: "invalid config option",
    invalid_config_type: "invalid config option",
    unknown_config_option: "invalid config option",
    invalid_cwd: "invalid working directory",
    invalid_system_prompt: "invalid system prompt instructions",
    unknown_session: "unknown session id",
    session_already_open: "session already open",
    session_terminated: "session terminated",
    session_corrupt: "session file could not be read",
    session_not_forkable: "session has no persisted history to fork",
    mcp_init_error: "mcp server initialization failed",
    unsupported_mcp_transport: "unsupported mcp transport",
    extension_setup_error: "pi extension setup failed",
    child_cleanup_error: "child process cleanup failed",
    invalid_cursor: "invalid list cursor",
    unknown_auth_method: "unknown auth method",
    notification_error: "notification delivery failed",
    internal_error: "internal error",
};
const INVALID_KINDS = new Set([
    "invalid_model",
    "empty_prompt",
    "session_busy",
    "invalid_config_value",
    "invalid_config_type",
    "unknown_config_option",
    "invalid_cwd",
    "invalid_system_prompt",
    "unknown_session",
    "session_already_open",
    "session_terminated",
    "session_not_forkable",
    "unsupported_mcp_transport",
    "invalid_cursor",
    "unknown_auth_method",
]);
const errorSecrets = new Map();
export function rememberErrorSecrets(owner, values) {
    const secrets = values.filter(value => typeof value === 'string' && value.length > 0);
    if (secrets.length) errorSecrets.set(owner, secrets); else errorSecrets.delete(owner);
}
function schemaFailureDetail(message) {
    const value = String(message ?? '');
    if (!/(?:functionDeclaration|function declaration|tool|function)[\s\S]{0,400}schema|schema[\s\S]{0,200}(?:type field|invalid|unsupported)/i.test(value)) return undefined;
    const status = /\b(400|422)\b/.exec(value)?.[1];
    // Return only a bounded identifier from the diagnostic, never the raw body
    // (which may echo credentials, request content or private endpoints).
    const tool = /\bmcp__eido_computer__[a-z_]{1,64}\b/.exec(value)?.[0];
    return `${status ? `HTTP ${status}: ` : ''}The API rejected a tool parameter schema${tool ? ` (${tool})` : ''}. The request could not start. Check tool-schema compatibility with this provider.`;
}
function imageFailureDetail(message) {
    let value = String(message ?? '');
    if (!/(?:image(?:_url)?|vision)[^\n]{0,100}(?:not support|unsupported|not allow|reject|invalid)|(?:not support|unsupported|not allow|reject|invalid)[^\n]{0,100}(?:image(?:_url)?|vision)/i.test(value)) return undefined;
    for (const secrets of errorSecrets.values()) for (const secret of secrets) value = value.split(secret).join('[redacted]');
    value = value.replace(/(?:authorization|api[-_ ]?key|token|secret)\s*[=:]\s*["']?[^\s,"'}]+/gi, '[redacted auth]')
        .replace(/Bearer\s+[^\s,"'}]+/gi, 'Bearer [redacted]').replace(/[\x00-\x08\x0b-\x1f]/g, '');
    return `The API rejected image input. The images were not resent as text. ${value.slice(0,600)}`;
}
export function redactedDiagnostics(diagnostics) {
    return diagnostics?.length
        ? diagnostics.map(({ type, timestamp }) => ({ type, timestamp }))
        : undefined;
}
export function adapterError(kind, extras = {}) {
    const data = { errorKind: kind, message: LABELS[kind] };
    if ("server" in extras)
        data.server = extras.server;
    if ("field" in extras)
        data.field = extras.field;
    if ("details" in extras && extras.details !== undefined)
        data.details = extras.details;
    if (kind === "auth_error")
        return RequestError.authRequired(data);
    if (INVALID_KINDS.has(kind))
        return RequestError.invalidParams(data);
    return RequestError.internalError(data);
}
export function classifyPreflight(error) {
    if (error?.name === 'ImageGenerationError') {
        const codes = new Set(['authentication_failed','rate_limited','provider_rejected','response_too_large','invalid_response','invalid_image','invalid_image_url','download_failed','connection_changed','invalid_connection','unsupported_input','image_editing_not_supported','interrupted_or_unknown','previously_failed','operation_conflict','requires_new_user_request','authentication_or_provider_failed','timed_out','cancelled','failed','session_unavailable','unsupported_provider']);
        const code = codes.has(error.code) ? error.code : 'failed';
        const status = Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? ` (HTTP ${error.status})` : '';
        return adapterError(code === 'authentication_failed' ? 'auth_error' : code === 'rate_limited' ? 'rate_limit' : 'provider_error',
            {details:`Image generation ${code}${status}. No automatic retry was made.`});
    }
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes('this connection changed.')) {
        return adapterError('provider_error', {details:'This connection changed. Reselect the model before sending to load its current address and API format.'});
    }
    if (message.includes("no model selected"))
        return adapterError("invalid_model");
    if (message.includes("no api key found") ||
        message.includes("authentication failed for") ||
        message.includes("run '/login")) {
        return adapterError("auth_error");
    }
    if (message.includes('explicitly disables image input')) return adapterError('provider_error', {details:'This model explicitly disables image input. Choose another model to send these images.'});
    return adapterError("provider_error");
}
export function classifyTerminal(message) {
    if (message.errorMessage?.includes('This connection changed.')) {
        return adapterError('provider_error', {details:'This connection changed. Reselect the model before sending to load its current address and API format.'});
    }
    if (message.errorMessage?.includes('This model explicitly disables image input.')) {
        return adapterError('provider_error', {details:'This model explicitly disables image input. Choose another model to send these images.'});
    }
    const diagnostics = message.diagnostics ?? [];
    const haystack = [
        message.errorMessage ?? "",
        ...diagnostics.flatMap((item) => [
            item.type,
            item.error?.name ?? "",
            item.error?.message ?? "",
        ]),
    ]
        .join("\n")
        .toLowerCase();
    if (/\b401\b|\b403\b|unauthorized|invalid api key|authentication|forbidden|expired/.test(haystack)) {
        return adapterError("auth_error");
    }
    if (/quota|billing|insufficient|payment|credit|exceeded your/.test(haystack)) {
        return adapterError("billing_error");
    }
    if (/\b429\b|rate limit|too many requests|overloaded/.test(haystack)) {
        return adapterError("rate_limit");
    }
    return adapterError("provider_error", { details: schemaFailureDetail(message.errorMessage) ?? imageFailureDetail(message.errorMessage) ?? redactedDiagnostics(diagnostics) });
}
export function unexpectedError(error, terminal) {
    console.error("pi-acp internal error:", error);
    return adapterError("internal_error", {
        details: redactedDiagnostics(terminal?.diagnostics),
    });
}
export function isRequestError(error) {
    return error instanceof RequestError;
}
export function isChildCleanupError(error) {
    if (!(error instanceof RequestError) || error.code !== -32603)
        return false;
    const data = error.data;
    return Boolean(data && typeof data === "object" && data.errorKind === "child_cleanup_error");
}
