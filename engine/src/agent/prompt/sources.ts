import { arch, platform } from "node:os";

// docs/PROMPT_STACK_PLAN.md §4.1/§10 PS0 — layer 5 (static environment only; branch/dirty/date
// are volatile and belong to PS2's ephemeral block, not here). Cached at module scope because
// none of this can change for the life of the process, which is exactly the stability the cache
// prefix needs — re-reading it per request would be pointless work on the hot path.
export interface StaticEnv {
  platform: string;
  arch: string;
  shell: string;
}

let cachedEnv: StaticEnv | null = null;

export function getStaticEnv(): StaticEnv {
  if (cachedEnv) return cachedEnv;
  cachedEnv = {
    platform: platform(),
    arch: arch(),
    shell: process.env.SHELL ?? "unknown",
  };
  return cachedEnv;
}

export function formatStaticEnv(env: StaticEnv): string {
  return `Environment: ${env.platform}/${env.arch}, shell ${env.shell}.`;
}
