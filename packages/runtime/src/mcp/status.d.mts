import type {McpServer} from '../../../acp/node_modules/@agentclientprotocol/sdk/dist/acp.js';
export const MCP_STATUS: unique symbol;
export type McpConnectionState = 'connecting'|'connected'|'unavailable'|'needs-auth'|'disconnected'|'degraded';
export function mcpRevision(config: unknown, autoEnableCodemode?: boolean): string;
export function createMcpStatus(directory: string): (binding?: {sessionId:string; sessionSignal:AbortSignal}) => {
  publish(rows: {server:McpServer; state:McpConnectionState; toolCount:number}[]): Promise<void>|undefined;
  close(): Promise<void>;
}|undefined;
export function readMcpStatus(directory:string, activePids:number[]): Promise<Array<{
  name:string; state:McpConnectionState; toolCount:number; origin:string; plugin?:string; revision?:string;
  sessionId:string; runtime:number; updatedAt:string;
}>>;
