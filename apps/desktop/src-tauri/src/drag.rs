// docs/REDESIGN_PLAN.md Phase R3 — the tab strip (and with it, the pointer-drag tear-off/reorder
// gesture this file used to implement) is gone; popping a chat out into its own window is now an
// explicit action instead of a drag. This keeps only the window-creation half of the old flow.

use std::sync::atomic::{AtomicU32, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;

use crate::window_registry::{attach_lifecycle_handlers, emit_registry_changed, WindowRegistry};

static NEXT_WINDOW_ID: AtomicU32 = AtomicU32::new(0);

#[derive(Clone, Serialize)]
struct TabsChangedPayload {
    #[serde(rename = "chatIds")]
    chat_ids: Vec<String>,
}

/// Removes `chat_id` from `from_label`'s tabs and opens it as the sole tab of a brand new
/// standalone window. Mirrors the old tear-off drag's window-build/registry-preseed/chrome-match
/// steps, minus the cursor-following poll loop — this is a button, not a gesture, so the new
/// window just cascades a fixed offset from the source window instead of tracking a pointer.
///
/// `async fn` deliberately: `WebviewWindowBuilder::build()` documents a Windows-specific deadlock
/// when window creation is triggered from a synchronous command handler (window creation must
/// happen via the event-loop thread); making the command async is Tauri's own documented fix.
#[tauri::command]
pub async fn pop_out_chat(app: AppHandle, chat_id: String, from_label: String) -> Result<(), String> {
    // Remove from the source window's tabs before the new window exists, so the chat is never
    // briefly a tab of two windows at once — same ordering as the registry write below.
    {
        let registry = app.state::<WindowRegistry>();
        let mut guard = registry.0.lock().unwrap();
        if let Some(list) = guard.get_mut(&from_label) {
            list.retain(|id| id != &chat_id);
            let remaining = list.clone();
            drop(guard);

            // A window that just lost its only tab is a derelict husk — close it rather than
            // leaving it open showing the popped-out chat's stale state (see window_registry.rs's
            // comment on why there's no "return orphaned tabs to main" logic). `main` never
            // auto-closes.
            if remaining.is_empty() && from_label != "main" {
                if let Some(win) = app.get_webview_window(&from_label) {
                    let _ = win.close();
                }
            } else {
                let _ = app.emit_to(&from_label, "tabs-changed", TabsChangedPayload { chat_ids: remaining });
            }
            emit_registry_changed(&app);
        }
    }

    let label = format!("chat-{}", NEXT_WINDOW_ID.fetch_add(1, Ordering::SeqCst));

    // Pre-seed the new window's registry entry *before* building it, so its own
    // WindowTabsProvider never hits the cold-boot "seed with every known chat" path (that path is
    // only for a fresh `main` window — see window_registry.rs).
    app.state::<WindowRegistry>().0.lock().unwrap().insert(label.clone(), vec![chat_id.clone()]);

    // Match the main window's chrome (tauri.conf.json: frameless overlay titlebar, hidden title,
    // trafficLightPosition) so a popped-out window looks identical to main rather than sprouting a
    // native OS titlebar or unpadded traffic lights — tauri.conf.json's window config only seeds
    // the initial `main` window, so a dynamically built window like this one has to opt back in
    // explicitly. Keep the x/y here in sync with tauri.conf.json's `trafficLightPosition`.
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("rama")
        .inner_size(1440.0, 900.0)
        .min_inner_size(860.0, 560.0);
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(LogicalPosition::new(16.0, 25.0));
    }
    let window = builder.build().map_err(|e| e.to_string())?;

    // Cascade a fixed offset from the source window rather than centering — cheap way to avoid
    // exact overlap without any cursor-position input to work from.
    if let Some(src) = app.get_webview_window(&from_label) {
        if let Ok(pos) = src.outer_position() {
            let _ = window.set_position(PhysicalPosition::new(pos.x as f64 + 40.0, pos.y as f64 + 40.0));
        }
    }
    let _ = window.set_focus();

    attach_lifecycle_handlers(&window);
    let _ = app.emit_to(&label, "tabs-changed", TabsChangedPayload { chat_ids: vec![chat_id] });

    Ok(())
}
