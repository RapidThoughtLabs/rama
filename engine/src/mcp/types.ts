export interface McpServerRow {
  id: string;
  name: string;
  transport_json: string;
  enabled: number;
  created_at: number;
}

export type McpTransportConfig =
  | { kind: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { kind: "sse" | "http"; url: string; headers?: Record<string, string> };
