import { getCurrentWindow } from "@tauri-apps/api/window";

// This window's Tauri label (e.g. "main", or "chat-3" for a spawned/detached window). Read once
// per JS module context — since every Tauri WebviewWindow is a separate context, this is
// naturally per-window with no extra bookkeeping. Used to scope per-window state (tab
// ownership, the active-chat localStorage key) so multiple windows stop colliding.
export const WINDOW_LABEL = getCurrentWindow().label;
