import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BLOBS_DIR } from "./db/index";

// Content-addressed blob store (~/.rama/blobs/<sha256>) — per the locked architecture
// decision, large artifact bodies live on disk, deduped by hash, not in SQLite.
export function writeBlob(content: string): { hash: string; size: number } {
  const hash = new Bun.CryptoHasher("sha256").update(content).digest("hex");
  const path = join(BLOBS_DIR, hash);
  if (!existsSync(path)) writeFileSync(path, content);
  return { hash, size: Buffer.byteLength(content) };
}

export function readBlob(hash: string): string {
  return readFileSync(join(BLOBS_DIR, hash), "utf8");
}
