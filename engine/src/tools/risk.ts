import type { ToolRisk } from "./types";

// docs/TOOL_LAYER_PLAN.md §5.6 (TL3) — `bash` was blanket `high`, so every `git status` prompted
// in ask mode, training reflexive approval. This classifies per call instead, on a naive
// quote-aware split of the command into pipeline segments (`;`, `&&`, `||`, `|`) — not a real
// shell parser, just enough to keep quoted strings ("fix rm -rf bug") from being mistaken for
// the commands they mention.
export interface CommandSegment {
  raw: string;
  words: string[];
}

export function splitPipeline(cmd: string): CommandSegment[] {
  const segments: CommandSegment[] = [];
  let raw = "";
  let words: string[] = [];
  let word = "";
  let inSingle = false;
  let inDouble = false;

  const pushWord = () => {
    if (word.length > 0) {
      words.push(word);
      word = "";
    }
  };
  const pushSegment = () => {
    pushWord();
    const trimmed = raw.trim();
    if (trimmed.length > 0) segments.push({ raw: trimmed, words });
    raw = "";
    words = [];
  };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    const next = cmd[i + 1];

    if (inSingle) {
      raw += c;
      word += c;
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      raw += c;
      word += c;
      if (c === '"' && cmd[i - 1] !== "\\") inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      raw += c;
      word += c;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      raw += c;
      word += c;
      continue;
    }

    if ((c === "|" && next === "|") || (c === "&" && next === "&")) {
      pushSegment();
      i++;
      continue;
    }
    if (c === ";" || c === "|" || c === "\n") {
      pushSegment();
      continue;
    }
    if (/\s/.test(c)) {
      pushWord();
      raw += c;
      continue;
    }

    raw += c;
    word += c;
  }
  pushSegment();
  return segments;
}

function baseCommand(word: string | undefined): string {
  return (word ?? "").replace(/^.*\//, "");
}

// `FOO=bar git status` — strip leading inline env assignments before classifying.
function stripAssignments(words: string[]): string[] {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
  return words.slice(i);
}

const LOW_RISK_COMMANDS = new Set(["ls", "cat", "pwd", "wc", "head", "tail", "which", "echo", "date"]);

function classifySegment(words: string[]): ToolRisk {
  const rest = stripAssignments(words);
  if (rest.length === 0) return "low"; // e.g. a stray trailing `;`
  const base = baseCommand(rest[0]);
  if (LOW_RISK_COMMANDS.has(base)) return "low";
  if (base === "node" && rest[1] === "-v") return "low";
  if (base === "git" && ["status", "diff", "log", "show"].includes(rest[1] ?? "")) return "low";
  return "high";
}

/** Per §5.6: every segment classified, the maximum wins. Unknown is high — a false `high` costs
 *  one approval, a false `low` costs the user's work. */
export function classifyCommand(cmd: string): ToolRisk {
  const segments = splitPipeline(cmd);
  if (segments.length === 0) return "low";
  return segments.some((s) => classifySegment(s.words) === "high") ? "high" : "low";
}

/** Never worth executing from a model, regardless of `override` — refused with a `ToolResult`,
 *  not silently. Returns the reason, or null if the command doesn't match anything here. */
export function findHardRefusal(cmd: string): string | null {
  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*;?\s*\}\s*;\s*:/.test(cmd)) {
    return "this is a fork bomb";
  }

  const segments = splitPipeline(cmd);
  for (let i = 0; i < segments.length; i++) {
    const rest = stripAssignments(segments[i]!.words);
    const base = baseCommand(rest[0]);
    const args = rest.slice(1);

    if (base === "rm") {
      const flags = args.filter((w) => w.startsWith("-") && !w.startsWith("--")).join("");
      const longFlags = args.filter((w) => w.startsWith("--"));
      const hasR = /r/i.test(flags) || longFlags.includes("--recursive");
      const hasF = /f/.test(flags) || longFlags.includes("--force");
      const targets = args.filter((w) => !w.startsWith("-"));
      if (hasR && hasF && targets.some((t) => /^\/+$/.test(t) || t === "~" || t === "$HOME")) {
        return "rm -rf on the filesystem root or home directory";
      }
    }

    if (base === "dd" && args.some((w) => /^of=\/dev\/(disk|rdisk|sd[a-z]$|hd[a-z]$|nvme\d)/.test(w))) {
      return "dd writing directly to a raw device";
    }

    if (base === "git" && rest[1] === "push") {
      const hasForce = args.some((w) => w === "--force" || w === "-f");
      const hasSafeForce = args.some((w) => w === "--force-with-lease");
      if (hasForce && !hasSafeForce) return "force-push rewrites shared history";
    }

    if ((base === "curl" || base === "wget") && i + 1 < segments.length) {
      const nextBase = baseCommand(stripAssignments(segments[i + 1]!.words)[0]);
      if (["sh", "bash", "zsh", "dash", "python", "python3"].includes(nextBase)) {
        return "piping a remote download straight into a shell";
      }
    }
  }
  return null;
}

