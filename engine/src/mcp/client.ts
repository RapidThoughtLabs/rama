import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { getSecret } from "../secrets";
import type { McpServerRow, McpTransportConfig } from "./types";

export function parseTransport(row: McpServerRow): McpTransportConfig {
  return JSON.parse(row.transport_json) as McpTransportConfig;
}

export async function connectServer(row: McpServerRow): Promise<MCPClient> {
  const transport = parseTransport(row);

  if (transport.kind === "stdio") {
    return createMCPClient({
      clientName: "rama",
      transport: new Experimental_StdioMCPTransport({
        command: transport.command,
        args: transport.args,
        env: transport.env,
      }),
    });
  }

  const token = getSecret(`mcp:${row.id}`);
  const headers = { ...transport.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  return createMCPClient({
    clientName: "rama",
    transport: { type: transport.kind, url: transport.url, headers },
  });
}
