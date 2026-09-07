import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ProviderDTO, ProviderHealthDTO } from "@rama/protocol";
import {
  createProvider,
  fetchProviderHealth,
  fetchProviders,
  getProviderKey,
  pushProviderSecret,
  setProviderKey,
  triggerCatalogEnrichment,
} from "../../engine/client";

// Phase 4 — multi-provider & model management (docs/IMPLEMENTATION_PLAN.md Phase 4). Loads the
// provider/model roster from the engine, syncs OS-keychain keys to the (memory-only) engine on
// boot the same way SessionProvider used to do for Together alone, and polls provider health
// for the status bar.

const HEALTH_POLL_MS = 30_000;

// docs/PROVIDERS_PLAN.md Phase P3 — the six providers every install used to seed regardless of
// use. The migration's "keep if keychain entry exists" clause can only be decided from here: the
// engine has no access to the OS keychain (see engine/src/secrets.ts), only the webview does.
const LEGACY_PROVIDER_IDS = ["together", "openai", "groq", "openrouter", "ollama", "anthropic"];
const LEGACY_KEY_MIGRATION_STORAGE_KEY = "rama.migratedLegacyProviderKeys";

interface ProvidersDataValue {
  loading: boolean;
  providers: ProviderDTO[];
  health: Record<string, ProviderHealthDTO>;
  saveProviderKey: (providerId: string, apiKey: string) => Promise<void>;
  refreshHealth: (providerId: string) => Promise<void>;
  reload: () => Promise<void>;
}

const ProvidersContext = createContext<ProvidersDataValue | null>(null);

