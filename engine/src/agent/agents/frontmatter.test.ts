import { describe, expect, test } from "bun:test";
import { parseAgentMd } from "./frontmatter";

describe("parseAgentMd", () => {
  test("parses name/description/mode/model and a bracketed tools list", () => {
    const fm = parseAgentMd(
      `---\nname: reviewer\ndescription: Reviews a diff.\ntools: [read, glob, grep]\nmode: plan\nmodel: chat\n---\n\nBody text here.`,
    );
    expect(fm.name).toBe("reviewer");
    expect(fm.description).toBe("Reviews a diff.");
    expect(fm.tools).toEqual(["read", "glob", "grep"]);
    expect(fm.mode).toBe("plan");
    expect(fm.model).toBe("chat");
    expect(fm.body).toBe("Body text here.");
  });

  test("a bare comma list works the same as brackets", () => {
    const fm = parseAgentMd(`---\ntools: read, glob , grep\n---\nbody`);
    expect(fm.tools).toEqual(["read", "glob", "grep"]);
  });

  test("no frontmatter at all — the whole content is the body", () => {
    const fm = parseAgentMd("Just a plain markdown file, no frontmatter.");
    expect(fm.name).toBeUndefined();
    expect(fm.tools).toBeUndefined();
    expect(fm.body).toBe("Just a plain markdown file, no frontmatter.");
  });

  test("no tools field means unrestricted (undefined, not an empty array)", () => {
    const fm = parseAgentMd(`---\nname: default\n---\nbody`);
    expect(fm.tools).toBeUndefined();
  });

  test("quoted scalar values are unquoted", () => {
    const fm = parseAgentMd(`---\nname: "default"\ndescription: 'no narrowing'\n---\nbody`);
    expect(fm.name).toBe("default");
    expect(fm.description).toBe("no narrowing");
  });
});
