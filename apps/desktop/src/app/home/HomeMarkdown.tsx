import { Fragment, createContext, useContext, useMemo, type ReactNode } from "react";
import hljs from "highlight.js";
import { marked, type Token, type Tokens } from "marked";
import { TranscriptCard as Card } from "@rama/ui";
import { splitMarkdownBlocks, type SplitBlock } from "../markdown/splitBlocks";

/* Home's prose — HOME_REDESIGN_PLAN.md Phase HD6 (mock:L321-350). The same streaming block split as
   the Code chat's Markdown.tsx (finished blocks are cached, only the trailing one re-parses), with
   its own renderer: plain elements styled by the kit's .r-prose, so no rama-* class is emitted,
   path links are off, and fences become the mockup's cards:
     ```draft Email draft  → a draft card labelled "Email draft", its body markdown in prose type
     ```python            → a code card labelled "Python", highlighted in the mockup's palette
   Blocks render as fragments, not wrappers, so margins collapse the way the mockup's do. */

/** Lets a caller take over some of the markdown — the Code chat draws path-shaped inline code as
 *  clickable path pills and ```mermaid fences as diagrams (docs/CODE_REDESIGN_PLAN.md CR6). Each
 *  hook returns null to keep the default. Home passes nothing, so its prose is unchanged. */
export interface MarkdownHooks {
  inlineCode?: (code: string) => ReactNode | null;
  fence?: (lang: string, code: string) => ReactNode | null;
}
const HooksContext = createContext<MarkdownHooks | null>(null);

function InlineCode({ text }: { text: string }) {
  const hooks = useContext(HooksContext);
  return <>{hooks?.inlineCode?.(text) ?? <code>{text}</code>}</>;
}

export function HomeMarkdown({ content, hooks }: { content: string; hooks?: MarkdownHooks }) {
  const blocks = useMemo(() => splitMarkdownBlocks(content), [content]);
  const rendered = <>{blocks.map(renderBlock)}</>;
  return hooks ? <HooksContext.Provider value={hooks}>{rendered}</HooksContext.Provider> : rendered;
}

const cache = new Map<string, ReactNode>();

function renderBlock(block: SplitBlock): ReactNode {
  if (block.isComplete) {
    const hit = cache.get(block.text);
    if (hit) return <Fragment key={block.key}>{hit}</Fragment>;
  }
  const rendered = renderTokens(marked.lexer(block.text, { gfm: true, breaks: false }));
  if (block.isComplete) {
    if (cache.size > 1000) cache.delete(cache.keys().next().value!);
    cache.set(block.text, rendered);
  }
  return <Fragment key={block.key}>{rendered}</Fragment>;
}

function renderTokens(tokens: Token[]): ReactNode {
  return tokens.map((t, i) => renderToken(t, i));
}

function inline(tokens?: Token[]): ReactNode {
  if (!tokens?.length) return null;
  return tokens.map((t, i) => {
    switch (t.type) {
      case "strong":
        return <strong key={i}>{inline((t as Tokens.Strong).tokens)}</strong>;
      case "em":
        return <em key={i}>{inline((t as Tokens.Em).tokens)}</em>;
      case "del":
        return <del key={i}>{inline((t as Tokens.Del).tokens)}</del>;
      case "codespan":
        return <InlineCode key={i} text={(t as Tokens.Codespan).text} />;
      case "br":
        return <br key={i} />;
      case "link": {
        const l = t as Tokens.Link;
        return (
          <a key={i} href={l.href} title={l.title ?? undefined} target="_blank" rel="noreferrer">
            {inline(l.tokens) || l.text}
          </a>
        );
      }
      case "text": {
        const tx = t as Tokens.Text;
        return tx.tokens ? <Fragment key={i}>{inline(tx.tokens)}</Fragment> : <Fragment key={i}>{decode(tx.text)}</Fragment>;
      }
      case "escape":
        return <Fragment key={i}>{(t as Tokens.Escape).text}</Fragment>;
      default:
        return <Fragment key={i}>{"raw" in t ? t.raw : ""}</Fragment>;
    }
  });
}

// marked leaves entities like &amp; in text tokens; React would print them literally.
const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);

