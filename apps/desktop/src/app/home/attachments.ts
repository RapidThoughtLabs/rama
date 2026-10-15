import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_TURN, type AttachmentDTO } from "@rama/protocol";
import type { AttachmentChip } from "@rama/ui";

/* Home attachments in the composer and on the transcript — HOME_REDESIGN_PLAN.md Phase HD7. The
   chip text (mock:L1608: "PDF, 14 pages", "Photo") and the per-turn limits. Pure, so it's
   unit-tested (attachments.test.ts). */

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?)$/i;

export const isImage = (f: { name: string; type?: string; mime?: string }) => (f.mime ?? f.type ?? "").startsWith("image/") || IMAGE_EXT.test(f.name);

const extOf = (name: string) => (name.includes(".") ? name.split(".").pop()!.toUpperCase() : "File");

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A sent file, as the transcript shows it above the bubble. */
export function chipFor(a: AttachmentDTO): AttachmentChip {
  if (isImage(a)) return { icon: "image", name: a.name, meta: "Photo" };
  if (a.mime === "application/pdf") return { icon: "doc", name: a.name, meta: a.pages ? `PDF, ${a.pages} page${a.pages === 1 ? "" : "s"}` : "PDF" };
  return { icon: "doc", name: a.name, meta: `${extOf(a.name)}, ${formatSize(a.size)}` };
}

/** A file waiting in the composer. Its page count isn't known until the engine has read it. */
export function chipForFile(f: File): AttachmentChip {
  if (isImage(f)) return { icon: "image", name: f.name, meta: "Photo" };
  return { icon: "doc", name: f.name, meta: `${f.type === "application/pdf" || /\.pdf$/i.test(f.name) ? "PDF" : extOf(f.name)}, ${formatSize(f.size)}` };
}

/** Adds picked or dropped files to the ones waiting, within the limits: up to 20 MB each and 5
 *  per message. The same file twice is kept once. `notice` says what was left out, if anything. */
export function acceptFiles(current: readonly File[], incoming: readonly File[]): { files: File[]; notice: string | null } {
  const files = [...current];
  let tooBig: string | null = null;
  let overCount = false;
  for (const f of incoming) {
    if (files.some((x) => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified)) continue;
    if (f.size > ATTACHMENT_MAX_BYTES) {
      tooBig ??= f.name;
      continue;
    }
    if (files.length >= ATTACHMENTS_PER_TURN) {
      overCount = true;
      continue;
    }
    files.push(f);
  }
  const notice = tooBig ? `${tooBig} is over 20 MB, so it wasn't added.` : overCount ? `You can attach up to ${ATTACHMENTS_PER_TURN} files at a time.` : null;
  return { files, notice };
}
