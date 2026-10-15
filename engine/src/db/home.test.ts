// HOME_REDESIGN_PLAN.md Phase HD3 — the hidden Home project and `kind` filtering. Like
// agent/run/transcript.test.ts this runs against the real ~/.rama/rama.db (there's no fixture DB),
// so every row it creates is deleted again in afterAll. ensureHomeProject is the same idempotent
// upsert the engine runs at boot.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createChat, deleteChat, getChat, listAllChats, listChatsByProject } from "./chats";
import { HOME_DIR, HOME_PROJECT_ID, createHomeChat, ensureHomeProject, listHomeChats } from "./home";
import { appendMessage } from "./messages";
import { createProject, deleteProject, getProject, listProjects } from "./projects";

describe("Home project and chats", () => {
  let codeProjectId: string;
  const chatIds: string[] = [];

  beforeAll(() => {
    ensureHomeProject();
    codeProjectId = createProject({ name: "hd3-test", path: "/tmp" }).id;
  });

  afterAll(() => {
    for (const id of chatIds) deleteChat(id);
    deleteProject(codeProjectId);
  });

  test("ensureHomeProject is idempotent and creates the sandbox directory", () => {
    ensureHomeProject();
    const home = getProject(HOME_PROJECT_ID);
    expect(home?.path).toBe(HOME_DIR);
    expect(home?.name).toBe("Home");
    expect(existsSync(HOME_DIR)).toBe(true);
  });

  test("listProjects never returns the Home project", () => {
    const ids = listProjects().map((p) => p.id);
    expect(ids).not.toContain(HOME_PROJECT_ID);
    expect(ids).toContain(codeProjectId);
  });

  test("deleteProject refuses the Home project", () => {
    expect(deleteProject(HOME_PROJECT_ID)).toBe("system");
    expect(getProject(HOME_PROJECT_ID)).not.toBeNull();
  });

  test("a Home chat is kind 'home', runs the home agent in agent mode, and stays out of the Code lists", () => {
    const home = createHomeChat({ webSearch: true });
    chatIds.push(home.id);
    expect(home.kind).toBe("home");
    expect(home.projectId).toBe(HOME_PROJECT_ID);
    expect(home.agentId).toBe("home");
    expect(home.mode).toBe("agent");
    expect(home.webSearch).toBe(true);

    expect(listAllChats().map((c) => c.id)).not.toContain(home.id);
    expect(listChatsByProject(HOME_PROJECT_ID).map((c) => c.id)).not.toContain(home.id);
    expect(listHomeChats().map((c) => c.id)).toContain(home.id);
  });

  test("a Code chat is kind 'code' and stays out of the Home list", () => {
    const code = createChat(codeProjectId, {});
    chatIds.push(code.id);
    expect(code.kind).toBe("code");
    expect(listChatsByProject(codeProjectId).map((c) => c.id)).toContain(code.id);
    expect(listHomeChats().map((c) => c.id)).not.toContain(code.id);
  });

  test("the snippet comes from the newest assistant message with text", () => {
    const home = createHomeChat({});
    chatIds.push(home.id);
    expect(listHomeChats().find((c) => c.id === home.id)?.snippet).toBeNull();

    appendMessage(home.id, { role: "user", content: "Is this lease okay?" });
    appendMessage(home.id, { role: "assistant", content: "Mostly. One clause stands out." });
    appendMessage(home.id, { role: "assistant", content: "" });
    const summary = listHomeChats().find((c) => c.id === home.id);
    expect(summary?.snippet).toBe("Mostly.");
    expect(summary?.webSearch).toBe(false);
    expect(getChat(home.id)?.kind).toBe("home");
  });
});
