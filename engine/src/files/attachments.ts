import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { ATTACHMENT_MAX_BYTES } from "@rama/protocol";
import { insertAttachment, type StoredAttachment } from "../db/attachments";
import { HOME_DIR, homeAttachmentsDir } from "../db/home";
import { newId } from "../db/ids";
import { extractPdf, pdfSidecarPath } from "./pdf";

// HOME_REDESIGN_PLAN.md Phase HD7 — a Home attachment on disk. Each upload gets its own folder,
// ~/.rama/home/attachments/<chatId>/<id>/<name>, so two files with the same name never collide
// and the model (and the "Read lease.pdf" row) still sees the real file name. Everything sits
// inside the home project, which is where Home's read tool is sandboxed.

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
};

/** Image types every vision provider accepts as-is. Anything else (HEIC, TIFF…) is converted. */
const VIEWABLE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Above this, a photo is scaled down before it's sent: providers cap a single image at ~5 MB. */
const VIEW_MAX_BYTES = 3.5 * 1024 * 1024;

export class AttachmentTooLargeError extends Error {}

export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f]/g, "").trim();
  return clean && clean !== "." && clean !== ".." ? clean.slice(0, 200) : "file";
}

export function mimeFor(name: string, given?: string | null): string {
  const byExt = MIME_BY_EXT[extname(name).toLowerCase()];
  if (given && given !== "application/octet-stream") return given;
  return byExt ?? "application/octet-stream";
}

export async function saveHomeAttachment(chatId: string, file: { name: string; type?: string | null; bytes: Uint8Array }): Promise<StoredAttachment> {
  if (file.bytes.byteLength > ATTACHMENT_MAX_BYTES) throw new AttachmentTooLargeError("files can be up to 20 MB");
  const id = newId();
  const name = safeFileName(file.name);
  const mime = mimeFor(name, file.type);
  const dir = join(homeAttachmentsDir(chatId), id);
  mkdirSync(dir, { recursive: true });
  const abs = join(dir, name);
  writeFileSync(abs, file.bytes);

  let pages: number | undefined;
  if (mime === "application/pdf") {
    try {
      const pdf = await extractPdf(file.bytes);
      writeFileSync(pdfSidecarPath(abs), pdf.text);
      pages = pdf.pages;
    } catch (err) {
      // An encrypted or broken PDF still attaches; read will report that it can't be opened.
      console.warn(`[attachments] couldn't read ${name}:`, err instanceof Error ? err.message : err);
    }
  } else if (mime.startsWith("image/")) {
    await makeViewCopy(abs, mime, file.bytes.byteLength);
  }

  return insertAttachment({ id, chatId, name, mime, size: file.bytes.byteLength, pages, path: `attachments/${chatId}/${id}/${name}` });
}

/** The copy of an image that's sent to a vision model, when the original won't do as-is. */
export function viewCopyPath(absImage: string): string {
  return `${absImage}.view.jpg`;
}

// macOS's own `sips` converts HEIC and scales large photos, so no image library is needed. If
// it isn't there or fails, the original is sent and the provider decides.
async function makeViewCopy(abs: string, mime: string, size: number): Promise<void> {
  if (VIEWABLE.has(mime) && size <= VIEW_MAX_BYTES) return;
  try {
    const proc = Bun.spawn(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "80", "-Z", "2048", abs, "--out", viewCopyPath(abs)], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
  } catch {
    // no sips
  }
}

/** A linked image as a data URL for the model, or null if it can't be sent. */
export function imageDataUrl(a: Pick<StoredAttachment, "path" | "mime">): string | null {
  const abs = join(HOME_DIR, a.path);
  try {
    const view = viewCopyPath(abs);
    if (existsSync(view)) return `data:image/jpeg;base64,${readFileSync(view).toString("base64")}`;
    if (!VIEWABLE.has(a.mime)) return null;
    return `data:${a.mime};base64,${readFileSync(abs).toString("base64")}`;
  } catch {
    return null;
  }
}

/** Removes attachments' folders (best-effort; a leftover file must never fail a rewind). */
export function removeAttachmentFiles(paths: readonly string[]): void {
  for (const path of paths) {
    try {
      rmSync(dirname(join(HOME_DIR, path)), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
