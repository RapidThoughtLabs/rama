import { describe, expect, test } from "bun:test";
import { suggestName, validBaseUrl } from "./endpoint";

describe("suggestName", () => {
  test("names local servers by their usual port", () => {
    expect(suggestName("http://localhost:11434/v1")).toBe("Ollama");
    expect(suggestName("http://127.0.0.1:1234/v1")).toBe("LM Studio");
    expect(suggestName("http://localhost:9999")).toBe("Local server");
  });

  test("names well-known hosts", () => {
    expect(suggestName("https://api.together.xyz/v1")).toBe("Together AI");
    expect(suggestName("https://api.anthropic.com")).toBe("Anthropic");
    expect(suggestName("https://openrouter.ai/api/v1")).toBe("OpenRouter");
  });

  test("falls back to the domain, and copes with a missing scheme or junk", () => {
    expect(suggestName("https://llm.acme-corp.com/v1")).toBe("Acme-corp");
    expect(suggestName("api.example.com/v1")).toBe("Example");
    expect(suggestName("")).toBe("");
    expect(suggestName("http://")).toBe("");
  });
});

describe("validBaseUrl", () => {
  test("needs a scheme and a host", () => {
    expect(validBaseUrl("https://api.openai.com/v1")).toBe(true);
    expect(validBaseUrl(" http://localhost:11434/v1 ")).toBe(true);
    expect(validBaseUrl("api.openai.com/v1")).toBe(false);
    expect(validBaseUrl("https://")).toBe(false);
  });
});
