// AGENT_BROWSER_PLAN.md AB4 — unit tests for the DB-free half of the loopback-vs-ask decision
// (isLoopbackOrigin, decideBrowserActionRule). The DB-backed wrapper (resolveBrowserActionRule)
// isn't tested here — this repo has no precedent for standing up a fixture project/settings store
// in a test, and the pure logic is the part actually worth pinning down.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createChat, deleteChat, getChat, getChatSettings, setChatPermissionAllow } from "../db/chats";
import { createProject, deleteProject } from "../db/projects";
import type { ToolCtx } from "../tools/types";
import { liveChatStatus } from "../ws";
import { allowKeyFor, decideBrowserActionRule, gate, isLoopbackOrigin, pendingIdsFor, pendingRequestsFor, resolvePermission } from "./permissions";

describe("AB4 isLoopbackOrigin", () => {
  test.each([
    ["http://localhost:5173", true],
    ["http://127.0.0.1:8080", true],
    ["http://foo.localhost:3000", true],
    ["https://github.com", false],
    ["https://www.youtube.com", false],
    [undefined, false],
    ["not a url", false],
  ])("%s -> %s", (origin, expected) => {
    expect(isLoopbackOrigin(origin as string | undefined)).toBe(expected);
  });
});

describe("AB4 decideBrowserActionRule", () => {
  test("no explicit override: loopback auto-allows", () => {
    expect(decideBrowserActionRule(undefined, "http://localhost:5173")).toBe("allow");
  });

  test("no explicit override: a real origin asks", () => {
    expect(decideBrowserActionRule(undefined, "https://github.com")).toBe("ask");
  });

  test("no explicit override and no known origin: asks (safe default, not allow)", () => {
    expect(decideBrowserActionRule(undefined, undefined)).toBe("ask");
  });

  test("an explicit project/global rule overrides the loopback default in both directions", () => {
    expect(decideBrowserActionRule("deny", "http://localhost:5173")).toBe("deny");
    expect(decideBrowserActionRule("allow", "https://github.com")).toBe("allow");
  });
});

// CODE_REDESIGN_PLAN.md E3 — "Always allow in this chat". Like db/home.test.ts this runs against the
// real ~/.rama/rama.db and deletes what it creates.
describe("E3 allowKeyFor", () => {
  test("a tool's settings bucket, or its own name when it has none", () => {
    expect(allowKeyFor("bash")).toBe("bash");
    expect(allowKeyFor("process")).toBe("bash");
    expect(allowKeyFor("edit")).toBe("edit");
    expect(allowKeyFor("browser")).toBe("web");
    expect(allowKeyFor("git_write")).toBe("git_write");
    expect(allowKeyFor("file_op")).toBe("file_op");
  });

  test("browser actions are their own bucket, so approving a click never approves opening a page", () => {
    expect(allowKeyFor("browser", { browserAction: true })).toBe("browser_action");
  });
});

