// HOME_REDESIGN_PLAN.md Phase HD6 — the producing model on assistant rows (Home's byline) and the
// "Try again" rewind. Like home.test.ts this runs against the real ~/.rama/rama.db, so the chat it
// creates is deleted again in afterAll.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { deleteChat } from "./chats";
import { createHomeChat, ensureHomeProject } from "./home";
import { appendMessage, finalizeMessage, listMessages, rewindToUserTurn } from "./messages";
import { createToolCall, listToolCalls } from "./toolCalls";

describe("producedBy and rewindToUserTurn", () => {
  let chatId: string;

  beforeAll(() => {
    ensureHomeProject();
    chatId = createHomeChat({ providerId: "ollama", model: "qwen3:14b" }).id;
  });

  afterAll(() => {
    deleteChat(chatId);
  });

  test("an assistant row keeps the model that wrote it, through finalize", () => {
    appendMessage(chatId, { role: "user", content: "first question" });
    const a = appendMessage(chatId, { role: "assistant", content: null, producedBy: { providerId: "ollama", model: "qwen3:14b" } });
    finalizeMessage(a.id, "first answer", null, undefined, [{ kind: "text", text: "first answer" }]);
    const row = listMessages(chatId).find((m) => m.id === a.id)!;
    expect(row.providerId).toBe("ollama");
    expect(row.model).toBe("qwen3:14b");
    expect(row.content).toBe("first answer");
    // A user row carries no model.
    expect(listMessages(chatId)[0]!.model).toBeUndefined();
  });

  test("rewind drops the last user turn and everything after it, and returns its text", () => {
    appendMessage(chatId, { role: "user", content: "second question" });
    const step1 = appendMessage(chatId, { role: "assistant", content: null, producedBy: { providerId: "ollama", model: "qwen3:14b" } });
    createToolCall({ id: `tc-${chatId}`, messageId: step1.id, chatId, name: "read", input: { path: "a.txt" }, startedAt: Date.now() });
    appendMessage(chatId, { role: "assistant", content: "second answer" });

    expect(rewindToUserTurn(chatId)?.text).toBe("second question");
    const left = listMessages(chatId);
    expect(left.map((m) => m.content)).toEqual(["first question", "first answer"]);
    expect(listToolCalls(chatId)).toHaveLength(0);
  });

  test("an earlier turn takes every later turn with it", () => {
    appendMessage(chatId, { role: "user", content: "second question" });
    appendMessage(chatId, { role: "assistant", content: "second answer" });
    appendMessage(chatId, { role: "user", content: "third question" });
    appendMessage(chatId, { role: "assistant", content: "third answer" });
    expect(rewindToUserTurn(chatId, 5)).toBeNull();
    expect(rewindToUserTurn(chatId, 1)?.text).toBe("second question");
    expect(listMessages(chatId).map((m) => m.content)).toEqual(["first question", "first answer"]);
  });

  test("with no user message there's nothing to rewind", () => {
    expect(rewindToUserTurn(chatId)?.text).toBe("first question");
    expect(listMessages(chatId)).toHaveLength(0);
    expect(rewindToUserTurn(chatId)).toBeNull();
  });
});
