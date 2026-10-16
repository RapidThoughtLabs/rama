// Settings › Providers adds every provider by wire format + base URL. These cover the two pure
// pieces of that: normalizing what the user pasted, and resolving a known endpoint to its catalog
// id. Nothing here writes to the DB (it's the real ~/.rama/rama.db, see home.test.ts).
import { describe, expect, test } from "bun:test";
import { catalogIdForEndpoint, normalizeBaseUrl } from "./providers";

const free = () => false;

describe("normalizeBaseUrl", () => {
  test("drops trailing slashes", () => {
    expect(normalizeBaseUrl("openai-compatible", "  https://api.together.xyz/v1/  ")).toBe("https://api.together.xyz/v1");
  });

  test("Anthropic-spec URLs lose /v1 and /v1/messages, since the client appends them", () => {
    expect(normalizeBaseUrl("anthropic", "https://api.anthropic.com/v1")).toBe("https://api.anthropic.com");
    expect(normalizeBaseUrl("anthropic", "https://gw.example.com/anthropic/v1/messages")).toBe("https://gw.example.com/anthropic");
    expect(normalizeBaseUrl("anthropic", "https://api.anthropic.com")).toBe("https://api.anthropic.com");
  });

  test("OpenAI-spec URLs keep /v1 but lose a pasted /chat/completions", () => {
    expect(normalizeBaseUrl("openai-compatible", "http://localhost:11434/v1/chat/completions")).toBe("http://localhost:11434/v1");
    expect(normalizeBaseUrl("openai-compatible", "https://api.openai.com/v1")).toBe("https://api.openai.com/v1");
  });
});

describe("catalogIdForEndpoint", () => {
  test("a catalog endpoint typed by hand resolves to that catalog id", () => {
    expect(catalogIdForEndpoint("openai-compatible", "https://api.together.xyz/v1/", free)).toBe("together");
    expect(catalogIdForEndpoint("openai-compatible", "HTTP://LOCALHOST:11434/v1", free)).toBe("ollama");
  });

  test("the native Anthropic entry has no base URL, so the default host stands in for it", () => {
    expect(catalogIdForEndpoint("anthropic", "https://api.anthropic.com/v1", free)).toBe("anthropic");
  });

  test("the wire format has to match too", () => {
    expect(catalogIdForEndpoint("anthropic", "https://api.together.xyz/v1", free)).toBeNull();
    expect(catalogIdForEndpoint("openai-compatible", "https://api.anthropic.com", free)).toBeNull();
  });

  test("an id that's already configured isn't reused, and unknown hosts get none", () => {
    expect(catalogIdForEndpoint("openai-compatible", "https://api.together.xyz/v1", () => true)).toBeNull();
    expect(catalogIdForEndpoint("openai-compatible", "https://gateway.example.com/v1", free)).toBeNull();
  });
});
