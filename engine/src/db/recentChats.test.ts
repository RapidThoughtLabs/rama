// CODE_REDESIGN_PLAN.md CR8 — the Code landing's "Recent in {project}" rows. Like home.test.ts this runs
// against the real ~/.rama/rama.db, so everything it creates is deleted again in afterAll.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createChat, deleteChat, listRecentChats } from "./chats";
import { appendMessage } from "./messages";
import { db } from "./index";
import { createProject, deleteProject } from "./projects";

describe("listRecentChats", () => {
  let projectId: string;
  let otherId: string;
  let emptyId: string;
  const chatIds: string[] = [];
  const never = () => null;

  beforeAll(() => {
    projectId = createProject({ name: "cr8-test", path: "/tmp" }).id;
    otherId = createProject({ name: "cr8-other", path: "/tmp" }).id;
    emptyId = createProject({ name: "cr8-empty", path: "/tmp" }).id;
  });

  afterAll(() => {
    for (const id of chatIds) deleteChat(id);
    deleteProject(projectId);
    deleteProject(otherId);
    deleteProject(emptyId);
  });

  test("newest first, capped at the limit, only this project's Code chats", () => {
    for (const title of ["one", "two", "three", "four"]) {
      const c = createChat(projectId, { title });
      chatIds.push(c.id);
      Bun.sleepSync(3); // updated_at is the creation time; keep it distinct
    }
    chatIds.push(createChat(otherId, { title: "elsewhere" }).id);
    const rows = listRecentChats(projectId, 3, never);
    expect(rows.map((r) => r.title)).toEqual(["four", "three", "two"]);
    expect(rows.every((r) => r.projectId === projectId && r.kind === "code")).toBe(true);
  });

  test("the snippet is the first sentence of the last assistant reply with any text", () => {
    const chat = createChat(projectId, { title: "snippet" });
    chatIds.push(chat.id);
    appendMessage(chat.id, { role: "user", content: "Why the flash?" });
    appendMessage(chat.id, { role: "assistant", content: "Old answer. Not this one." });
    appendMessage(chat.id, { role: "assistant", content: "**Fixed.** The theme is cached before React mounts." });
    appendMessage(chat.id, { role: "assistant", content: "" });
    const row = listRecentChats(projectId, 10, never).find((r) => r.id === chat.id);
    expect(row?.snippet).toBe("Fixed.");
  });

  test("a chat with no assistant text has a null snippet", () => {
    const chat = createChat(projectId, { title: "quiet" });
    chatIds.push(chat.id);
    appendMessage(chat.id, { role: "user", content: "hello" });
    expect(listRecentChats(projectId, 10, never).find((r) => r.id === chat.id)?.snippet).toBeNull();
  });

  test("a project with no chats gives an empty list", () => {
    expect(listRecentChats(emptyId, 3, never)).toEqual([]);
  });

  test("a chat waiting on an ask shows the ask's sentence, not its last reply", () => {
    const chat = createChat(projectId, { title: "waiting" });
    chatIds.push(chat.id);
    appendMessage(chat.id, { role: "assistant", content: "Ready to commit." });
    db.query("UPDATE chats SET status = 'waiting_permission' WHERE id = ?").run(chat.id);
    const rows = listRecentChats(projectId, 20, (id) => (id === chat.id ? "Waiting for your OK to commit." : null));
    expect(rows.find((r) => r.id === chat.id)?.snippet).toBe("Waiting for your OK to commit.");
    // No pending ask left to name (the callback says null): fall back to the reply.
    expect(listRecentChats(projectId, 20, never).find((r) => r.id === chat.id)?.snippet).toBe("Ready to commit.");
  });
});
