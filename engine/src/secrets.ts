// API keys live only in the OS keychain (owned by the Rust core) and are pushed here over
// the loopback HTTP the webview already uses for everything else. Held in memory only —
// never written to SQLite or disk — and lost on every engine restart by design; the webview
// re-pushes the keychain value on boot (see SessionProvider).

const secrets = new Map<string, string>();

export function setSecret(providerId: string, apiKey: string): void {
  secrets.set(providerId, apiKey);
}

export function getSecret(providerId: string): string | undefined {
  return secrets.get(providerId);
}
