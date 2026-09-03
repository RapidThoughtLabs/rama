import { discoverSkills } from "../../skills/discover";
import type { SearchCtx, SearchProvider, SearchResultItem } from "../types";

export const skillsSearchProvider: SearchProvider = {
  domain: "skills",
  label: "Skills",
  list(ctx: SearchCtx): SearchResultItem[] {
    return discoverSkills(ctx).map((skill) => ({
      id: `skill:${skill.name}`,
      domain: "skills",
      title: skill.name,
      subtitle: skill.description,
      score: 0,
    }));
  },
};
