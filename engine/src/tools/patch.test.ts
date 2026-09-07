// The repo's first test file (docs/TOOL_LAYER_PLAN.md §8.1) — patch.ts is pure and synchronous,
// so it needs no fixture project, filesystem, or DB.

import { describe, expect, test } from "bun:test";
import { applyEdits } from "./patch";

describe("applyEdits", () => {
  test("exact match, unique", () => {
    const out = applyEdits("const a = 1;\nconst b = 2;\n", [{ oldString: "const a = 1;", newString: "const a = 2;" }]);
    expect(out.ok).toBe(true);
    expect(out.content).toBe("const a = 2;\nconst b = 2;\n");
    expect(out.applied).toBe(1);
  });

  test("non-unique without replaceAll fails", () => {
    const out = applyEdits("x\nx\n", [{ oldString: "x", newString: "y" }]);
    expect(out.ok).toBe(false);
    expect(out.failure?.reason).toBe("not_unique");
    expect(out.failure?.occurrences).toBe(2);
    expect(out.content).toBeUndefined();
  });

  test("non-unique with replaceAll applies to all occurrences", () => {
    const out = applyEdits("x\nx\n", [{ oldString: "x", newString: "y", replaceAll: true }]);
    expect(out.ok).toBe(true);
    expect(out.content).toBe("y\ny\n");
  });

  test("indentation-tolerant recovery re-anchors to original bytes, writes newString as given", () => {
    const original = "function f() {\n    const a = 1;\n    return a;\n}\n";
    const out = applyEdits(original, [
      { oldString: "  const a = 1;\n  return a;", newString: "    const a = 2;\n    return a;" },
    ]);
    expect(out.ok).toBe(true);
    expect(out.content).toBe("function f() {\n    const a = 2;\n    return a;\n}\n");
  });

  test("indentation tolerance does not fire when more than one region matches loosely", () => {
    const original = "if (a) {\n  x();\n}\nif (b) {\n  x();\n}\n";
    const out = applyEdits(original, [{ oldString: "    x();", newString: "  y();" }]);
    expect(out.ok).toBe(false);
    expect(out.failure?.reason).toBe("not_found");
  });

  test("CRLF line endings preserved", () => {
    const original = "a\r\nb\r\nc\r\n";
    const out = applyEdits(original, [{ oldString: "b", newString: "bb" }]);
    expect(out.ok).toBe(true);
    expect(out.content).toBe("a\r\nbb\r\nc\r\n");
  });

  test("UTF-8 BOM preserved", () => {
    const original = "﻿a\nb\n";
    const out = applyEdits(original, [{ oldString: "a", newString: "aa" }]);
    expect(out.ok).toBe(true);
    expect(out.content).toBe("﻿aa\nb\n");
  });

  test("trailing newline absence preserved", () => {
    const out = applyEdits("a\nb", [{ oldString: "b", newString: "bb" }]);
    expect(out.content).toBe("a\nbb");
  });

  test("trailing newline presence preserved", () => {
    const out = applyEdits("a\nb\n", [{ oldString: "b", newString: "bb" }]);
    expect(out.content).toBe("a\nbb\n");
  });

  test("multi-edit atomicity: failure on the last edit writes nothing", () => {
    const original = "one\ntwo\nthree\n";
    const out = applyEdits(original, [
      { oldString: "one", newString: "ONE" },
      { oldString: "two", newString: "TWO" },
      { oldString: "nonexistent", newString: "x" },
    ]);
    expect(out.ok).toBe(false);
    expect(out.applied).toBe(0);
    expect(out.content).toBeUndefined();
    expect(out.failure?.index).toBe(2);
  });

  test("multi-edit applies all in order on success", () => {
    const original = "one\ntwo\nthree\n";
    const out = applyEdits(original, [
      { oldString: "one", newString: "ONE" },
      { oldString: "two", newString: "TWO" },
    ]);
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(2);
    expect(out.content).toBe("ONE\nTWO\nthree\n");
  });

  test("nearest match computed on not_found", () => {
    const original = "function foo() {\n  return 1;\n}\n";
    const out = applyEdits(original, [{ oldString: "  return 2;", newString: "  return 3;" }]);
    expect(out.ok).toBe(false);
    expect(out.failure?.reason).toBe("not_found");
    expect(out.failure?.nearest?.line).toBe(2);
  });

  test("no nearest suggestion when nothing is remotely similar", () => {
    const original = "completely unrelated content\nabout something else entirely\n";
    const out = applyEdits(original, [{ oldString: "zzzzzzzzzzzzzzzzzzzz", newString: "x" }]);
    expect(out.ok).toBe(false);
    expect(out.failure?.nearest).toBeUndefined();
  });

  test("empty oldString fails without touching the file", () => {
    const out = applyEdits("abc", [{ oldString: "", newString: "x" }]);
    expect(out.ok).toBe(false);
    expect(out.failure?.reason).toBe("empty_old_string");
  });
});
