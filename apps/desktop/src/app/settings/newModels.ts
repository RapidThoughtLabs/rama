import type { ProviderDTO } from "@rama/protocol";

/* "New since you last looked" (docs/PROVIDERS_PLAN.md Phase P4), bookmarked per provider in
   localStorage. A provider with no bookmark yet gets one at first sight instead of counting its
   whole roster as new — a freshly added OpenRouter would otherwise badge 300 models. */

const key = (providerId: string) => `rama.providerLastViewedAt.${providerId}`;

export function lastViewedAt(providerId: string): number {
  try {
    const raw = window.localStorage.getItem(key(providerId));
    if (raw == null) {
      window.localStorage.setItem(key(providerId), String(Date.now()));
      return Date.now();
    }
    return Number(raw) || 0;
  } catch {
    return Date.now();
  }
}

export function markViewed(providerId: string): void {
  try {
    window.localStorage.setItem(key(providerId), String(Date.now()));
  } catch {
    // best-effort — worst case the "New" tags show again next time
  }
}

export function newModelCount(providers: ProviderDTO[]): number {
  return providers.reduce((sum, p) => {
    const since = lastViewedAt(p.id);
    return sum + p.models.filter((m) => !m.enabled && m.firstSeenAt > since).length;
  }, 0);
}
