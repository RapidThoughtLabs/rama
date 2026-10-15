import { describe, expect, test } from "bun:test";
import { toUnified } from "./artifactDiff";
import { parseHunks } from "../workspace/Diff";

const file = (n: number) => Array.from({ length: n }, (_, i) => ` line ${i + 1}`);

describe("toUnified", () => {
  test("keeps three lines of context around one change", () => {
    const lines = file(20);
    lines[9] = "-line 10";
    lines.splice(10, 0, "+line ten");
    const out = toUnified(lines.join("\n"));
    expect(out.split("\n")[0]).toBe("@@ -7,7 +7,7 @@");
    expect(out.split("\n")).toHaveLength(1 + 3 + 2 + 3);
  });
  test("two far-apart changes are two hunks, near ones merge", () => {
    const far = file(40);
    far[2] = "+a";
    far[30] = "+b";
    expect(toUnified(far.join("\n")).match(/^@@/gm)).toHaveLength(2);
    const near = file(20);
    near[5] = "+a";
    near[9] = "+b";
    expect(toUnified(near.join("\n")).match(/^@@/gm)).toHaveLength(1);
  });
  test("line numbers follow additions and removals", () => {
    const text = [" a", " b", "-c", "+C", "+D", " e", " f", " g", " h"].join("\n");
    const hunks = parseHunks(toUnified(text));
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.rows.map((r) => [r.oldNum, r.newNum])).toEqual([[1, 1], [2, 2], [3, null], [null, 3], [null, 4], [4, 5], [5, 6], [6, 7]]);
  });
  test("a brand-new file is one hunk starting at line 1", () => {
    const out = toUnified(["+a", "+b", "+c"].join("\n"));
    expect(out.split("\n")[0]).toBe("@@ -0,0 +1,3 @@");
    expect(parseHunks(out)[0]!.title).toBe("New file");
  });
  test("text that already has headers passes through, and no change is nothing", () => {
    const withHeaders = "@@ -1,2 +1,2 @@ function f(\n a\n-b\n+c";
    expect(toUnified(withHeaders)).toBe(withHeaders);
    expect(toUnified(file(5).join("\n"))).toBe("");
  });
});
