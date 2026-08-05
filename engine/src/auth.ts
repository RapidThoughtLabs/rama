// Loopback server auth: one random token per engine launch. The webview gets it from Rust
// core (which spawned this process and read it off stdout) and sends it back on every
// request — HTTP via the Authorization header, WS via a query param since the browser
// WebSocket API can't set custom headers.

export const ENGINE_TOKEN = Array.from(crypto.getRandomValues(new Uint8Array(32)))
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");

export function checkAuth(req: Request, url: URL): boolean {
  const header = req.headers.get("authorization");
  if (header === `Bearer ${ENGINE_TOKEN}`) return true;

  const queryToken = url.searchParams.get("token");
  return queryToken === ENGINE_TOKEN;
}