function renderToken(t: Token, key: number): ReactNode {
  switch (t.type) {
    case "paragraph":
      return <p key={key}>{inline((t as Tokens.Paragraph).tokens)}</p>;
    case "heading": {
      const h = t as Tokens.Heading;
      return h.depth <= 2 ? <h3 key={key}>{inline(h.tokens)}</h3> : <h4 key={key}>{inline(h.tokens)}</h4>;
    }
    case "code":
      return <Fence key={key} text={(t as Tokens.Code).text} info={(t as Tokens.Code).lang ?? ""} />;
    case "list": {
      const l = t as Tokens.List;
      const items = l.items.map((item, i) => <li key={i}>{renderTokens(item.tokens)}</li>);
      return l.ordered ? (
        <ol key={key} start={typeof l.start === "number" && l.start !== 1 ? l.start : undefined}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case "table": {
      const tb = t as Tokens.Table;
      // Markdown's right-aligned columns (---:) are the numeric ones (mock:L333).
      const cls = (c: number) => (tb.align[c] === "right" ? "num" : undefined);
      return (
        <table key={key}>
          <thead>
            <tr>
              {tb.header.map((cell, c) => (
                <th key={c} className={cls(c)}>
                  {inline(cell.tokens)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tb.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c} className={cls(c)}>
                    {inline(cell.tokens)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    case "blockquote":
      return <blockquote key={key}>{renderTokens((t as Tokens.Blockquote).tokens)}</blockquote>;
    case "hr":
      return <hr key={key} />;
    case "space":
      return null;
    case "text": {
      // A tight list item's block-level text token.
      const tx = t as Tokens.Text;
      return <Fragment key={key}>{tx.tokens ? inline(tx.tokens) : decode(tx.text)}</Fragment>;
    }
    default:
      // Raw HTML stays text.
      return <p key={key}>{"raw" in t ? t.raw : ""}</p>;
  }
}

/* ═══ Fences ═══ */

function Fence({ text, info }: { text: string; info: string }) {
  const hooks = useContext(HooksContext);
  const draft = info.match(/^draft\b\s*(.*)$/i);
  if (draft) return <DraftCard label={draft[1].trim() || "Draft"} text={text} />;
  const lang = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const custom = hooks?.fence?.(lang, text);
  if (custom) return <>{custom}</>;
  return (
    <Card code label={langLabel(lang)}>
      <pre>
        <code dangerouslySetInnerHTML={{ __html: highlight(text, lang) }} />
      </pre>
    </Card>
  );
}

/** The draft's body is markdown in prose type, with single newlines kept as line breaks (a letter's
 *  "Best,\nSam"). A first line "Subject: …" becomes the muted subject line (mock:L336, 891). */
function DraftCard({ label, text }: { label: string; text: string }) {
  const body = useMemo(() => {
    const m = text.match(/^Subject:\s*(.+)\n*/i);
    const rest = m ? text.slice(m[0].length) : text;
    return (
      <>
        {m && (
          <p className="subj">
            Subject: <b>{m[1].trim()}</b>
          </p>
        )}
        {renderTokens(marked.lexer(rest, { gfm: true, breaks: true }))}
      </>
    );
  }, [text]);
  return <Card label={label}>{body}</Card>;
}

const LANG_LABELS: Record<string, string> = {
  py: "Python", python: "Python", js: "JavaScript", javascript: "JavaScript", jsx: "JavaScript", ts: "TypeScript",
  typescript: "TypeScript", tsx: "TypeScript", json: "JSON", html: "HTML", xml: "XML", css: "CSS", sql: "SQL",
  sh: "Shell", bash: "Shell", zsh: "Shell", shell: "Shell", console: "Shell", yaml: "YAML", yml: "YAML", md: "Markdown",
  markdown: "Markdown", csv: "CSV", rb: "Ruby", ruby: "Ruby", go: "Go", rust: "Rust", rs: "Rust", swift: "Swift",
  java: "Java", kotlin: "Kotlin", c: "C", cpp: "C++", csharp: "C#", cs: "C#", php: "PHP", r: "R", text: "Text", txt: "Text",
  excel: "Spreadsheet formula", formula: "Spreadsheet formula", sheets: "Spreadsheet formula", xlsx: "Spreadsheet formula",
};
const SPREADSHEET = new Set(["excel", "formula", "sheets", "xlsx"]);

export function langLabel(lang: string): string {
  if (!lang) return "Code";
  return LANG_LABELS[lang] ?? lang.charAt(0).toUpperCase() + lang.slice(1);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function highlight(code: string, lang: string): string {
  if (SPREADSHEET.has(lang)) return highlightFormula(code);
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      // fall through to plain
    }
  }
  return esc(code);
}

/** Spreadsheet formulas in the mockup's terms (mock:L947): function names as .tok-fn, cell and
 *  range references as .tok-ref, strings as strings, everything else plain. highlight.js's excel
 *  grammar splits "$E$1" into pieces, so this is done by hand. */
export function highlightFormula(code: string): string {
  const re = /("(?:[^"]|"")*")|\b([A-Z][A-Z0-9.]*)(?=\()|(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)/g;
  let out = "";
  let last = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    out += esc(code.slice(last, m.index));
    const cls = m[1] ? "hljs-string" : m[2] ? "tok-fn" : "tok-ref";
    out += `<span class="${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(code.slice(last));
}
