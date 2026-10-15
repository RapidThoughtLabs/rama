import { existsSync, readFileSync, statSync } from "node:fs";
import { extractText, getDocumentProxy } from "unpdf";

// HOME_REDESIGN_PLAN.md Phase HD7 — a PDF's text, for the read tool. Pages are separated by a
// "--- Page N ---" line so the model can say where something is. A Home attachment gets this
// written once, at upload, as a "<name>.txt" sidecar; any other PDF is extracted on read and the
// result kept in memory for as long as the file doesn't change.

export interface PdfText {
  pages: number;
  text: string;
}

export async function extractPdf(bytes: Uint8Array): Promise<PdfText> {
  // pdf.js takes ownership of the buffer it's handed, so give it a copy.
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  const { totalPages, text } = await extractText(doc, { mergePages: false });
  const body = text
    .map((page, i) => `--- Page ${i + 1} ---\n${page.trim()}`)
    .join("\n\n");
  const empty = text.every((page) => !page.trim());
  return {
    pages: totalPages,
    text: empty ? `${body}\n\n(No text could be read from this PDF. It may be a scanned image.)` : body,
  };
}

export function pdfSidecarPath(absPdf: string): string {
  return `${absPdf}.txt`;
}

const cache = new Map<string, { mtimeMs: number; result: PdfText }>();

/** The text of the PDF at `abs`: its sidecar when one exists, otherwise extracted now. */
export async function readPdfText(abs: string): Promise<PdfText> {
  const sidecar = pdfSidecarPath(abs);
  if (existsSync(sidecar)) {
    const text = readFileSync(sidecar, "utf8");
    return { pages: countPages(text), text };
  }
  const { mtimeMs } = statSync(abs);
  const hit = cache.get(abs);
  if (hit && hit.mtimeMs === mtimeMs) return hit.result;
  const result = await extractPdf(readFileSync(abs));
  if (cache.size > 50) cache.delete(cache.keys().next().value!);
  cache.set(abs, { mtimeMs, result });
  return result;
}

function countPages(text: string): number {
  return text.match(/^--- Page \d+ ---$/gm)?.length ?? 0;
}
