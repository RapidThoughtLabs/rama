import { getCurrentWindow } from "@tauri-apps/api/window";

// This window's Tauri label (e.g. "main", or "chat-3" for a spawned/detached window). Read once
// per JS module context — since every Tauri WebviewWindow is a separate context, this is
// naturally per-window with no extra bookkeeping. Used to scope per-window state (tab
// ownership, the active-chat localStorage key) so multiple windows stop colliding.
export const WINDOW_LABEL = getCurrentWindow().label;

// Windows runs frameless (src-tauri/tauri.windows.conf.json, drag.rs), so the app draws its own
// caption buttons (app/shell/WindowControls.tsx). WebView2's user agent always names Windows;
// fixture mode can fake it with `?os=windows`.
export const IS_WINDOWS = navigator.userAgent.includes("Windows");
