import type { ProviderHealthDTO } from "@rama/protocol";
import { getProvider, providerRequiresKey } from "./db/providers";
import { getSecret } from "./secrets";

const TIMEOUT_MS = 4000;

// A cheap, read-only reachability probe: hit the provider's model-list endpoint and time it.
// This isn't billed and doesn't touch the chat's actual model, so it's safe to poll from the
// status bar. A missing key short-circuits before any network call — that's a distinct
// "no-key" status, not "bad", so the UI can prompt for a key instead of showing an error.
export async function checkProviderHealth(providerId: string): Promise<ProviderHealthDTO> {
  const checkedAt = Date.now();
  const providerRow = getProvider(providerId);
  if (!providerRow) {
    return { providerId, status: "bad", latencyMs: null, error: "unknown provider", checkedAt };
  }

  const apiKey = getSecret(providerId);
  if (!apiKey && providerRequiresKey(providerId)) {
    return { providerId, status: "no-key", latencyMs: null, error: null, checkedAt };
  }

  const url = providerRow.kind === "anthropic" ? "https://api.anthropic.com/v1/models" : `${providerRow.base_url}/models`;
  const headers: Record<string, string> =
    providerRow.kind === "anthropic"
      ? { "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${apiKey ?? ""}` };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return { providerId, status: "bad", latencyMs, error: `HTTP ${res.status}`, checkedAt };
    }
    return { providerId, status: "ok", latencyMs, error: null, checkedAt };
  } catch (err) {
    const message = err instanceof Error ? (err.name === "AbortError" ? "timed out" : err.message) : String(err);
    return { providerId, status: "bad", latencyMs: Date.now() - started, error: message, checkedAt };
  } finally {
    clearTimeout(timeout);
  }
}
