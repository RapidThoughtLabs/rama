// HOME_REDESIGN_PLAN.md Phase HD7 — Home attachments: storing an upload (and a PDF's text), linking
// it to a turn, what the model is told about it, and Try again keeping it. Like home.test.ts this
// runs against the real ~/.rama/rama.db; the chat and its folder are removed in afterAll.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildTranscriptFromDb, project } from "../agent/run/transcript";
import { linkAttachments } from "../db/attachments";
import { deleteChat } from "../db/chats";
import { HOME_DIR, HOME_PROJECT_ID, createHomeChat, ensureHomeProject, homeAttachmentsDir, removeHomeChatFiles } from "../db/home";
import { appendMessage, listMessages, rewindToUserTurn } from "../db/messages";
import { AttachmentTooLargeError, safeFileName, saveHomeAttachment } from "./attachments";
import { readPdfText } from "./pdf";
import { createReadTool } from "../tools/read";
import type { ToolCtx, ToolResult } from "../tools/types";

/** A real (tiny) PDF, one line of Helvetica per page. */
export function makePdf(pages: string[]): Uint8Array {
  const objs: string[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((text, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
    objs[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objs[5 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)
    .join("")}`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

// 1×1 transparent PNG.
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), (c) => c.charCodeAt(0));

describe("Home attachments", () => {
  let chatId: string;

  beforeAll(() => {
    ensureHomeProject();
    chatId = createHomeChat({ providerId: "ollama", model: "qwen3:14b" }).id;
  });

  afterAll(() => {
    deleteChat(chatId);
    removeHomeChatFiles(chatId);
  });

  test("a PDF is stored with its page count and a text sidecar, unlinked until sent", async () => {
    const a = await saveHomeAttachment(chatId, { name: "lease.pdf", type: "application/pdf", bytes: makePdf(["Rent is 2400 a month.", "Deposit is two months."]) });
    expect(a.pages).toBe(2);
    expect(a.messageId).toBeNull();
    expect(a.path).toBe(`attachments/${chatId}/${a.id}/lease.pdf`);
    const abs = join(HOME_DIR, a.path);
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(`${abs}.txt`, "utf8")).toBe("--- Page 1 ---\nRent is 2400 a month.\n\n--- Page 2 ---\nDeposit is two months.");
    expect(await readPdfText(abs)).toEqual({ pages: 2, text: readFileSync(`${abs}.txt`, "utf8") });
    // Nothing shows on the transcript until a turn carries it.
    expect(listMessages(chatId).some((m) => m.attachments)).toBe(false);
  });

  test("a sent turn carries its files, and the model is told where they are", async () => {
    const pdf = await saveHomeAttachment(chatId, { name: "notes.pdf", type: "application/pdf", bytes: makePdf(["One page."]) });
    const png = await saveHomeAttachment(chatId, { name: "photo.png", type: "image/png", bytes: PNG });
    const user = appendMessage(chatId, { role: "user", content: "What does this say?" });
    expect(linkAttachments(chatId, user.id, [pdf.id, png.id, "not-an-upload"]).map((a) => a.name)).toEqual(["notes.pdf", "photo.png"]);
    // Linking twice does nothing.
    expect(linkAttachments(chatId, user.id, [pdf.id])).toHaveLength(0);

    const row = listMessages(chatId).find((m) => m.id === user.id)!;
    expect(row.attachments).toEqual([
      { id: pdf.id, name: "notes.pdf", mime: "application/pdf", size: pdf.size, pages: 1 },
      { id: png.id, name: "photo.png", mime: "image/png", size: PNG.byteLength },
    ]);

    // A model that can't see images: a pointer for each file, text only.
    const blind = buildTranscriptFromDb(chatId).entries.find((e) => e.kind === "user" && e.id === user.id);
    expect(blind).toMatchObject({ kind: "user" });
    const blindText = (blind as { text: string }).text;
    expect(blindText).toStartWith("What does this say?\n\nAttached: notes.pdf (PDF, 1 page). Read it with read path ");
    expect(blindText).toContain(`"attachments/${chatId}/${pdf.id}/notes.pdf"`);
    expect(blindText).toContain("Attached: photo.png (photo). You can't see images with the current model");
    expect((blind as { images?: string[] }).images).toBeUndefined();

    // A vision model: the photo goes out as an image part after the text.
    const seeing = buildTranscriptFromDb(chatId, { vision: true });
    const wire = project(seeing, { cacheStyle: "none", supportsMidConversationSystem: true });
    const msg = wire.find((w) => w.role === "user" && Array.isArray(w.content))!;
    const parts = msg.content as { type: string; text?: string; image_url?: { url: string } }[];
    expect(parts.map((p) => p.type)).toEqual(["text", "image_url"]);
    expect(parts[0]!.text).toContain("Attached: photo.png (photo, included with this message)");
    expect(parts[1]!.image_url!.url).toStartWith("data:image/png;base64,");
  });

  test("Try again keeps the retried turn's files for the re-run and drops later turns' files", async () => {
    const later = await saveHomeAttachment(chatId, { name: "later.txt", type: "text/plain", bytes: new TextEncoder().encode("hi") });
    appendMessage(chatId, { role: "assistant", content: "It says one page." });
    const next = appendMessage(chatId, { role: "user", content: "And this?" });
    linkAttachments(chatId, next.id, [later.id]);

    const users = listMessages(chatId).filter((m) => m.role === "user");
    const first = users.find((m) => m.attachments?.length === 2)!;
    const turn = users.indexOf(first);
    const rewound = rewindToUserTurn(chatId, turn)!;
    expect(rewound.text).toBe("What does this say?");
    expect(rewound.attachmentIds).toEqual(first.attachments!.map((a) => a.id));
    expect(rewound.removedPaths).toEqual([`attachments/${chatId}/${later.id}/later.txt`]);
    // The kept files can go on the re-run.
    const rerun = appendMessage(chatId, { role: "user", content: rewound.text });
    expect(linkAttachments(chatId, rerun.id, rewound.attachmentIds)).toHaveLength(2);
  });

  test("a turn of files alone can be tried again", async () => {
    const a = await saveHomeAttachment(chatId, { name: "only.txt", type: null, bytes: new TextEncoder().encode("x") });
    expect(a.mime).toBe("text/plain");
    const user = appendMessage(chatId, { role: "user", content: "" });
    linkAttachments(chatId, user.id, [a.id]);
    expect(rewindToUserTurn(chatId)).toEqual({ text: "", attachmentIds: [a.id], removedPaths: [] });
  });

  test("Home's read tool reads an attached PDF as its text and reports the page count", async () => {
    const a = await saveHomeAttachment(chatId, { name: "lease-2026-draft.pdf", type: "application/pdf", bytes: makePdf(["Page one.", "Page two.", "Page three."]) });
    const tool = createReadTool({ chatId, projectId: HOME_PROJECT_ID, projectPath: HOME_DIR, extraRoots: [], mode: "agent" } as unknown as ToolCtx);
    expect(tool.description).toStartWith("Read a file the user attached");
    const result = (await tool.execute!({ path: a.path }, { toolCallId: "t1" } as never)) as ToolResult;
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("1-8 of 8 lines · 3 pages");
    expect(result.content).toContain("   7| --- Page 3 ---");
  });

  test("names are kept to one safe path segment, and big files are refused", async () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("..")).toBe("file");
    expect(safeFileName("a\u0000b.txt")).toBe("ab.txt");
    await expect(saveHomeAttachment(chatId, { name: "big.bin", bytes: new Uint8Array(20 * 1024 * 1024 + 1) })).rejects.toBeInstanceOf(AttachmentTooLargeError);
    expect(homeAttachmentsDir(chatId)).toBe(join(HOME_DIR, "attachments", chatId));
  });
});
