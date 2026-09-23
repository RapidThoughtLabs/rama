import { useMemo, type ReactNode } from "react";
import { marked, type Token, type Tokens } from "marked";
import { CodeFence } from "./CodeFence";
import { PathLink } from "./PathLink";

interface MarkdownProps {
  content: string;
}

interface SplitBlock {
  key: string;
  text: string;
  isComplete: boolean;
}

/**
 * Splits raw markdown into block chunks at blank lines and fence boundaries.
 * All chunks before the last one are complete (immutable during streaming);
 * only the trailing chunk is re-parsed on subsequent text deltas.
 */
function splitMarkdownBlocks(markdown: string): SplitBlock[] {
  const lines = markdown.split("\n");
  const blocks: SplitBlock[] = [];
  let currentLines: string[] = [];
  let inFence = false;
  let fenceMarker = "";
  let blockIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = !inFence && line.match(/^([`~]{3,})/);

    if (fenceMatch) {
      if (currentLines.length > 0) {
        blocks.push({
          key: `b-${blockIndex++}`,
          text: currentLines.join("\n"),
          isComplete: true,
        });
        currentLines = [];
      }
      inFence = true;
      fenceMarker = fenceMatch[1];
      currentLines.push(line);
    } else if (inFence) {
      currentLines.push(line);
      if (line.trim().startsWith(fenceMarker)) {
        inFence = false;
        blocks.push({
          key: `b-${blockIndex++}`,
          text: currentLines.join("\n"),
          isComplete: true,
        });
        currentLines = [];
      }
    } else if (line.trim() === "") {
      if (currentLines.length > 0) {
        blocks.push({
          key: `b-${blockIndex++}`,
          text: currentLines.join("\n"),
          isComplete: true,
        });
        currentLines = [];
      }
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0) {
    blocks.push({
      key: `b-${blockIndex++}`,
      text: currentLines.join("\n"),
      isComplete: false,
    });
  }

  return blocks;
}

function renderInlineTokens(tokens?: Token[]): ReactNode {
  if (!tokens || tokens.length === 0) return null;

  return tokens.map((token, idx) => {
    switch (token.type) {
      case "text":
        return <span key={idx}>{"text" in token ? token.text : ""}</span>;
      case "strong":
        return (
          <strong key={idx}>
            {renderInlineTokens("tokens" in token ? (token.tokens as Token[]) : undefined)}
          </strong>
        );
      case "em":
        return (
          <em key={idx}>
            {renderInlineTokens("tokens" in token ? (token.tokens as Token[]) : undefined)}
          </em>
        );
      case "codespan":
        return <PathLink key={idx} code={"text" in token ? token.text : ""} />;
      case "link":
        return (
          <a
            key={idx}
            href={"href" in token ? token.href : "#"}
            title={"title" in token ? token.title ?? undefined : undefined}
            target="_blank"
            rel="noreferrer"
            className="rama-md-link"
          >
            {renderInlineTokens("tokens" in token ? (token.tokens as Token[]) : undefined) ||
              ("text" in token ? token.text : "")}
          </a>
        );
      case "del":
        return (
          <del key={idx}>
            {renderInlineTokens("tokens" in token ? (token.tokens as Token[]) : undefined)}
          </del>
        );
      case "br":
        return <br key={idx} />;
      case "escape":
        return <span key={idx}>{"text" in token ? token.text : ""}</span>;
      default:
        return <span key={idx}>{"raw" in token ? token.raw : ""}</span>;
    }
  });
}

function renderToken(token: Token, key: string | number): ReactNode {
  switch (token.type) {
    case "paragraph":
      return (
        <p key={key} className="rama-md-p">
          {renderInlineTokens(token.tokens)}
        </p>
      );

    case "heading": {
      // docs/CHAT_VIEW_PLAN.md CV3: Two weights, not six heading sizes
      const depth = token.depth;
      if (depth <= 2) {
        return (
          <h3 key={key} className="rama-md-h3">
            {renderInlineTokens(token.tokens)}
          </h3>
        );
      }
      return (
        <h4 key={key} className="rama-md-h4">
          {renderInlineTokens(token.tokens)}
        </h4>
      );
    }

    case "code":
      return <CodeFence key={key} code={token.text} lang={token.lang} />;

    case "list": {
      const listToken = token as Tokens.List;
      const isOrdered = listToken.ordered;
      const Tag = isOrdered ? "ol" : "ul";
      return (
        <Tag key={key} className="rama-md-list" start={typeof listToken.start === "number" ? listToken.start : undefined}>
          {listToken.items.map((item: Tokens.ListItem, itemIdx: number) => (
            <li key={itemIdx} className="rama-md-li">
              {item.tokens ? renderTokens(item.tokens) : renderInlineTokens(item.tokens)}
            </li>
          ))}
        </Tag>
      );
    }

    case "table": {
      const tableToken = token as Tokens.Table;
      return (
        <div key={key} className="rama-md-table-wrap rama-breakout">
          <table className="rama-md-table">
            <thead>
              <tr>
                {tableToken.header.map((cell: Tokens.TableCell, cIdx: number) => (
                  <th key={cIdx} style={{ textAlign: (tableToken.align[cIdx] as "left" | "center" | "right") ?? "left" }}>
                    {renderInlineTokens(cell.tokens)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableToken.rows.map((row: Tokens.TableCell[], rIdx: number) => (
                <tr key={rIdx}>
                  {row.map((cell: Tokens.TableCell, cIdx: number) => (
                    <td key={cIdx} style={{ textAlign: (tableToken.align[cIdx] as "left" | "center" | "right") ?? "left" }}>
                      {renderInlineTokens(cell.tokens)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    case "blockquote": {
      const bqToken = token as Tokens.Blockquote;
      return (
        <blockquote key={key} className="rama-md-blockquote">
          {renderTokens(bqToken.tokens || [])}
        </blockquote>
      );
    }

    case "hr":
      return <hr key={key} className="rama-md-hr" />;

    case "space":
      return null;

    case "text":
      // Tight list items wrap their content in a block-level "text" token
      // (marked's ListItem.tokens), distinct from the inline "text" token
      // handled in renderInlineTokens — without this case it fell to
      // `default` and rendered the raw unparsed markdown.
      return "tokens" in token && token.tokens ? (
        <span key={key}>{renderInlineTokens(token.tokens)}</span>
      ) : (
        <span key={key}>{"text" in token ? token.text : ""}</span>
      );

    case "html":
      // Raw HTML disabled for security; render literal text
      return (
        <div key={key} className="rama-md-raw">
          {token.raw}
        </div>
      );

    default:
      return (
        <div key={key} className="rama-md-raw">
          {"raw" in token ? token.raw : ""}
        </div>
      );
  }
}

function renderTokens(tokens: Token[]): ReactNode {
  return tokens.map((token, idx) => renderToken(token, idx));
}

// Global memoization cache for completed markdown blocks across renders
const parsedBlockCache = new Map<string, ReactNode>();

function renderBlock(block: SplitBlock): ReactNode {
  if (block.isComplete) {
    const cached = parsedBlockCache.get(block.text);
    if (cached) return cached;
  }

  const tokens = marked.lexer(block.text, { gfm: true, breaks: false });
  const rendered = <div key={block.key}>{renderTokens(tokens)}</div>;

  if (block.isComplete) {
    // Keep cache bounded to 1000 items
    if (parsedBlockCache.size > 1000) {
      const oldestKey = parsedBlockCache.keys().next().value;
      if (oldestKey !== undefined) parsedBlockCache.delete(oldestKey);
    }
    parsedBlockCache.set(block.text, rendered);
  }

  return rendered;
}

export function Markdown({ content }: MarkdownProps) {
  const blocks = useMemo(() => splitMarkdownBlocks(content), [content]);

  return (
    <div className="rama-markdown">
      {blocks.map((block) => renderBlock(block))}
    </div>
  );
}