export function ProvidersProvider({ children }: { children: ReactNode }) {
  const [providers, setProviders] = useState<ProviderDTO[]>([]);
  const [health, setHealth] = useState<Record<string, ProviderHealthDTO>>({});
  const [loading, setLoading] = useState(true);

  // docs/PROVIDERS_PLAN.md Phase P1 guard 2 — "a provider is hidden only after two consecutive
  // failed checks." Applied here, centrally, so every consumer (the composer picker, the status
  // bar dot, the settings nav badge) sees one already-debounced signal instead of each having to
  // re-implement the same hysteresis. A ref, not state — it's write-only bookkeeping the render
  // never reads directly.
  const failCountsRef = useRef<Record<string, number>>({});

  const refreshHealth = useCallback(async (providerId: string) => {
    try {
      const result = await fetchProviderHealth(providerId);
      setHealth((prev) => {
        if (result.status === "ok") {
          failCountsRef.current[providerId] = 0;
          return { ...prev, [providerId]: result };
        }
        const failCount = (failCountsRef.current[providerId] ?? 0) + 1;
        failCountsRef.current[providerId] = failCount;
        const previouslyOk = prev[providerId]?.status === "ok";
        // First bad check after a run of `ok`: report the new latency/error but keep the status
        // itself `ok` for one more poll — only a *second* consecutive failure actually flips it,
        // so one flaky poll can't make a provider vanish from the picker and reappear 30s later.
        if (previouslyOk && failCount < 2) {
          return { ...prev, [providerId]: { ...result, status: "ok" } };
        }
        return { ...prev, [providerId]: result };
      });
    } catch (err) {
      console.error(`[rama] failed to check ${providerId} health`, err);
    }
  }, []);

  // docs/PROVIDERS_PLAN.md Phase P3 — the keychain half of the migration's "keep if a keychain
  // entry exists" rule. The engine already deleted, at boot, any of the six legacy ids nothing
  // referenced (see engine/src/db/providers.ts's migrateLegacyProviderSeeds); this resurrects any
  // of those that turn out to have a saved key, via the same createProvider + push-secret path
  // fast-add uses. Runs at most once ever (localStorage-gated, not per-boot) — after that, "no
  // key and no chat" is just how a provider looks after the user removed it on purpose.
  const migrateLegacyKeysOnce = useCallback(async (currentIds: Set<string>) => {
    if (window.localStorage.getItem(LEGACY_KEY_MIGRATION_STORAGE_KEY)) return false;
    window.localStorage.setItem(LEGACY_KEY_MIGRATION_STORAGE_KEY, "1");

    let resurrected = false;
    for (const id of LEGACY_PROVIDER_IDS) {
      if (currentIds.has(id)) continue;
      try {
        const key = await getProviderKey(id);
        if (!key) continue;
        await createProvider(id);
        await pushProviderSecret(id, key);
        resurrected = true;
      } catch (err) {
        console.error(`[rama] failed to migrate legacy ${id} key`, err);
      }
    }
    return resurrected;
  }, []);

  const load = useCallback(async () => {
    const list = await fetchProviders();
    const resurrected = await migrateLegacyKeysOnce(new Set(list.map((p) => p.id)));
    const finalList = resurrected ? await fetchProviders() : list;
    setProviders(finalList);

    // docs/PROVIDERS_PLAN.md Phase P1 guard 1 — seed from "was fine yesterday" instead of
    // leaving every provider on `checking` until its first live round-trip resolves, so a
    // cold start's composer picker isn't empty for the first second (longer on a slow network,
    // forever offline). Only seeds providers that actually have a persisted status; anything
    // else still starts `checking` and gets its real status from the round-trip below.
    const seeded = Object.fromEntries(
      finalList
        .filter((p) => p.lastHealthStatus)
        .map((p) => [
          p.id,
          { providerId: p.id, status: p.lastHealthStatus as ProviderHealthDTO["status"], latencyMs: null, error: null, checkedAt: p.lastHealthAt ?? 0 },
        ]),
    );
    if (Object.keys(seeded).length > 0) setHealth((prev) => ({ ...seeded, ...prev }));

    // Every provider's key lives in the OS keychain; the engine keeps secrets in memory
    // only and loses them on every restart (see engine/src/secrets.ts), so re-push
    // whatever's stored for each provider on every app boot.
    await Promise.all(
      finalList.map(async (p) => {
        try {
          const key = await getProviderKey(p.id);
          if (key) await pushProviderSecret(p.id, key);
        } catch (err) {
          console.error(`[rama] failed to sync ${p.id} key to engine`, err);
        }
      }),
    );

    await Promise.all(finalList.map((p) => refreshHealth(p.id)));
  }, [migrateLegacyKeysOnce, refreshHealth]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!cancelled) await load();
      } catch (err) {
        console.error("[rama] failed to load providers", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    if (providers.length === 0) return;
    const id = setInterval(() => {
      for (const p of providers) void refreshHealth(p.id);
    }, HEALTH_POLL_MS);
    return () => clearInterval(id);
  }, [providers, refreshHealth]);

  // docs/PROVIDERS_PLAN.md Phase P6 — "never on the boot path": this fires once, after mount, and
  // never blocks the provider list or the paint. The engine route itself is a no-op unless the
  // settings toggle is on, and is cheap even then thanks to the weekly cache, so it's safe to call
  // unconditionally on every launch rather than plumbing the setting through to the webview too.
  useEffect(() => {
    triggerCatalogEnrichment().catch((err) => console.error("[rama] catalog enrichment check failed", err));
  }, []);

  const saveProviderKey = useCallback(
    async (providerId: string, apiKey: string) => {
      await setProviderKey(providerId, apiKey);
      // docs/PROVIDERS_PLAN.md Phase P3 — pushProviderSecret's POST /providers/:id/secret now
      // creates the provider row on first save (fast-add's "paste key" step), so a full reload —
      // not just this one provider's health — is what makes a brand-new provider's card appear.
      await pushProviderSecret(providerId, apiKey);
      await load();
    },
    [load],
  );

  const value = useMemo<ProvidersDataValue>(
    () => ({ loading, providers, health, saveProviderKey, refreshHealth, reload: load }),
    [loading, providers, health, saveProviderKey, refreshHealth, load],
  );

  return <ProvidersContext.Provider value={value}>{children}</ProvidersContext.Provider>;
}

export function useProvidersData(): ProvidersDataValue {
  const ctx = useContext(ProvidersContext);
  if (!ctx) throw new Error("useProvidersData must be used within a ProvidersProvider");
  return ctx;
}