export interface ShadowHint {
  tool: string;
  message: string;
}

// Every row from §5.6's table is wired up now that TL4 (git/git_write) and TL5 (check) have
// landed — this covers the full end-state design, not a subset.
export function findShadow(cmd: string): ShadowHint | null {
  const segments = splitPipeline(cmd);
  if (segments.length !== 1) return null; // only redirect a plain single command, not a pipeline
  const rest = stripAssignments(segments[0]!.words);
  const base = baseCommand(rest[0]);
  const args = rest.slice(1);

  if (base === "tsc" && args.includes("--noEmit")) {
    return { tool: "check", message: 'use `check` instead of `bash` for "tsc --noEmit"' };
  }
  if (base === "eslint") {
    return { tool: "check", message: "use `check` instead of `bash` for \"eslint\"" };
  }
  if (base === "vitest") {
    return { tool: "check", message: "use `check` instead of `bash` for \"vitest\"" };
  }
  if (["npm", "yarn", "pnpm", "bun"].includes(base) && rest[1] === "test") {
    return { tool: "check", message: `use \`check\` instead of \`bash\` for "${base} test"` };
  }

  if (base === "git") {
    const sub = rest[1];
    if (["commit", "add", "checkout", "restore"].includes(sub ?? "")) {
      return { tool: "git_write", message: `use \`git_write\` instead of \`bash\` for "git ${sub}"` };
    }
    if (["status", "diff", "log", "show", "blame"].includes(sub ?? "")) {
      return { tool: "git", message: `use \`git\` instead of \`bash\` for "git ${sub}"` };
    }
    return null;
  }

  if (["cat", "head", "tail", "less"].includes(base)) {
    const fileArgs = args.filter((w) => !w.startsWith("-"));
    if (fileArgs.length === 1) {
      return { tool: "read", message: `use \`read\` instead of \`bash\` for "${base}" on a single file — it also marks the file as read` };
    }
    return null;
  }

  if (["mv", "cp", "rm", "mkdir"].includes(base)) {
    return { tool: "file_op", message: `use \`file_op\` instead of \`bash\` for "${base}"` };
  }

  if (base === "sed" && args.includes("-i")) {
    return { tool: "edit", message: 'use `edit` instead of `bash` for "sed -i"' };
  }
  if (base === "perl" && args.some((w) => w === "-pi" || w.startsWith("-pi"))) {
    return { tool: "edit", message: 'use `edit` instead of `bash` for "perl -pi"' };
  }
  if (args.includes(">")) {
    return { tool: "edit", message: "use `edit` (existing file) or `write` (new file) instead of a shell redirect" };
  }

  if (base === "find" && args.includes("-name")) {
    return { tool: "glob", message: 'use `glob` instead of `bash` for "find -name"' };
  }
  if (base === "rg" || (base === "grep" && args.includes("-r"))) {
    return { tool: "grep", message: `use \`grep\` instead of \`bash\` for "${base}"` };
  }

  return null;
}
