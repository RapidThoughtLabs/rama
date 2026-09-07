import { tool } from "ai";
import { z } from "zod";
import { gate } from "../agent/permissions";
import { getTodos, setTodos, updateTodo } from "../db/todos";
import { broadcast } from "../ws";
import type { ToolCtx, ToolResult } from "./types";

// docs/TOOL_LAYER_PLAN.md §6.14 (TL6) — M5: tracks a multi-part task so it survives compaction
// and long runs without drifting. `set` has no status field on its items by design — every fresh
// item starts "pending"; `update` is the only way to move one to "active"/"done", and the
// exactly-one-active constraint lives in db/todos.ts, not this prompt.
const inputSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), items: z.array(z.object({ text: z.string() })) }),
  z.object({ op: z.literal("update"), index: z.number(), status: z.enum(["pending", "active", "done"]) }),
]);

export function formatTodoList(items: { text: string; status: string }[]): string {
  if (items.length === 0) return "(no todo list set for this chat)";
  const glyph = { pending: "[ ]", active: "[~]", done: "[x]" } as Record<string, string>;
  return items.map((item, i) => `${i}. ${glyph[item.status] ?? "[ ]"} ${item.text}`).join("\n");
}

export function createTodoTool(ctx: ToolCtx) {
  return tool({
    description:
      "Set or update your todo list for this chat — the plan for a multi-part task. `set` " +
      "replaces the whole list with fresh pending items (do this once, at the start, not per " +
      "step). `update` moves one item (by index) to active/done — exactly one item may be active " +
      "at a time; marking a new one active auto-finishes whichever was active before. The current " +
      "list is re-shown to you automatically every step while it has open items, so you do not " +
      "need to re-read it yourself.",
    inputSchema,
    execute: async (input): Promise<ToolResult> =>
      gate(ctx, { name: "todo", input, risk: "low" }, async () => {
        const result = input.op === "set" ? { items: setTodos(ctx.chatId, input.items.map((i) => i.text)) } : updateTodo(ctx.chatId, input.index, input.status);

        broadcast(ctx.chatId, { type: "todo.updated", chatId: ctx.chatId, items: result.items });

        if ("error" in result && result.error) {
          return { ok: false, summary: result.error, content: `${result.error}\n\n${formatTodoList(result.items)}` };
        }

        const activeCount = result.items.filter((i) => i.status === "active").length;
        const doneCount = result.items.filter((i) => i.status === "done").length;
        return {
          ok: true,
          content: formatTodoList(result.items),
          summary: `${doneCount}/${result.items.length} done${activeCount ? `, "${result.items.find((i) => i.status === "active")?.text}" active` : ""}`,
        };
      }),
  });
}

// TL6, §6.14/M5 — the minimal ephemeral-block stand-in used by agent/loop.ts's `prepareStep`
// until HARNESS_DESIGN.md's H2 lands a real C9 layer. Scoped to the todo list only (not a general
// reminder framework); returns null when there is nothing open to remind about, so a chat that
// never calls `todo` never pays for this.
export function todoEphemeralBlock(chatId: string): string | null {
  const items = getTodos(chatId);
  if (items.length === 0 || items.every((i) => i.status === "done")) return null;
  return `<system-reminder id="todo-list">\nYour current todo list:\n${formatTodoList(items)}\n</system-reminder>`;
}
