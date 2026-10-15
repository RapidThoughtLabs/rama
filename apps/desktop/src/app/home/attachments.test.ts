import { describe, expect, test } from "bun:test";
import { acceptFiles, chipFor, chipForFile, formatSize } from "./attachments";

const file = (name: string, size: number, type = "") => {
  const f = new File([new Uint8Array(0)], name, { type, lastModified: 1 });
  Object.defineProperty(f, "size", { value: size });
  return f;
};

describe("chips", () => {
  test("sent files read the way the mockup does", () => {
    expect(chipFor({ id: "1", name: "lease-2026-draft.pdf", mime: "application/pdf", size: 1, pages: 14 })).toEqual({ icon: "doc", name: "lease-2026-draft.pdf", meta: "PDF, 14 pages" });
    expect(chipFor({ id: "2", name: "one.pdf", mime: "application/pdf", size: 1, pages: 1 }).meta).toBe("PDF, 1 page");
    expect(chipFor({ id: "3", name: "fridge.jpg", mime: "image/jpeg", size: 1 })).toEqual({ icon: "image", name: "fridge.jpg", meta: "Photo" });
    expect(chipFor({ id: "4", name: "notes.txt", mime: "text/plain", size: 2048 }).meta).toBe("TXT, 2 KB");
  });

  test("a waiting file shows its size; a photo just says Photo", () => {
    expect(chipForFile(file("lease.pdf", 2.5 * 1024 * 1024, "application/pdf")).meta).toBe("PDF, 2.5 MB");
    expect(chipForFile(file("IMG_0042.HEIC", 3_000_000)).meta).toBe("Photo");
    expect(formatSize(900)).toBe("900 B");
  });
});

describe("acceptFiles", () => {
  test("keeps up to 5, skips duplicates, and refuses files over 20 MB", () => {
    const a = file("a.txt", 10);
    expect(acceptFiles([a], [a])).toEqual({ files: [a], notice: null });
    const big = file("huge.mov", 21 * 1024 * 1024);
    expect(acceptFiles([], [big]).notice).toBe("huge.mov is over 20 MB, so it wasn't added.");
    const six = Array.from({ length: 6 }, (_, i) => file(`${i}.txt`, i + 1));
    const r = acceptFiles([], six);
    expect(r.files).toHaveLength(5);
    expect(r.notice).toBe("You can attach up to 5 files at a time.");
  });
});
