import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Adapter } from "./adapters.ts";

export async function probeAdapter(adapter: Adapter) {
  const client = new Client({ name: "eido-probe", version: "0.0.1" });
  const transport = new StdioClientTransport({
    command: adapter.command, args: adapter.args, cwd: adapter.cwd, env: adapter.env,
    stderr: "pipe",
  });
  try {
    await client.connect(transport, { timeout: 15_000 });
    const tools = await client.listTools({}, { timeout: 15_000 });
    return { adapter: adapter.id, server: client.getServerVersion(), tools: tools.tools.map((tool) => tool.name), status: "connected" };
  } finally {
    await client.close();
    await transport.close();
  }
}
