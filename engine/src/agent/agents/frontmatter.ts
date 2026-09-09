// Minimal agent-file frontmatter parser — same hand-rolled shape as skills/frontmatter.ts (no
// YAML dependency for a handful of flat fields), extended with `tools`, which is the one field
// here that's a list rather than a scalar: `tools: [read, grep, git]` or a bare comma list both
// parse the same way.
export interface AgentFrontmatter {
  name?: string;
  description?: string;
  tools?: string[];
  mode?: string;
  model?: string;
  body: string;
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}

function parseListValue(raw: string): string[] {
  const trimmed = raw.trim();
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return inner
    .split(",")
    .map((s) => stripQuotes(s.trim()))
    .filter(Boolean);
}

export function parseAgentMd(content: string): AgentFrontmatter {
  if (!content.startsWith("---")) {
    return { body: content.trim() };
  }

  const closeIndex = content.indexOf("\n---", 3);
  if (closeIndex === -1) {
    return { body: content.trim() };
  }

  const frontmatterBlock = content.slice(3, closeIndex).trim();
  const body = content.slice(closeIndex + 4).replace(/^\r?\n/, "").trim();

  const fields: Record<string, string> = {};
  for (const line of frontmatterBlock.split("\n")) {
    const match = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    fields[key] = rawValue.trim();
  }

  return {
    name: fields.name ? stripQuotes(fields.name) : undefined,
    description: fields.description ? stripQuotes(fields.description) : undefined,
    tools: fields.tools ? parseListValue(fields.tools) : undefined,
    mode: fields.mode,
    model: fields.model,
    body,
  };
}
