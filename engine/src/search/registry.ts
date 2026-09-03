import type { SearchCtx, SearchProvider, SearchResultItem } from "./types";

const providers: SearchProvider[] = [];

export function registerSearchProvider(provider: SearchProvider) {
  providers.push(provider);
}

export function listSearchProviders(): { domain: string; label: string }[] {
  return providers.map((p) => ({ domain: p.domain, label: p.label }));
}

// Generic fallback ranking for providers that don't implement their own `search()` — a real
// indexing module can replace this per-provider without touching the registry or its callers.
function defaultScore(query: string, item: SearchResultItem): number {
  const q = query.toLowerCase();
  const title = item.title.toLowerCase();
  if (title === q) return 100;
  if (title.startsWith(q)) return 80;
  if (title.includes(q)) return 60;
  if (item.subtitle?.toLowerCase().includes(q)) return 30;
  return 0;
}

export async function ramaSearch(query: string, ctx: SearchCtx = {}): Promise<SearchResultItem[]> {
  const q = query.trim();
  if (!q) return [];

  const perProvider = await Promise.all(
    providers.map(async (p) => {
      if (p.search) return p.search(q, ctx);
      const items = await p.list(ctx);
      return items.map((item) => ({ ...item, score: defaultScore(q, item) })).filter((item) => item.score > 0);
    }),
  );

  return perProvider.flat().sort((a, b) => b.score - a.score);
}

export async function searchDomainStats(ctx: SearchCtx = {}): Promise<{ domain: string; label: string; count: number }[]> {
  return Promise.all(
    providers.map(async (p) => ({ domain: p.domain, label: p.label, count: (await p.list(ctx)).length })),
  );
}