describe("E3 chat-scoped approvals", () => {
  let projectId: string;
  let chatA: string;
  let chatB: string;

  beforeAll(() => {
    projectId = createProject({ name: "e3-test", path: "/tmp" }).id;
    chatA = createChat(projectId, { title: "a" }).id;
    chatB = createChat(projectId, { title: "b" }).id;
  });
  afterAll(() => {
    deleteChat(chatA);
    deleteChat(chatB);
    deleteProject(projectId);
  });

  const ctxFor = (chatId: string, mode: ToolCtx["mode"] = "ask") =>
    ({ chatId, projectId, mode, abortSignal: new AbortController().signal }) as unknown as ToolCtx;
  const gitCommit = { name: "git_write", input: { op: "commit" }, risk: "high" as const };

  /** Runs one gated call, answers its prompt (if it asks) and says whether it asked. */
  async function callAndAnswer(ctx: ToolCtx, opts: typeof gitCommit, answer: { approve: boolean; scope?: "once" | "chat" }) {
    let asked = false;
    const reqIds = new Set<string>();
    const result = gate(ctx, opts, async () => ({ ok: true, summary: "done" }));
    // The prompt is registered synchronously by gate()'s first await; answer it on the next tick.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const waiting = liveChatStatus(ctx.chatId) === "waiting_permission";
    if (waiting) {
      asked = true;
      // The reqId is only on the wire, so find it the way server.ts would: the one pending entry.
      for (const id of pendingIdsFor(ctx.chatId)) reqIds.add(id);
      for (const id of reqIds) resolvePermission(id, answer.approve, answer.scope);
    }
    return { asked, result: await result };
  }

  test("Allow once asks again next time", async () => {
    const first = await callAndAnswer(ctxFor(chatA), gitCommit, { approve: true });
    expect(first.asked).toBe(true);
    expect(first.result.ok).toBe(true);
    expect(getChatSettings(chatA)?.permissionAllow).toEqual([]);
    expect((await callAndAnswer(ctxFor(chatA), gitCommit, { approve: true })).asked).toBe(true);
  });

  test("Always allow remembers the tool for that chat only", async () => {
    expect((await callAndAnswer(ctxFor(chatA), gitCommit, { approve: true, scope: "chat" })).asked).toBe(true);
    expect(getChatSettings(chatA)?.permissionAllow).toEqual(["git_write"]);

    const again = await callAndAnswer(ctxFor(chatA), gitCommit, { approve: true });
    expect(again.asked).toBe(false);
    expect(again.result.ok).toBe(true);

    expect((await callAndAnswer(ctxFor(chatB), gitCommit, { approve: true })).asked).toBe(true);
  });

  test("a Deny never leaves a standing rule, even with scope chat", async () => {
    const denied = await callAndAnswer(ctxFor(chatB), gitCommit, { approve: false, scope: "chat" });
    expect(denied.result).toEqual({ ok: false, summary: "denied by user" });
    expect(getChatSettings(chatB)?.permissionAllow).toEqual([]);
  });

  test("plan mode still blocks an allowed tool", async () => {
    setChatPermissionAllow(chatB, ["git_write"]);
    const out = await gate(ctxFor(chatB, "plan"), gitCommit, async () => ({ ok: true, summary: "done" }));
    expect(out).toEqual({ ok: false, summary: "blocked: plan mode is read-only" });
  });

  test("revoking empties the list and the next call asks again", async () => {
    setChatPermissionAllow(chatB, []);
    expect(getChatSettings(chatB)?.permissionAllow).toEqual([]);
    expect((await callAndAnswer(ctxFor(chatB), gitCommit, { approve: true })).asked).toBe(true);
  });
});

// E2 — the sidebar's flag. A chat waiting on an approval reads `waiting_permission` in its DTO
// (not just on the wire) until it is answered, then goes back to a running state.
describe("E2 live chat status", () => {
  let projectId: string;
  let chatId: string;
  beforeAll(() => {
    projectId = createProject({ name: "e2-test", path: "/tmp" }).id;
    chatId = createChat(projectId, { title: "waiting" }).id;
  });
  afterAll(() => {
    resolveAll();
    deleteChat(chatId);
    deleteProject(projectId);
  });
  const resolveAll = () => pendingIdsFor(chatId).forEach((id) => resolvePermission(id, false));

  test("an unanswered ask shows as waiting_permission, and answering it as running", async () => {
    const ctx = { chatId, projectId, mode: "ask", abortSignal: new AbortController().signal } as unknown as ToolCtx;
    const out = gate(ctx, { name: "bash", input: { command: "ls" }, risk: "high" }, async () => ({ ok: true, summary: "x" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(getChat(chatId)?.status).toBe("waiting_permission");
    // A window that subscribes now is handed the card it is waiting on (server.ts's subscribeChat).
    expect(pendingRequestsFor(chatId).map((r) => [r.tool, r.input])).toEqual([["bash", { command: "ls" }]]);

    for (const id of pendingIdsFor(chatId)) resolvePermission(id, true);
    await out;
    expect(getChat(chatId)?.status).toBe("tool");
  });
});
