// Fake Tauri IPC for fixture mode (docs/CODE_REDESIGN_PLAN.md CR1).
//
// The app only reaches Rust through `window.__TAURI_INTERNALS__.invoke`, so fixture mode
// replaces that one function. In a plain browser the whole object is missing, so a minimal one
// is created (enough for `getCurrentWindow().label`, `listen`, and `invoke`). Inside a real
// Tauri window the genuine object is kept and only `invoke` is wrapped, so fixture mode never
// spawns a shell or a native webview, and never touches the real window-tab registry.

type Handler = (cmd: string, args: Record<string, unknown>) => unknown | Promise<unknown>;

interface Listener {
  event: string;
  handlerId: number;
}

interface TauriInternals {
  invoke: (cmd: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown>;
  transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number;
  unregisterCallback: (id: number) => void;
  convertFileSrc: (path: string, protocol?: string) => string;
  metadata: { currentWindow: { label: string }; currentWebview: { windowLabel: string; label: string } };
}

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: Partial<TauriInternals>;
  __TAURI_EVENT_PLUGIN_INTERNALS__?: { unregisterListener: (event: string, id: number) => void };
};

const listeners = new Map<number, Listener>();
let nextListenerId = 1;
let nextCallbackId = 1;

/** Delivers a Tauri event to every listener registered for it (what Rust's `emit` does). */
export function emitTauriEvent(event: string, payload: unknown): void {
  for (const [id, l] of listeners) {
    if (l.event !== event) continue;
    const cb = (window as unknown as Record<string, unknown>)[`_${l.handlerId}`];
    if (typeof cb === "function") cb({ event, id, payload });
  }
}

export function installTauriShim(handler: Handler, label = "main"): void {
  const w = window as TauriWindow;
  const internals = (w.__TAURI_INTERNALS__ ??= {});

  // Same convention as Tauri's own transformCallback: the callback lives at window._<id>.
  if (!internals.transformCallback) {
    internals.transformCallback = (cb) => {
      const id = nextCallbackId++;
      (window as unknown as Record<string, unknown>)[`_${id}`] = cb;
      return id;
    };
    internals.unregisterCallback = (id) => {
      delete (window as unknown as Record<string, unknown>)[`_${id}`];
    };
    internals.convertFileSrc = (path) => path;
  }
  internals.metadata ??= { currentWindow: { label }, currentWebview: { windowLabel: label, label } };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ ??= { unregisterListener: () => {} };

  internals.invoke = async (cmd, args = {}) => {
    if (cmd === "plugin:event|listen") {
      const id = nextListenerId++;
      listeners.set(id, { event: String(args.event), handlerId: Number(args.handler) });
      return id;
    }
    if (cmd === "plugin:event|unlisten") {
      listeners.delete(Number(args.eventId));
      return undefined;
    }
    if (cmd.startsWith("plugin:event|emit")) return undefined;
    if (cmd.startsWith("plugin:")) return undefined; // window / opener / webview plugins: no-ops
    return handler(cmd, args);
  };
}
