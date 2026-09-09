import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, type RamaToolSet } from "../tools/define";
import { z } from "zod";
import { gate } from "../agent/permissions";
import type { ToolCtx, ToolResult } from "../tools/types";
import { discoverSkills } from "./discover";

function sanitizeToolName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "skill";
}

// One tool per discovered skill, named skill_<name> so it can never collide with the builtin
// read/write/edit/grep/ls/bash set. Calling it loads SKILL.md's instructions into context —
// mirrors how the harness's own Skill tool works, not an executable-code sandbox.
export function createSkillTools(ctx: ToolCtx): RamaToolSet {
  const skills = discoverSkills(ctx);
  const tools: RamaToolSet = {};

  for (const skill of skills) {
    const toolName = `skill_${sanitizeToolName(skill.name)}`;
    tools[toolName] = defineTool({
      description: skill.description || `Load instructions for the "${skill.name}" skill.`,
      inputSchema: z.object({}),
      execute: async (): Promise<ToolResult> =>
        gate(ctx, { name: toolName, input: {}, risk: "low" }, async () => {
          const body = readFileSync(join(skill.path, "SKILL.md"), "utf8");
          return { ok: true, summary: `loaded skill: ${skill.name}`, content: body };
        }),
    });
  }

  return tools;
}
