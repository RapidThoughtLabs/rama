// Per-window tab ownership (docs/IMPLEMENTATION_PLAN.md Phase 5). A chat is a "tab" in at most
// one window at a time; this registry is the single source of truth for "which window owns
// which chat ids," mirrored client-side by WindowTabsProvider via the `tabs-changed` event.
// A chat owned by no window (its window closed without the tab being dragged elsewhere first)
// simply has no tab anywhere but stays reachable through the Sidebar, which lists every chat
// globally regardless of window — so there is deliberately no "return orphaned tabs to main"
// logic here; window close just drops that window's entry.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WindowEvent};

#[derive(Default)]
pub struct WindowRegistry(pub Mutex<HashMap<String, Vec<String>>>);

#[derive(Clone, Serialize)]
struct TabsChangedPayload {
    #[serde(rename = "chatIds")]
    chat_ids: Vec<String>,
}

fn emit_tabs_changed(app: &AppHandle, window_label: &str, chat_ids: Vec<String>) {
    let _ = app.emit_to(window_label, "tabs-changed", TabsChangedPayload { chat_ids });
}

/// Broadcast (not window-scoped, unlike `tabs-changed` above) — tells every window that
/// *someone's* tab ownership changed, without saying whose. docs/REDESIGN_PLAN.md Phase R2: the
/// sidebar's cross-window ownership glyph is the only consumer today; it just re-pulls
/// `list_all_window_tabs` in response rather than trying to diff the payload.
pub fn emit_registry_changed(app: &AppHandle) {
    let _ = app.emit("registry-changed", ());
}

/// Seeds a window's tab list the first time it's asked for one; a no-op if it already has an
/// entry. Windows spawned by `pop_out_chat` (drag.rs) are pre-seeded before their HTML loads, so
/// this only ever fires for a cold-booted `main` window (or one whose registry entry was dropped
/// and is being recreated on next launch, since the registry isn't persisted).
#[tauri::command]
pub fn initialize_window_tabs(
    app: AppHandle,
    state: tauri::State<WindowRegistry>,
    window_label: String,
    chat_ids: Vec<String>,
) {
    let mut guard = state.0.lock().unwrap();
    if guard.contains_key(&window_label) {
        return;
    }
    guard.insert(window_label.clone(), chat_ids.clone());
    drop(guard);
    emit_tabs_changed(&app, &window_label, chat_ids);
    emit_registry_changed(&app);
}

#[tauri::command]
pub fn get_window_tabs(state: tauri::State<WindowRegistry>, window_label: String) -> Vec<String> {
    state.0.lock().unwrap().get(&window_label).cloned().unwrap_or_default()
}

/// The whole registry, window label -> its owned chat ids. docs/REDESIGN_PLAN.md Phase R2 — the
/// sidebar uses this (main window only) to show which chats are tabs elsewhere; every other
/// consumer only ever needs its own window's slice (`get_window_tabs`).
#[tauri::command]
pub fn list_all_window_tabs(state: tauri::State<WindowRegistry>) -> HashMap<String, Vec<String>> {
    state.0.lock().unwrap().clone()
}

/// Adds `chat_id` as a tab of `window_label`. If it's already owned by a *different* window,
/// does not move it — returns that window's label so the caller can focus it instead (a chat is
/// a tab in at most one window at a time). Returns `None` when the chat now belongs to
/// `window_label` (either freshly adopted or already there).
#[tauri::command]
pub fn add_chat_to_window(
    app: AppHandle,
    state: tauri::State<WindowRegistry>,
    window_label: String,
    chat_id: String,
) -> Option<String> {
    let mut guard = state.0.lock().unwrap();

    if let Some(owner) = guard
        .iter()
        .find(|(label, ids)| **label != window_label && ids.contains(&chat_id))
        .map(|(label, _)| label.clone())
    {
        return Some(owner);
    }

    let entry = guard.entry(window_label.clone()).or_default();
    if !entry.contains(&chat_id) {
        entry.push(chat_id);
    }
    let chat_ids = entry.clone();
    drop(guard);
    emit_tabs_changed(&app, &window_label, chat_ids);
    emit_registry_changed(&app);
    None
}

/// Drops `chat_id` from whichever window currently owns it as a tab (a chat is a tab of at most
/// one window), for when the chat itself has been deleted rather than just moved — same removal
/// + "close the now-empty window" logic as `pop_out_chat`'s source-window step (drag.rs), just
/// without a destination window to hand the tab to afterward.
#[tauri::command]
pub fn remove_chat_from_windows(app: AppHandle, state: tauri::State<WindowRegistry>, chat_id: String) {
    let owner = {
        let guard = state.0.lock().unwrap();
        guard
            .iter()
            .find(|(_, ids)| ids.contains(&chat_id))
            .map(|(label, _)| label.clone())
    };
    let Some(label) = owner else { return };

    let mut guard = state.0.lock().unwrap();
    let Some(list) = guard.get_mut(&label) else { return };
    list.retain(|id| id != &chat_id);
    let remaining = list.clone();
    drop(guard);

    if remaining.is_empty() && label != "main" {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.close();
        }
    } else {
        emit_tabs_changed(&app, &label, remaining);
    }
    emit_registry_changed(&app);
}

/// Registers cleanup so a window's registry entry (and thus its owned tabs) is dropped once it's
/// destroyed. Must be called for every window immediately after creation — `main` in `setup()`,
/// and every `chat-*` window spawned by a drag (see `drag.rs`) — so it can't be forgotten on
/// either path.
pub fn attach_lifecycle_handlers(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            if let Some(registry) = app.try_state::<WindowRegistry>() {
                registry.0.lock().unwrap().remove(&label);
            }
        }
    });
}
