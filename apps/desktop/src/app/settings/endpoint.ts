import type { ProviderKind } from "@rama/protocol";

/* Helpers for the add-provider form. None of this predefines a provider: the user always types the
   base URL. It only guesses a display name from it, and checks the URL's shape. */

const LOCAL_PORTS: Record<string, string> = { "11434": "Ollama", "1234": "LM Studio", "8000": "vLLM", "8080": "llama.cpp" };
const HOSTS: [RegExp, string][] = [
  [/(^|\.)openai\.com$/, "OpenAI"],
  [/(^|\.)anthropic\.com$/, "Anthropic"],
  [/(^|\.)together\.(xyz|ai)$/, "Together AI"],
  [/(^|\.)groq\.com$/, "Groq"],
  [/(^|\.)openrouter\.ai$/, "OpenRouter"],
  [/(^|\.)deepseek\.com$/, "DeepSeek"],
  [/(^|\.)mistral\.ai$/, "Mistral"],
  [/(^|\.)x\.ai$/, "xAI"],
  [/(^|\.)fireworks\.ai$/, "Fireworks"],
  [/(^|\.)z\.ai$/, "Z.ai"],
  [/(^|\.)moonshot\.(ai|cn)$/, "Moonshot"],
  [/(^|\.)minimaxi?\.(io|com|chat)$/, "MiniMax"],
  [/(^|\.)googleapis\.com$/, "Google"],
  [/(^|\.)cerebras\.ai$/, "Cerebras"],
];

function parse(url: string): URL | null {
  const raw = url.trim();
  if (!raw) return null;
  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    return null;
  }
}

/** "https://api.together.xyz/v1" → "Together AI"; "http://localhost:11434/v1" → "Ollama". */
export function suggestName(url: string): string {
  const u = parse(url);
  if (!u) return "";
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host.endsWith(".local")) {
    return LOCAL_PORTS[u.port] ?? "Local server";
  }
  for (const [re, name] of HOSTS) if (re.test(host)) return name;
  const parts = host.split(".").filter((p) => p !== "api" && p !== "www");
  const core = parts.length >= 2 ? parts[parts.length - 2]! : (parts[0] ?? "");
  return core ? core[0]!.toUpperCase() + core.slice(1) : "";
}

export function validBaseUrl(url: string): boolean {
  return /^https?:\/\/[^\s/]+/i.test(url.trim());
}

export const SPECS: { id: ProviderKind; title: string; detail: string; wire: string; urlHint: string; urlPlaceholder: string }[] = [
  {
    id: "openai-compatible",
    title: "OpenAI-compatible",
    detail: "The Chat Completions format. OpenAI, Together, Groq, OpenRouter, Ollama, LM Studio, vLLM and most others.",
    wire: "POST /chat/completions",
    urlHint: "Usually ends in /v1. Ollama on this Mac is http://localhost:11434/v1.",
    urlPlaceholder: "https://api.openai.com/v1",
  },
  {
    id: "anthropic",
    title: "Claude-compatible",
    detail: "Anthropic's Messages format. The Claude API, and gateways that offer it.",
    wire: "POST /v1/messages",
    urlHint: "Without /v1; Rama adds it. The Claude API itself is https://api.anthropic.com.",
    urlPlaceholder: "https://api.anthropic.com",
  },
];

export const SPEC_LABEL: Record<ProviderKind, string> = { "openai-compatible": "OpenAI-compatible", anthropic: "Claude-compatible" };
