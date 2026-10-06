import type {SessionManager} from '@earendil-works/pi-coding-agent';
export declare function persistSession(manager: SessionManager): void;
export declare function appendEidoEntry(manager: SessionManager, type: string, data: unknown): string;
