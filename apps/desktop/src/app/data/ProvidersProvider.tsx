import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { ProviderDTO, ProviderHealthDTO } from "@rama/protocol";
import {
  fetchProviderHealth,
  fetchProviders,
  getProviderKey,
  pushProviderSecret,
  setProviderKey,
} from "../../engine/client";

// Phase 4 — multi-provider & model management (docs/IMPLEMENTATION_PLAN.md Phase 4). Loads the
// provider/model roster from the engine, syncs OS-keychain keys to the (memory-only) engine on
// boot the same way SessionProvider used to do for Together alone, and polls provider health
// for the status bar.

const HEALTH_POLL_MS = 30_000;

interface ProvidersDataValue {
  loading: boolean;
  providers: ProviderDTO[];
  health: Record<string, ProviderHealthDTO>;
  saveProviderKey: (providerId: string, apiKey: string) => Promise<void>;
  refreshHealth: (providerId: string) => Promise<void>;
}

const ProvidersContext = createContext<ProvidersDataValue | null>(null);

export function ProvidersProvider({ children }: { children: ReactNode }) {
  const [providers, setProviders] = useState<ProviderDTO[]>([]);
  const [health, setHealth] = useState<Record<string, ProviderHealthDTO>>({});
  const [loading, setLoading] = useState(true);

  const refreshHealth = useCallback(async (providerId: string) => {
    try {
      const result = await fetchProviderHealth(providerId);
      setHealth((prev) => ({ ...prev, [providerId]: result }));
    } catch (err) {
      console.error(`[rama] failed to check ${providerId} health`, err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await fetchProviders();
        if (cancelled) return;
        setProviders(list);

        // Every provider's key lives in the OS keychain; the engine keeps secrets in memory
        // only and loses them on every restart (see engine/src/secrets.ts), so re-push
        // whatever's stored for each provider on every app boot.
        await Promise.all(
          list.map(async (p) => {
            try {
              const key = await getProviderKey(p.id);
              if (key) await pushProviderSecret(p.id, key);
            } catch (err) {
              console.error(`[rama] failed to sync ${p.id} key to engine`, err);
            }
          }),
        );

        if (cancelled) return;
        await Promise.all(list.map((p) => refreshHealth(p.id)));
      } catch (err) {
        console.error("[rama] failed to load providers", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshHealth]);

  useEffect(() => {
    if (providers.length === 0) return;
    const id = setInterval(() => {
      for (const p of providers) void refreshHealth(p.id);
    }, HEALTH_POLL_MS);
    return () => clearInterval(id);
  }, [providers, refreshHealth]);

  const saveProviderKey = useCallback(
    async (providerId: string, apiKey: string) => {
      await setProviderKey(providerId, apiKey);
      await pushProviderSecret(providerId, apiKey);
      await refreshHealth(providerId);
    },
    [refreshHealth],
  );

  const value = useMemo<ProvidersDataValue>(
    () => ({ loading, providers, health, saveProviderKey, refreshHealth }),
    [loading, providers, health, saveProviderKey, refreshHealth],
  );

  return <ProvidersContext.Provider value={value}>{children}</ProvidersContext.Provider>;
}

export function useProvidersData(): ProvidersDataValue {
  const ctx = useContext(ProvidersContext);
  if (!ctx) throw new Error("useProvidersData must be used within a ProvidersProvider");
  return ctx;
}
