import type { McpHealthDTO } from "@rama/protocol";
import { connectServer } from "./client";
import { getConnection } from "./registry";
import { getMcpServer } from "./store";

const TIMEOUT_MS = 4000;

// Mirrors providerHealth.ts's shape/pattern: a cheap reachability probe, reusing a live
// registry connection if one exists (just lists tools) else attempting a throwaway connect+close.
export async function checkMcpServerHealth(id: string): Promise<McpHealthDTO> {
  const checkedAt = Date.now();
  const row = getMcpServer(id);
  if (!row) {
    return { serverId: id, status: "bad", latencyMs: null, error: "unknown server", checkedAt };
  }
  if (!row.enabled) {
    return { serverId: id, status: "disabled", latencyMs: null, error: null, checkedAt };
  }

  const started = Date.now();
  const existing = getConnection(id);
  try {
    if (existing) {
      await existing.client.listTools();
      return { serverId: id, status: "ok", latencyMs: Date.now() - started, error: null, checkedAt };
    }

    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), TIMEOUT_MS));
    const client = await Promise.race([connectServer(row), timeout]);
    await client.close().catch(() => {});
    return { serverId: id, status: "ok", latencyMs: Date.now() - started, error: null, checkedAt };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { serverId: id, status: "bad", latencyMs: Date.now() - started, error: message, checkedAt };
  }
}
