// Run with `bun test packages/ui/src/kit`.
import { describe, expect, test } from "bun:test";
import { byline, isLocalBaseUrl, placeOf, privacyNote } from "./modelPlace";

describe("isLocalBaseUrl", () => {
  test("this machine and .local names are local", () => {
    for (const url of [
      "http://localhost:11434/v1",
      "http://127.0.0.1:1234/v1",
      "http://[::1]:8080",
      "http://0.0.0.0:11434",
      "http://studio.local:1234/v1",
      "localhost:11434",
      "HTTP://LOCALHOST:11434",
    ]) {
      expect(isLocalBaseUrl(url)).toBe(true);
    }
  });

  test("anything else is cloud", () => {
    for (const url of ["https://api.together.xyz/v1", "https://openrouter.ai/api/v1", "http://192.168.1.20:11434", "https://localhost.example.com", "not a url at all", "", null, undefined]) {
      expect(isLocalBaseUrl(url)).toBe(false);
    }
  });
});

describe("placeOf / privacyNote", () => {
  test("a provider with no base URL is cloud", () => {
    expect(placeOf({ baseUrl: null })).toBe("cloud");
    expect(placeOf({ baseUrl: "http://localhost:11434/v1" })).toBe("local");
  });

  test("the mockup's sentences", () => {
    expect(privacyNote("Qwen3 14B", "local", "Ollama")).toBe("Qwen3 14B runs on this Mac. Nothing you send leaves it.");
    expect(privacyNote("GLM 5.3 Flash", "cloud", "Together AI")).toBe("GLM 5.3 Flash runs on Together AI's servers. Messages are sent to them.");
  });

  test("bylines (mock:L877)", () => {
    expect(byline("Qwen3 14B", "local", "Ollama")).toBe("Qwen3 14B on this Mac");
    expect(byline("GLM 5.3 Flash", "cloud", "Together AI")).toBe("GLM 5.3 Flash via Together AI");
  });
});
