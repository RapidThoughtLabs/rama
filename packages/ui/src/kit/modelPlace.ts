/* Where a model runs — HOME_REDESIGN_PLAN.md Phase HD5. Home's model pill, model menu and privacy
   line all answer the one question a person has about a model: does what I type leave this Mac?
   A provider counts as local when its base URL points at this machine (or the local network's
   .local names); everything else, including providers with no base URL (the native Anthropic
   adapter), is cloud. The Code plan reuses this for its composer. */

export type ModelPlace = "local" | "cloud";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

export function isLocalBaseUrl(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false;
  let host: string;
  try {
    host = new URL(baseUrl.includes("://") ? baseUrl : `http://${baseUrl}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  return LOCAL_HOSTS.has(host) || host.endsWith(".local");
}

export function placeOf(provider: { baseUrl: string | null }): ModelPlace {
  return isLocalBaseUrl(provider.baseUrl) ? "local" : "cloud";
}

/** The privacy line under the composer (mock:L874-876). `via` is the provider's label. */
export function privacyNote(name: string, place: ModelPlace, via: string): string {
  return place === "local" ? `${name} runs on this Mac. Nothing you send leaves it.` : `${name} runs on ${via}'s servers. Messages are sent to them.`;
}

/** Who wrote an AI turn, under it (mock:L877). */
export function byline(name: string, place: ModelPlace, via: string): string {
  return place === "local" ? `${name} on this Mac` : `${name} via ${via}`;
}
