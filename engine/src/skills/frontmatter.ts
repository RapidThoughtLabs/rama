// Minimal SKILL.md frontmatter parser — only needs flat `key: value` pairs (name, description),
// so a hand-rolled scanner avoids pulling in a YAML dependency for two fields.
export interface SkillFrontmatter {
  name?: string;
  description?: string;
  body: string;
}

export function parseSkillMd(content: string): SkillFrontmatter {
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
    const value = rawValue.trim().replace(/^["']|["']$/g, "");
    fields[key] = value;
  }

  return { name: fields.name, description: fields.description, body };
}
