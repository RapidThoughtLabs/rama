import type { ArtifactDTO, ToolCallDTO } from "@rama/protocol";
import type { IconName } from "@rama/ui";

/* Code's plain-language activity rows — docs/CODE_REDESIGN_PLAN.md CR6, the tool→row table. A run of
   tool calls becomes rows in words a person would use ("Edited theme.tsx", "Ran bun test"); tool
   names never reach the transcript. Pure (no React), so it is unit-tested (rows.test.ts); the
   components in TranscriptView.tsx only draw what these models say.

   `label` is a list of segments so the bold, italic and code parts the mockup draws (`<b>name</b>`)
   stay data rather than markup. */

export type Seg = string | { b: string } | { i: string } | { code: string } | { path: string };
export type Tone = "plus" | "minus" | "ok" | "fail" | "good" | "accent";
export interface MetaPart {
  text: string;
  tone?: Tone;
}
export type BodyPart =
  | { k: "text"; text: string }
  /** The mockup's `.files` list: a verb in muted type, then what it did. */
  | { k: "list"; items: { verb: string; what: Seg[] }[] }
  /** The call's artifact, drawn by kind: a diff card, an output card, or plain text. */
  | { k: "artifact"; artifactId: string | null; fallback?: string }
  /** "Open in Changes →" */
  | { k: "link"; goto: string; label: string };

export interface RowModel {
  key: string;
  icon: IconName;
  label: Seg[];
  /** The label as one string, for the tooltip when it was shortened. */
  title?: string;
  meta: MetaPart[];
  body: BodyPart[];
  status: "running" | "ok" | "fail";
  callIds: string[];
  /** The row is the live tail of a run: it opens by itself and closes when the call finishes. */
  live: boolean;
}

export interface RowCtx {
  artifacts: ReadonlyMap<string, ArtifactDTO>;
  terminalTitle?: (id: string) => string | undefined;
  /** The Web pane's current host, carried across calls: `browser open` sets it, later actions read it. */
  state: { host?: string };
}

const obj = <T,>(input: unknown): T => (input && typeof input === "object" ? input : {}) as T;
const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|svg)$/i;

