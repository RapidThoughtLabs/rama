import { useMemo } from "react";
import { highlightCode } from "../../mission-control/panes/syntax";

/* The Changes stage's diff — docs/CODE_REDESIGN_PLAN.md CR4 (mock:L466-477, 1656-1670). A unified
   diff in the mockup's grid: two number columns, a sign, the code, with each hunk headed by a
   sentence instead of git's `@@ -21,7 +21,9 @@`. The legacy `app/diff/DiffView` stays for the chat's
   artifact cards until CR6/CR7. */

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const HIGHLIGHT_LIMIT = 4000; // lines per hunk; beyond this, plain text is kinder than a stalled paint

interface Row {
  kind: "ctx" | "add" | "del";
  oldNum: number | null;
  newNum: number | null;
  text: string;
}

interface Hunk {
  title: string;
  rows: Row[];
}

/** The innermost thing git named after `@@`: `function ThemeProvider(` → `ThemeProvider`. */
function symbolOf(section: string): string {
  const decl = section.match(/\b(?:function|class|interface|type|enum|struct|trait|impl|def|fn|func|const|let|var)\s+([A-Za-z_$][\w$]*)/);
  if (decl) return decl[1]!;
  const call = section.match(/([A-Za-z_$][\w$]*)\s*[(=:]/);
  if (call) return call[1]!;
  const bare = section.trim();
  return /^[A-Za-z_$][\w$.]*$/.test(bare) ? bare : "";
}

/** "Lines 21 to 29, in ThemeProvider". The range comes from the rows themselves, not the header's
 *  counts, so a hand-edited or sloppy header still reads true. */
export function hunkSentence(header: string, rows: Row[]): string {
  const m = header.match(HUNK_RE);
  if (!m) return header;
  const [, oldStart, oldCount, , newCountRaw, section] = m;
  if (oldStart === "0" && oldCount === "0") return "New file";
  if (newCountRaw === "0" && rows.every((r) => r.newNum === null)) return "Deleted file";
  const news = rows.map((r) => r.newNum).filter((n): n is number => n !== null);
  const start = news.length ? news[0]! : parseInt(m[3]!, 10);
  const end = news.length ? news[news.length - 1]! : start;
  const where = end > start ? `Lines ${start} to ${end}` : `Line ${start}`;
  const sym = symbolOf(section ?? "");
  return sym ? `${where}, in ${sym}` : where;
}

export function parseHunks(text: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let o = 0;
  let n = 0;
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // the final newline, not a blank context row
  for (const line of lines) {
    if (line.startsWith("@@")) {
      const m = line.match(HUNK_RE);
      o = m ? parseInt(m[1]!, 10) : 0;
      n = m ? parseInt(m[3]!, 10) : 0;
      current = { title: line, rows: [] };
      hunks.push(current);
      continue;
    }
    // File headers before the first hunk, and "\ No newline at end of file" markers, aren't code.
    if (!current || line.startsWith("\\")) continue;
    const sign = line[0];
    const kind = sign === "+" ? "add" : sign === "-" ? "del" : "ctx";
    current.rows.push({
      kind,
      oldNum: kind === "add" ? null : o++,
      newNum: kind === "del" ? null : n++,
      text: line.slice(1),
    });
  }
  for (const h of hunks) h.title = hunkSentence(h.title, h.rows);
  return hunks;
}

export function Diff({ diff, path }: { diff: string; path: string }) {
  const hunks = useMemo(() => parseHunks(diff), [diff]);
  const highlighted = useMemo(
    () => hunks.map((h) => (h.rows.length > HIGHLIGHT_LIMIT ? null : highlightCode(h.rows.map((r) => r.text).join("\n"), path))),
    [hunks, path],
  );
  return (
    <div className="r-diff r-code">
      {hunks.map((h, hi) => (
        <div key={hi}>
          <div className="r-hunk">{h.title}</div>
          {h.rows.map((r, i) => {
            const html = highlighted[hi]?.[i];
            return (
              <div key={i} className={`r-dl${r.kind === "ctx" ? "" : ` ${r.kind}`}`}>
                <span className="n">{r.oldNum ?? ""}</span>
                <span className="n">{r.newNum ?? ""}</span>
                <span className="s">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}</span>
                {html === undefined || html === null ? <span>{r.text || " "}</span> : <span dangerouslySetInnerHTML={{ __html: html || " " }} />}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
