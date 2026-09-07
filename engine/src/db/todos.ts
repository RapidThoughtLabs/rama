import type { TodoItem } from "@rama/protocol";
import { db } from "./index";

function parseItems(json: string): TodoItem[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as TodoItem[]) : [];
  } catch {
    return [];
  }
}

export function getTodos(chatId: string): TodoItem[] {
  const row = db.query<{ items_json: string }, [string]>("SELECT items_json FROM chat_todos WHERE chat_id = ?").get(chatId);
  return row ? parseItems(row.items_json) : [];
}

function saveTodos(chatId: string, items: TodoItem[]): TodoItem[] {
  db.query(
    `INSERT INTO chat_todos (chat_id, items_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET items_json = excluded.items_json, updated_at = excluded.updated_at`,
  ).run(chatId, JSON.stringify(items), Date.now());
  return items;
}

// `set` input carries text only (§6.14's schema) — every item starts "pending"; the model marks
// one "active" with a follow-up `update` call.
export function setTodos(chatId: string, texts: string[]): TodoItem[] {
  return saveTodos(
    chatId,
    texts.map((text) => ({ text, status: "pending" as const })),
  );
}

export interface UpdateTodoResult {
  items: TodoItem[];
  error?: string;
}

// Exactly one item may be "active" — enforced here, not left to the prompt (§6.14): setting index
// `i` to "active" silently demotes whichever other item currently holds it to "done", since the
// only way an item stops being the active one is by finishing.
export function updateTodo(chatId: string, index: number, status: TodoItem["status"]): UpdateTodoResult {
  const items = getTodos(chatId);
  if (!Number.isInteger(index) || index < 0 || index >= items.length) {
    return { items, error: `no item at index ${index} — the list has ${items.length} item${items.length === 1 ? "" : "s"}` };
  }
  const next = items.map((item, i) => {
    if (i === index) return { ...item, status };
    if (status === "active" && item.status === "active") return { ...item, status: "done" as const };
    return item;
  });
  return { items: saveTodos(chatId, next) };
}
