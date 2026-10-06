export class PiHttpSettingsError extends Error {}
export function normalizeHttpProxy(value: unknown): string;
export function httpProxyStatus(settings: Record<string, unknown>): {configured: boolean; revision: string};
export function mergeHttpProxy(settings: Record<string, unknown>, proxy: unknown, expected: unknown): Record<string, unknown>;
