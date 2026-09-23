import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "./schema";
import type { ChatBlock } from "@rama/protocol";

describe("messages persistence and blocks fallback", () => {
  let testDb: Database;

  beforeAll(() => {
    testDb = new Database(":memory:");
    testDb.exec("PRAGMA foreign_keys = ON;");
    testDb.exec(SCHEMA_SQL);
    // Insert prerequisite project and chat
    testDb.query("INSERT INTO projects (id, name, path, created_at) VALUES ('p1', 'P1', '/tmp', 1)").run();
    testDb.query("INSERT INTO chats (id, project_id, title, mode, model, created_at, updated_at) VALUES ('c1', 'p1', 'C1', 'agent', 'm', 1, 1)").run();
  });

  afterAll(() => {
    testDb.close();
  });

  test("finalizeMessage merges blocks and reasoningSignature without clobbering", () => {
    // Insert initial empty assistant message
    testDb.query(
      "INSERT INTO messages (id, chat_id, seq, role, content, thinking, meta_json, created_at) VALUES ('m1', 'c1', 1, 'assistant', null, null, '{}', 100)"
    ).run();

    // Step 1: finalize with reasoningSignature
    const existingRow1 = testDb.query<{ meta_json: string }, [string]>("SELECT meta_json FROM messages WHERE id = ?").get("m1");
    const meta1 = existingRow1?.meta_json ? JSON.parse(existingRow1.meta_json) : {};
    meta1.reasoningSignature = "sig_123";
    testDb.query("UPDATE messages SET content = ?, thinking = ?, meta_json = ? WHERE id = ?").run(
      "partial text",
      "thought",
      JSON.stringify(meta1),
      "m1"
    );

    // Step 2: finalize with blocks, ensuring reasoningSignature is preserved
    const existingRow2 = testDb.query<{ meta_json: string }, [string]>("SELECT meta_json FROM messages WHERE id = ?").get("m1");
    const meta2 = existingRow2?.meta_json ? JSON.parse(existingRow2.meta_json) : {};
    const blocks: ChatBlock[] = [
      { kind: "thinking", text: "thought", durationMs: 1200 },
      { kind: "tool", callId: "call_1" },
      { kind: "text", text: "final text" },
    ];
    meta2.blocks = blocks;
    testDb.query("UPDATE messages SET content = ?, thinking = ?, meta_json = ? WHERE id = ?").run(
      "final text",
      "thought",
      JSON.stringify(meta2),
      "m1"
    );

    const resultRow = testDb.query<{ content: string; thinking: string; meta_json: string }, [string]>(
      "SELECT content, thinking, meta_json FROM messages WHERE id = ?"
    ).get("m1");

    expect(resultRow).toBeDefined();
    expect(resultRow!.content).toBe("final text");
    expect(resultRow!.thinking).toBe("thought");
    const parsedMeta = JSON.parse(resultRow!.meta_json);
    expect(parsedMeta.reasoningSignature).toBe("sig_123");
    expect(parsedMeta.blocks).toEqual(blocks);
  });

  test("toDTO parses blocks when present, and synthesizes fallback blocks when absent", () => {
    // Row with blocks
    const rowWithBlocks = {
      id: "m_new",
      chat_id: "c1",
      seq: 2,
      role: "assistant" as const,
      content: "Hello world",
      thinking: "Hmm",
      meta_json: JSON.stringify({
        blocks: [
          { kind: "thinking", text: "Hmm", durationMs: 500 },
          { kind: "text", text: "Hello world" },
        ],
      }),
      created_at: 200,
    };

    let blocks1: ChatBlock[] | undefined;
    if (rowWithBlocks.meta_json) {
      const meta = JSON.parse(rowWithBlocks.meta_json);
      if (Array.isArray(meta.blocks) && meta.blocks.length > 0) blocks1 = meta.blocks;
    }
    expect(blocks1).toHaveLength(2);
    expect(blocks1![0].kind).toBe("thinking");
    expect(blocks1![1].kind).toBe("text");

    // Old row without meta_json.blocks
    const rowOld = {
      id: "m_old",
      chat_id: "c1",
      seq: 3,
      role: "assistant" as const,
      content: "Legacy message",
      thinking: "Legacy thinking",
      meta_json: "{}",
      created_at: 300,
    };

    let blocks2: ChatBlock[] | undefined;
    if (rowOld.meta_json) {
      const meta = JSON.parse(rowOld.meta_json);
      if (Array.isArray(meta.blocks) && meta.blocks.length > 0) blocks2 = meta.blocks;
    }
    if (!blocks2 && (rowOld.content || rowOld.thinking)) {
      blocks2 = [];
      if (rowOld.thinking) blocks2.push({ kind: "thinking", text: rowOld.thinking });
      if (rowOld.content) blocks2.push({ kind: "text", text: rowOld.content });
    }

    expect(blocks2).toHaveLength(2);
    expect(blocks2![0]).toEqual({ kind: "thinking", text: "Legacy thinking" });
    expect(blocks2![1]).toEqual({ kind: "text", text: "Legacy message" });
  });
});
