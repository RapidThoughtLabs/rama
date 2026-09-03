import { listDocs } from "../../docs/store";
import type { SearchCtx, SearchProvider, SearchResultItem } from "../types";

export const docsSearchProvider: SearchProvider = {
  domain: "docs",
  label: "Docs",
  list(ctx: SearchCtx): SearchResultItem[] {
    if (!ctx.projectId) return [];
    return listDocs(ctx.projectId).map((doc) => ({
      id: `doc:${ctx.projectId}:${doc.name}`,
      domain: "docs",
      title: doc.name,
      subtitle: doc.subtitle,
      score: 0,
    }));
  },
};
