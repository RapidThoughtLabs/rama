// Minimal Chrome DevTools Protocol client for scripts/parity.ts — just enough to open a page,
// run JS in it and take a PNG. Uses Bun's built-in WebSocket/fetch, so there is nothing to
// install. Drives the Chrome that's already on the machine; it never touches the user's profile
// (a throwaway --user-data-dir) and never leaves a process running.

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME_PATHS = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean) as string[];

export class Page {
  private id = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private waiters = new Map<string, Array<() => void>>();

  private constructor(private ws: WebSocket, readonly targetId: string) {
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message}`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        const ws2 = this.waiters.get(msg.method);
        if (ws2) {
          this.waiters.delete(msg.method);
          for (const w of ws2) w();
        }
      }
    });
  }

  static async open(port: number): Promise<Page> {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
    const t = (await res.json()) as { id: string; webSocketDebuggerUrl: string };
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("CDP socket failed")));
    });
    const page = new Page(ws, t.id);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Page.bringToFront");
    return page;
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  private once(method: string): Promise<void> {
    return new Promise((resolve) => this.waiters.set(method, [...(this.waiters.get(method) ?? []), resolve]));
  }

  async viewport(width: number, height: number): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await this.send("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
  }

  /** Runs `source` in every new document before its own scripts. */
  initScript(source: string): Promise<unknown> {
    return this.send("Page.addScriptToEvaluateOnNewDocument", { source });
  }

  async goto(url: string): Promise<void> {
    const loaded = this.once("Page.loadEventFired");
    const nav = await this.send<{ errorText?: string }>("Page.navigate", { url });
    if (nav.errorText) throw new Error(`could not load ${url}: ${nav.errorText}`);
    // A slow third-party request (Google Fonts) must not hang the run: carry on after 20s, since
    // the callers wait for document.fonts.ready themselves.
    await Promise.race([loaded, Bun.sleep(20_000)]);
  }

  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  async png(): Promise<string> {
    const r = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    return r.data;
  }

  close(): void {
    this.ws.close();
  }
}

export async function launchChrome(port = 9333): Promise<{ page: () => Promise<Page>; stop: () => void }> {
  const bin = CHROME_PATHS.find((p) => existsSync(p));
  if (!bin) throw new Error("No Chrome found. Install Google Chrome or set CHROME_BIN.");
  const profile = mkdtempSync(join(tmpdir(), "rama-parity-"));
  const proc = Bun.spawn(
    [bin, "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--hide-scrollbars", "--force-device-scale-factor=1", "--no-first-run", "--no-default-browser-check", "--disable-background-timer-throttling", "about:blank"],
    { stdout: "ignore", stderr: "ignore" },
  );
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) break;
    } catch {}
    await Bun.sleep(250);
    if (i === 59) throw new Error("Chrome did not start");
  }
  return {
    page: () => Page.open(port),
    stop: () => {
      proc.kill();
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {}
    },
  };
}
