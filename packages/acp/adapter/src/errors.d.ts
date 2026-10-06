import { RequestError } from "@agentclientprotocol/sdk";
export type ErrorKind = "command_error" | "auth_error" | "rate_limit" | "billing_error" | "provider_error" | "invalid_model" | "empty_prompt" | "session_busy" | "invalid_config_value" | "invalid_config_type" | "unknown_config_option" | "invalid_cwd" | "invalid_system_prompt" | "unknown_session" | "session_already_open" | "session_terminated" | "session_corrupt" | "session_not_forkable" | "mcp_init_error" | "unsupported_mcp_transport" | "extension_setup_error" | "child_cleanup_error" | "invalid_cursor" | "unknown_auth_method" | "notification_error" | "internal_error";
export interface DiagnosticLike {
    type: string;
    timestamp: number;
    error?: {
        name?: string;
        message: string;
        stack?: string;
        code?: string | number;
    };
    details?: unknown;
}
export interface TerminalAssistantLike {
    stopReason: string;
    errorMessage?: string;
    diagnostics?: DiagnosticLike[];
}
export declare function redactedDiagnostics(diagnostics: readonly DiagnosticLike[] | undefined): {
    type: string;
    timestamp: number;
}[] | undefined;
type DiagnosticDetails = {
    details?: Array<{
        type: string;
        timestamp: number;
    }>;
};
type ServerDetails = {
    server: string;
};
type ChildDetails = {
    details: {
        remainingChildren: number;
    };
};
type FieldDetails = {
    field: string;
};
export declare function adapterError(kind: "mcp_init_error" | "unsupported_mcp_transport", extras: ServerDetails): RequestError;
export declare function adapterError(kind: "provider_error" | "internal_error", extras?: DiagnosticDetails): RequestError;
export declare function adapterError(kind: "child_cleanup_error", extras: ChildDetails): RequestError;
export declare function adapterError(kind: "invalid_system_prompt", extras: FieldDetails): RequestError;
export declare function adapterError(kind: Exclude<ErrorKind, "mcp_init_error" | "unsupported_mcp_transport" | "provider_error" | "internal_error" | "child_cleanup_error" | "invalid_system_prompt">): RequestError;
export declare function classifyPreflight(error: unknown): RequestError;
export declare function classifyTerminal(message: TerminalAssistantLike): RequestError;
export declare function unexpectedError(error: unknown, terminal?: TerminalAssistantLike): RequestError;
export declare function isRequestError(error: unknown): error is RequestError;
export declare function isChildCleanupError(error: unknown): error is RequestError;
export {};
//# sourceMappingURL=errors.d.ts.map