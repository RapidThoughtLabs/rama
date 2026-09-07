import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// docs/TOOL_LAYER_PLAN.md §5.4 (TL5) — "a `## Commands` block in RAMA.md (H2) > package.json
// scripts > detection by lockfile/config presence." H2 (the harness plan's own RAMA.md phase)
// hasn't landed yet, so there's no existing writer/reader for this file to match — this defines
// the simplest workable shape (`kind: shell command`, one per line under the heading) so a
// project can opt in today without waiting on H2, and can be migrated later if H2 lands with a
// different convention.
export type CheckKind = "typecheck" | "lint" | "test" | "build";

export interface ResolvedCommands {
  typecheck: string[] | null;
  lint: string[] | null;
  test: string[] | null;
  build: string[] | null;
}

interface CacheEntry {
  configKey: string;
  commands: ResolvedCommands;
}

const cache = new Map<string, CacheEntry>();

// A single "latest mtime" number can't distinguish "RAMA.md doesn't exist yet" from "RAMA.md was
// just created in the same millisecond package.json last changed" — on a fast filesystem those
// collide and the cache would miss the invalidation. Keying on each file's own existence+mtime
// instead makes a create/delete always change the key, regardless of timestamp resolution.
function configCacheKey(projectPath: string): string {
  return ["RAMA.md", "package.json"]
    .map((name) => {
      try {
        return `${name}:${statSync(join(projectPath, name)).mtimeMs}`;
      } catch {
        return `${name}:-`;
      }
    })
    .join("|");
}

function detectPackageManager(projectPath: string): "bun" | "pnpm" | "yarn" | "npm" {
  if (existsSync(join(projectPath, "bun.lockb")) || existsSync(join(projectPath, "bun.lock"))) return "bun";
  if (existsSync(join(projectPath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(projectPath, "yarn.lock"))) return "yarn";
  return "npm";
}

// The internal layer never touches the network (§1) — a bare `npx`/`bunx` invocation for a tool
// that isn't installed can silently fetch one. Only ever resolve to a binary that's actually
// present in node_modules/.bin already; if it isn't, that check is reported as unavailable rather
// than attempted.
function resolveBinary(projectPath: string, name: string): string[] | null {
  const bin = join(projectPath, "node_modules", ".bin", name);
  return existsSync(bin) ? [bin] : null;
}

function parseRamaMdCommands(projectPath: string): Partial<Record<CheckKind, string[]>> {
  const path = join(projectPath, "RAMA.md");
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  const headingIdx = text.search(/^##\s+Commands\s*$/m);
  if (headingIdx === -1) return {};
  const headingLineEnd = text.indexOf("\n", headingIdx);
  const body = headingLineEnd === -1 ? "" : text.slice(headingLineEnd + 1);
  const nextHeadingIdx = body.search(/^#{1,6}\s+/m);
  const block = nextHeadingIdx === -1 ? body : body.slice(0, nextHeadingIdx);

  const kinds: CheckKind[] = ["typecheck", "lint", "test", "build"];
  const result: Partial<Record<CheckKind, string[]>> = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^\s*(\w+)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    if (!kinds.includes(key as CheckKind)) continue;
    const parts = m[2]!.trim().split(/\s+/);
    if (parts.length > 0) result[key as CheckKind] = parts;
  }
  return result;
}

function packageJsonScripts(projectPath: string): Record<string, string> {
  const path = join(projectPath, "package.json");
  if (!existsSync(path)) return {};
  try {
    const pkg = JSON.parse(readFileSync(path, "utf8")) as { scripts?: Record<string, string> };
    return pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  } catch {
    return {};
  }
}

function scriptCommand(projectPath: string, scripts: Record<string, string>, names: string[]): string[] | null {
  const pm = detectPackageManager(projectPath);
  for (const name of names) {
    if (name in scripts) return [pm, "run", name];
  }
  return null;
}

function detectTypecheck(projectPath: string): string[] | null {
  if (!existsSync(join(projectPath, "tsconfig.json"))) return null;
  const bin = resolveBinary(projectPath, "tsc");
  // --pretty false is load-bearing for parsers.ts's parseTsc — the pretty form is multi-line and
  // colorized, and this is the one path where we control the invocation and can guarantee it.
  return bin ? [...bin, "--noEmit", "--pretty", "false"] : null;
}

// Deliberately eslint-only, not biome — biome's JSON reporter gives byte-offset spans, not
// line/column, and mapping those back to line numbers needs the source text at parse time (more
// machinery than this phase budgets for). A biome-only project reports lint as unavailable rather
// than showing fabricated line numbers; wire biome up properly if this turns out to matter.
function detectLint(projectPath: string): string[] | null {
  const eslintConfigs = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", ".eslintrc", ".eslintrc.json", ".eslintrc.js", ".eslintrc.yml", ".eslintrc.yaml"];
  if (!eslintConfigs.some((f) => existsSync(join(projectPath, f)))) return null;
  const bin = resolveBinary(projectPath, "eslint");
  return bin ? [...bin, ".", "--format", "json"] : null;
}

function detectTest(projectPath: string): string[] | null {
  if (["vitest.config.ts", "vitest.config.js", "vitest.config.mjs"].some((f) => existsSync(join(projectPath, f)))) {
    const bin = resolveBinary(projectPath, "vitest");
    if (bin) return [...bin, "run"];
  }
  if (["jest.config.js", "jest.config.ts", "jest.config.mjs", "jest.config.cjs"].some((f) => existsSync(join(projectPath, f)))) {
    const bin = resolveBinary(projectPath, "jest");
    if (bin) return bin;
  }
  // bun itself is the runtime this engine already runs on — never a network fetch, so it's a
  // safe default when nothing more specific was detected and the project has bun test files.
  if (existsSync(join(projectPath, "bun.lockb")) || existsSync(join(projectPath, "bun.lock"))) return ["bun", "test"];
  return null;
}

const SCRIPT_NAMES: Record<CheckKind, string[]> = {
  typecheck: ["typecheck", "type-check"],
  lint: ["lint"],
  test: ["test"],
  build: ["build"],
};

function resolveOne(kind: CheckKind, projectPath: string, ramaCmds: Partial<Record<CheckKind, string[]>>, scripts: Record<string, string>): string[] | null {
  if (ramaCmds[kind]) return ramaCmds[kind]!;
  const fromScript = scriptCommand(projectPath, scripts, SCRIPT_NAMES[kind]);
  if (fromScript) return fromScript;
  if (kind === "typecheck") return detectTypecheck(projectPath);
  if (kind === "lint") return detectLint(projectPath);
  if (kind === "test") return detectTest(projectPath);
  return null; // build has no non-script auto-detection — too many possible tools to guess safely
}

export function resolveCommands(projectPath: string): ResolvedCommands {
  const configKey = configCacheKey(projectPath);
  const cached = cache.get(projectPath);
  if (cached && cached.configKey === configKey) return cached.commands;

  const ramaCmds = parseRamaMdCommands(projectPath);
  const scripts = packageJsonScripts(projectPath);
  const commands: ResolvedCommands = {
    typecheck: resolveOne("typecheck", projectPath, ramaCmds, scripts),
    lint: resolveOne("lint", projectPath, ramaCmds, scripts),
    test: resolveOne("test", projectPath, ramaCmds, scripts),
    build: resolveOne("build", projectPath, ramaCmds, scripts),
  };
  cache.set(projectPath, { configKey, commands });
  return commands;
}