export function hostOf(url: string): string {
  try {
    return new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export const MUTATING = new Set(["write", "edit", "file_op", "git_write", "patch", "test"]);
const EXPLORE = new Set(["read", "grep", "glob", "tree", "outline", "git"]);
const BROWSER_ACTIONS = new Set(["read", "snapshot", "console", "click", "type", "press", "scroll"]);

/** Calls that draw nothing as a row: `todo` feeds the plan card, `clarify` is its own card. */
export const isHidden = (c: Pick<ToolCallDTO, "name">) => c.name === "todo" || c.name === "clarify";

type Kind = "explore" | "browser-action" | "single";
function kindOf(c: ToolCallDTO): Kind {
  if (EXPLORE.has(c.name)) return "explore";
  if (c.name === "browser" && BROWSER_ACTIONS.has(obj<{ op?: string }>(c.input).op ?? "")) return "browser-action";
  return "single";
}

/** Consecutive calls → rows. Explore calls collapse into one "Looked through N files" row, and so do
 *  browser actions; everything else is one row per call. */
export function rowsFor(calls: ToolCallDTO[], ctx: RowCtx): RowModel[] {
  const rows: RowModel[] = [];
  let run: ToolCallDTO[] = [];
  let runKind: Kind | null = null;
  const flush = () => {
    if (!run.length) return;
    rows.push(runKind === "explore" ? exploreRow(run) : browserActionsRow(run, ctx));
    run = [];
    runKind = null;
  };
  for (const c of calls) {
    if (isHidden(c)) continue;
    const kind = kindOf(c);
    if (kind === "single") {
      flush();
      rows.push(singleRow(c, ctx));
      continue;
    }
    if (runKind && runKind !== kind) flush();
    runKind = kind;
    run.push(c);
  }
  flush();
  return rows;
}

const statusOf = (calls: ToolCallDTO[]): RowModel["status"] => (calls.some((c) => c.ok === null) ? "running" : calls.some((c) => c.ok === false) ? "fail" : "ok");

function make(calls: ToolCallDTO[], r: Omit<RowModel, "key" | "status" | "callIds" | "meta" | "body" | "live" | "title"> & Partial<Pick<RowModel, "meta" | "body" | "title">>): RowModel {
  const status = statusOf(calls);
  return { key: calls[0]!.id, status, callIds: calls.map((c) => c.id), meta: [], body: [], live: status === "running", ...r };
}

/** The meta every failed call shares: the reason, in the bad colour. */
function failMeta(c: ToolCallDTO): MetaPart {
  const s = c.resultSummary ?? "";
  if (/^refused/i.test(s)) return { text: "refused", tone: "fail" };
  if (/timed out/i.test(s)) return { text: "timed out", tone: "fail" };
  const exit = s.match(/^exit (\d+)/);
  if (exit) return { text: `exit ${exit[1]}`, tone: "fail" };
  return { text: "failed", tone: "fail" };
}

const delta = (summary: string): MetaPart[] => {
  const m = summary.match(/^\+(\d+) −(\d+)$/);
  if (!m) return [];
  return [{ text: `+${m[1]}`, tone: "plus" }, ...(Number(m[2]) ? [{ text: `−${m[2]}`, tone: "minus" as const }] : [])];
};

/* ═══ Explore: read, grep, glob, tree, outline, git ═══ */

interface ReadIn { path?: string }

function exploreRow(calls: ToolCallDTO[]): RowModel {
  const reads = calls.filter((c) => c.name === "read");
  const paths = [...new Set(reads.map((c) => obj<ReadIn>(c.input).path ?? "").filter(Boolean))];
  // A glob's matches count as files looked through (mock:L1385); grep, tree, outline and git are searches.
  const globs = calls.filter((c) => c.name === "glob");
  const listed = globs.reduce((n, c) => n + Number(c.resultSummary?.match(/^(\d+) files? matched/)?.[1] ?? 0), 0);
  const searches = calls.length - reads.length - globs.length;
  const files = paths.length + listed;
  const running = calls.some((c) => c.ok === null);

  const items = calls.map((c) => {
    const failed = c.ok === false;
    const i = obj<{ path?: string; pattern?: string; op?: string }>(c.input);
    const s = c.resultSummary ?? "";
    switch (c.name) {
      case "read":
        return { verb: failed ? "Couldn't read" : "Read", what: [{ path: i.path ?? "" }] as Seg[] };
      case "grep":
        return { verb: "Searched", what: ["for ", { code: i.pattern ?? "" }, ...(failed || !s ? [] : [`, ${s.replace(" across ", " in ")}`])] as Seg[] };
      case "glob":
        return { verb: "Listed", what: [{ code: i.pattern ?? "" }, ...(failed || !s ? [] : [`, ${s.replace(/ matched.*/, "")}`])] as Seg[] };
      case "tree":
        return { verb: "Listed", what: [{ code: i.path || "the project" }, ...(s ? [`, ${s}`] : [])] as Seg[] };
      case "outline":
        return { verb: "Outlined", what: [{ path: i.path ?? "" }] as Seg[] };
      default:
        return { verb: "Checked", what: [{ code: `git ${i.op ?? ""}`.trim() }, ...(s ? [`, ${s}`] : [])] as Seg[] };
    }
  });
  const body: BodyPart[] = [{ k: "list", items }];

  // One read: "Read name", with its length. Otherwise "Looked through N files" (or a search label).
  if (reads.length === 1 && calls.length === 1) {
    const c = reads[0]!;
    const path = obj<ReadIn>(c.input).path ?? "";
    const file = base(path) || "a file";
    const s = c.resultSummary ?? "";
    const lines = s.match(/of (\d+) lines?/);
    const pages = s.match(/(\d+) pages?/);
    const image = IMAGE_EXT.test(path);
    const verb = running ? (image ? "Looking at" : "Reading") : c.ok === false ? "Couldn't read" : image ? "Looked at" : "Read";
    return make(calls, {
      icon: image ? "image" : "search",
      label: [`${verb} `, { b: file }],
      meta: c.ok === false ? [failMeta(c)] : running ? [{ text: "reading", tone: "accent" }] : pages ? [{ text: plural(Number(pages[1]), "page") }] : lines ? [{ text: plural(Number(lines[1]), "line") }] : [],
      body,
    });
  }

  const searchedNote = searches ? `and searched ${searches === 1 ? "once" : `${searches} times`}` : "";
  if (files === 0) {
    return make(calls, {
      icon: "search",
      label: [running ? "Searching the project" : "Searched the project"],
      meta: running ? [{ text: "searching", tone: "accent" }] : searches > 1 ? [{ text: `${searches} searches` }] : calls[0]!.resultSummary ? [{ text: calls[0]!.resultSummary! }] : [],
      body,
    });
  }
  return make(calls, {
    icon: "search",
    label: [running ? `Looking through ${plural(files, "file")}` : `Looked through ${plural(files, "file")}`],
    meta: running ? [{ text: "working", tone: "accent" }] : searchedNote ? [{ text: searchedNote }] : [],
    body,
  });
}

/* ═══ Web pane actions ═══ */

function browserActionsRow(calls: ToolCallDTO[], ctx: RowCtx): RowModel {
  const host = ctx.state.host ?? "the page";
  const running = calls.some((c) => c.ok === null);
  const first = obj<{ op?: string }>(calls[0]!.input).op ?? "read";
  const verbs: Record<string, [string, string]> = {
    read: ["Checking", "Checked"],
    snapshot: ["Checking", "Checked"],
    console: ["Checking", "Checked"],
    click: ["Clicking on", "Clicked on"],
    type: ["Typing into", "Typed into"],
    press: ["Pressing a key on", "Pressed a key on"],
    scroll: ["Scrolling", "Scrolled"],
  };
  const v = verbs[first] ?? verbs.read!;
  const single = calls.length === 1;
  const label: Seg[] = single ? [`${running ? v[0] : v[1]} `, { b: host }, ...(first === "read" || first === "snapshot" || first === "console" ? [" in the Web pane"] : [])] : [running ? "Using the Web pane on " : "Used the Web pane on ", { b: host }];
  const items = calls.map((c) => {
    const i = obj<{ op?: string; ref?: string; text?: string; key?: string }>(c.input);
    const what: Seg[] = [i.op === "type" && i.text ? ["“", i.text, "”"].join("") : i.op === "press" && i.key ? { code: i.key } : c.resultSummary ?? ""];
    return { verb: (verbs[i.op ?? "read"] ?? verbs.read!)[1].replace(/ (on|into)$/, ""), what };
  });
  const bad = calls.find((c) => c.ok === false);
  return make(calls, {
    icon: "globe",
    label,
    meta: bad ? [failMeta(bad)] : running ? [{ text: "working", tone: "accent" }] : single ? [] : [{ text: plural(calls.length, "step") }],
    body: [{ k: "list", items }, { k: "link", goto: "web", label: "Open in Web" }],
  });
}

/* ═══ One call, one row ═══ */

const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function singleRow(c: ToolCallDTO, ctx: RowCtx): RowModel {
  const running = c.ok === null;
  const failed = c.ok === false;
  const s = c.resultSummary ?? "";
  const art = c.artifactId ? ctx.artifacts.get(c.artifactId) : undefined;
  const artifactBody: BodyPart[] = c.artifactId ? [{ k: "artifact", artifactId: c.artifactId, fallback: failed ? s : undefined }] : failed && s ? [{ k: "text", text: s }] : [];
  const fail = failed ? [failMeta(c)] : [];

  switch (c.name) {
    case "edit":
    case "write": {
      const i = obj<{ path?: string }>(c.input);
      const path = i.path ?? "";
      const file = base(path) || "a file";
      const created = /^created/.test(s) || (c.name === "write" && art?.meta?.created === true);
      const lines = s.match(/created · (\d+) lines?/);
      const link: BodyPart[] = path ? [{ k: "link", goto: `changes:${path}`, label: "Open in Changes" }] : [];
      if (failed) return make([c], { icon: "pencil", label: [`Couldn't ${created ? "create" : "edit"} `, { b: file }], meta: fail, body: artifactBody });
      return make([c], {
        icon: created || (c.name === "write" && !running && !delta(s).length) ? "file-plus" : "pencil",
        label: [`${running ? (c.name === "write" ? "Writing" : "Editing") : created || (c.name === "write" && !delta(s).length) ? "Created" : "Edited"} `, { b: file }],
        meta: running ? [{ text: "working", tone: "accent" }] : lines ? [{ text: `+${lines[1]}`, tone: "plus" }] : delta(s),
        body: [...artifactBody, ...link],
      });
    }
    case "file_op": {
      const i = obj<{ op?: string; from?: string; to?: string; path?: string }>(c.input);
      const verb = { move: ["Moving", "Moved"], copy: ["Copying", "Copied"], remove: ["Deleting", "Deleted"], mkdir: ["Creating folder", "Created folder"] }[i.op ?? "move"] ?? ["Changing", "Changed"];
      const label: Seg[] = i.op === "move" || i.op === "copy" ? [`${running ? verb[0] : verb[1]} `, { b: base(i.from ?? "") }, " to ", { b: base(i.to ?? "") }] : [`${running ? verb[0] : verb[1]} `, { b: base(i.path ?? "") }];
      return make([c], { icon: i.op === "remove" ? "x" : "pencil", label, meta: failed ? fail : running ? [{ text: "working", tone: "accent" }] : [], body: failed ? artifactBody : [] });
    }
    case "bash": {
      const i = obj<{ command?: string; background?: boolean }>(c.input);
      const cmd = (i.command ?? "").trim();
      const shown = trunc(cmd.split("\n")[0]!, 48);
      const title = cmd.length > 48 || cmd.includes("\n") ? cmd : undefined;
      if (i.background) {
        const tid = typeof art?.meta?.terminalId === "string" ? art.meta.terminalId : null;
        return make([c], {
          icon: "term",
          label: [running ? "Starting " : failed ? "Couldn't start " : "Started ", { b: shown }, " in the Terminal pane"],
          title,
          meta: failed ? fail : running ? [{ text: "starting", tone: "accent" }] : [{ text: "running", tone: "good" }],
          body: [...artifactBody.filter(() => failed), ...(tid ? [{ k: "link" as const, goto: `terminal:${tid}`, label: "Open in Terminal" }] : [])],
        });
      }
      const passed = s.match(/· (\d+) passed/);
      const nFailed = s.match(/· (\d+) failed/);
      const meta: MetaPart[] = running ? [{ text: "running", tone: "accent" }] : failed ? [nFailed ? { text: `${nFailed[1]} failed`, tone: "fail" } : failMeta(c)] : passed ? [{ text: `${passed[1]} passed`, tone: "ok" }] : [{ text: "done" }];
      return make([c], { icon: "term", label: [running ? "Running " : failed ? "Ran " : "Ran ", { b: shown }], title, meta, body: c.artifactId ? [{ k: "artifact", artifactId: c.artifactId }] : failed && s ? [{ k: "text", text: s }] : [] });
    }
    case "process": {
      const i = obj<{ op?: string; id?: string }>(c.input);
      if (i.op === "kill") {
        const title = (i.id && ctx.terminalTitle?.(i.id)) || "a terminal";
        return make([c], { icon: "term", label: [running ? "Stopping " : failed ? "Couldn't stop " : "Stopped ", { b: trunc(title, 48) }], meta: failed ? fail : [], body: failed && s ? [{ k: "text", text: s }] : [] });
      }
      return make([c], { icon: "term", label: [running ? "Checking the terminals" : "Checked the terminals"], meta: failed ? fail : [], body: failed && s ? [{ k: "text", text: s }] : [] });
    }
    case "browser": {
      const i = obj<{ url?: string }>(c.input);
      const host = hostOf(i.url ?? "");
      if (!failed && host) ctx.state.host = host;
      if (failed) return make([c], { icon: "globe", label: ["Couldn't open ", { b: host || "the page" }, " in the Web pane"], meta: fail, body: s ? [{ k: "text", text: s }] : [] });
      return make([c], {
        icon: "globe",
        label: [running ? "Opening " : "Opened ", { b: host || "a page" }, " in the Web pane"],
        meta: running ? [{ text: "opening", tone: "accent" }] : [],
        body: [{ k: "text", text: "The page stays open after this turn ends, so you can keep using it." }, { k: "link", goto: "web", label: "Open in Web" }],
      });
    }
    case "review": {
      const clean = /no (issues|changes|notes|problems)|nothing/i.test(s) || /^review complete$/i.test(s);
      const n = s.match(/(\d+)\s+(?:note|issue|problem|finding|comment)/i);
      return make([c], {
        icon: "eye",
        label: [running ? "A reviewer is reading the diff" : "A reviewer read the diff"],
        meta: failed ? fail : running ? [{ text: "reading", tone: "accent" }] : n ? [{ text: plural(Number(n[1]), "note") }] : clean ? [{ text: "no changes needed" }] : [],
        body: artifactBody.length ? artifactBody : s ? [{ k: "text", text: s }] : [],
      });
    }
    case "explore": {
      const q = obj<{ question?: string }>(c.input).question ?? "";
      return make([c], {
        icon: "search",
        label: [running ? "A helper is exploring: " : "A helper explored: ", { i: trunc(q, 80) }],
        meta: failed ? fail : running ? [{ text: "working", tone: "accent" }] : [],
        body: artifactBody.length ? artifactBody : s ? [{ k: "text", text: s }] : [],
      });
    }
    case "test":
      return make([c], {
        icon: "file-plus",
        label: [running ? "A helper is writing tests" : failed ? "A helper couldn't write tests" : "A helper wrote tests"],
        meta: failed ? fail : running ? [{ text: "working", tone: "accent" }] : [],
        body: artifactBody.length ? artifactBody : s ? [{ k: "text", text: s }] : [],
      });
    case "git_write": {
      const i = obj<{ op?: string; message?: string; paths?: string[]; name?: string; ref?: string; pop?: boolean }>(c.input);
      const n = i.paths?.length ?? 0;
      const where = s.match(/^committed · (\S+) ([0-9a-f]{7})/);
      const out = (text: string, icon: IconName = "commit", meta: MetaPart[] = []) => make([c], { icon, label: [text], meta: failed ? fail : meta, body: failed && s ? [{ k: "text", text: s }] : [] });
      switch (i.op) {
        case "commit":
          if (failed) return make([c], { icon: "commit", label: ["Couldn't commit"], meta: fail, body: s ? [{ k: "text", text: s }] : [] });
          return make([c], {
            icon: "commit",
            label: running ? ["Committing"] : where ? ["Committed to ", { b: where[1]! }] : ["Committed"],
            meta: running ? [{ text: "working", tone: "accent" }] : where ? [{ text: where[2]! }] : [],
            body: artifactBody,
          });
        case "stage":
          return out(`${running ? "Staging" : "Staged"} ${plural(n, "file")}`);
        case "unstage":
          return out(`${running ? "Unstaging" : "Unstaged"} ${plural(n, "file")}`);
        case "restore":
          return out(`${running ? "Restoring" : "Restored"} ${plural(n, "file")}`, "undo");
        case "branch":
          return make([c], { icon: "branch", label: [running ? "Creating branch " : "Created branch ", { b: i.name ?? "" }], meta: fail, body: failed && s ? [{ k: "text", text: s }] : [] });
        case "checkout":
          return make([c], { icon: "branch", label: [running ? "Switching to " : "Switched to ", { b: i.ref ?? "" }], meta: fail, body: failed && s ? [{ k: "text", text: s }] : [] });
        case "stash":
          return out(i.pop ? "Restored stashed changes" : "Stashed changes", "commit");
        default:
          return out("Changed git state");
      }
    }
    case "check": {
      const kinds = obj<{ kinds?: string[] }>(c.input).kinds ?? ["typecheck", "lint"];
      const names = kinds.map((k) => ({ typecheck: "types", lint: "lint", test: "tests", build: "the build" })[k] ?? k);
      const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "the code");
      // "typecheck: clean · lint: 2 errors · (test not run)" → "clean" or "N problems".
      const ran = s.split(" · ").filter((p) => !/^\(.* not run\)$/.test(p) && !/not available/.test(p));
      const problems = ran.reduce((sum, p) => sum + [...p.matchAll(/(\d+) (?:error|warning|issue)/g)].reduce((a, m) => a + Number(m[1]), 0), 0);
      const meta: MetaPart[] = running ? [{ text: "running", tone: "accent" }] : problems > 0 ? [{ text: plural(problems, "problem"), tone: "fail" }] : failed ? [failMeta(c)] : ran.length ? [{ text: "clean", tone: "ok" }] : [];
      return make([c], { icon: "check", label: [`${running ? "Checking" : "Checked"} ${list}`], meta, body: artifactBody.length ? artifactBody : s ? [{ k: "text", text: s }] : [] });
    }
    default:
      return make([c], { icon: "tool", label: [running ? "Working on it" : "Used a tool"], meta: failed ? fail : [], body: s ? [{ k: "text", text: s }] : [] });
  }
}

/* ═══ Thinking ═══ */

export function thinkingRow(key: string, text: string, durationMs: number | undefined, live: boolean, elapsedMs: number): RowModel {
  const body: BodyPart[] = text.trim() ? [{ k: "text", text: text.trim() }] : [];
  if (live) {
    const s = Math.max(0, Math.floor(elapsedMs / 1000));
    return { key, icon: "clock", label: ["Thinking"], meta: [{ text: plural(s, "second"), tone: "accent" }], body, status: "running", callIds: [], live: true };
  }
  let label = "Thought it through";
  if (durationMs != null) {
    const s = Math.round(durationMs / 1000);
    label = s < 1 ? "Thought for a moment" : `Thought for ${plural(s, "second")}`;
  }
  return { key, icon: "clock", label: [label], meta: [], body, status: "ok", callIds: [], live: false };
}

/** The label as plain text (tests, tooltips, copying). */
export const labelText = (segs: Seg[]): string => segs.map((s) => (typeof s === "string" ? s : "b" in s ? s.b : "i" in s ? s.i : "code" in s ? s.code : s.path)).join("");
