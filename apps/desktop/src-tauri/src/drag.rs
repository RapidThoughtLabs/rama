// Custom cross-window tab drag (docs/IMPLEMENTATION_PLAN.md Phase 5). Deliberately not built on
// `window.start_dragging()` (Tauri's native OS interactive-move loop, normally used for
// titlebar dragging): there's no reliable cross-platform signal for "the native drag just
// ended" from JS, and it gives no hook for live cross-window hit-testing while dragging.
// Instead this is a small Rust-driven poll loop: position comes from Tauri's own
// `cursor_position()` (physical desktop pixels — the same space as `outer_position()` /
// `outer_size()`, so hit-testing needs no DPI math), and "is the button still held" comes from
// `mouse_button::left_button_down()`, a plain OS state query (see that module's doc comment for
// why this matters over a full input-hooking crate).

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;

use crate::mouse_button::left_button_down;
use crate::window_registry::{attach_lifecycle_handlers, WindowRegistry};

const POLL_INTERVAL: Duration = Duration::from_millis(16); // ~60Hz

// Height of the drop-target hit-test region at the top of a window, approximating the tab strip
// (`.rama-titlebar` in apps/desktop/src/app/app-shell.css). Rust has no visibility into the
// DOM's actual layout, so this is a constant kept in sync by hand — if the titlebar's CSS height
// changes materially, update this too.
const TAB_STRIP_HEIGHT_LOGICAL: f64 = 44.0;

static NEXT_WINDOW_ID: AtomicU32 = AtomicU32::new(0);

/// Holds the cancellation flag for whichever drag is currently in flight, if any. Enforces a
/// single active drag at a time and gives both the poll thread and the app-exit handler an
/// explicit, checkable signal instead of inferring "drag over" purely from button-up.
#[derive(Default)]
pub struct DragState(pub Mutex<Option<Arc<AtomicBool>>>);

#[derive(Clone, Serialize)]
struct TabsChangedPayload {
    #[serde(rename = "chatIds")]
    chat_ids: Vec<String>,
}

#[derive(Clone, Serialize)]
struct DragHoverPayload {
    hovering: bool,
}

/// Starts a tab tear-off: removes `chat_id` from `from_label`'s tabs, spawns a new window at the
/// cursor (offset by where in the tab the user grabbed it) pre-seeded to own just that chat, and
/// hands off to a poll thread that follows the cursor and hit-tests against every other rama
/// window until the mouse button is released — docking into whatever window strip it's released
/// over, or staying as a new standalone window otherwise. Reattaching a tab into an existing
/// window's strip (including a single-tab standalone window) is the same code path, run from
/// that window's own tab strip — there is no separate "reattach" command.
///
/// `async fn` deliberately: `WebviewWindowBuilder::build()` documents a Windows-specific
/// deadlock when window creation is triggered from a synchronous command handler (window
/// creation must happen via the event-loop thread); making the command async is Tauri's own
/// documented fix.
#[tauri::command]
pub async fn begin_tab_drag(
    app: AppHandle,
    chat_id: String,
    from_label: String,
    grab_offset_x: f64,
    grab_offset_y: f64,
) -> Result<(), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let drag_state = app.state::<DragState>();
        let mut guard = drag_state.0.lock().unwrap();
        if guard.is_some() {
            return Err("a drag is already in progress".into());
        }
        *guard = Some(cancel.clone());
    }

    let result = run_drag(&app, chat_id, from_label, grab_offset_x, grab_offset_y, cancel).await;

    if result.is_err() {
        // On success, ownership of clearing this passes to the poll thread (it needs the flag
        // alive for its own lifetime); on failure nothing was spawned to clear it, so do it here
        // so a later drag isn't permanently blocked.
        app.state::<DragState>().0.lock().unwrap().take();
    }

    result
}

async fn run_drag(
    app: &AppHandle,
    chat_id: String,
    from_label: String,
    grab_offset_x: f64,
    grab_offset_y: f64,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    let start_x = cursor.x - grab_offset_x;
    let start_y = cursor.y - grab_offset_y;

    // Remove from the source window's tabs before the new window exists, so the chat is never
    // briefly a tab of two windows at once.
    {
        let registry = app.state::<WindowRegistry>();
        let mut guard = registry.0.lock().unwrap();
        if let Some(list) = guard.get_mut(&from_label) {
            list.retain(|id| id != &chat_id);
            let remaining = list.clone();
            drop(guard);

            // A spawned (chat-*) window that just lost its only tab is a derelict husk — close it
            // rather than leaving it open with no tabs (its content pane would otherwise keep
            // showing the torn-off chat's stale state, inviting the user to re-adopt the same chat
            // from the sidebar and tear it off again: the "tab mitosis" bug). `main` never
            // auto-closes. The registry entry itself is dropped by `attach_lifecycle_handlers`'s
            // Destroyed hook, so no explicit removal is needed here.
            if remaining.is_empty() && from_label != "main" {
                if let Some(win) = app.get_webview_window(&from_label) {
                    let _ = win.close();
                }
            } else {
                let _ = app.emit_to(&from_label, "tabs-changed", TabsChangedPayload { chat_ids: remaining });
            }
        }
    }

    let label = format!("chat-{}", NEXT_WINDOW_ID.fetch_add(1, Ordering::SeqCst));

    // Pre-seed the new window's registry entry *before* building it, so its own
    // WindowTabsProvider never hits the cold-boot "seed with every known chat" path (that path
    // is only for a fresh `main` window — see window_registry.rs).
    app.state::<WindowRegistry>().0.lock().unwrap().insert(label.clone(), vec![chat_id.clone()]);

    // Match the main window's chrome (tauri.conf.json: frameless overlay titlebar, hidden title)
    // so a torn-off window looks identical to main rather than sprouting a native OS titlebar.
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("rama")
        .inner_size(1440.0, 900.0)
        .min_inner_size(860.0, 560.0);
    #[cfg(target_os = "macos")]
    {
        builder = builder.title_bar_style(TitleBarStyle::Overlay).hidden_title(true);
    }
    let window = builder.build().map_err(|e| e.to_string())?;

    let _ = window.set_position(PhysicalPosition::new(start_x, start_y));
    let _ = window.set_focus();

    attach_lifecycle_handlers(&window);
    let _ = app.emit_to(&label, "tabs-changed", TabsChangedPayload { chat_ids: vec![chat_id] });

    spawn_drag_poll_thread(app.clone(), window, label, grab_offset_x, grab_offset_y, cancel);
    Ok(())
}

fn spawn_drag_poll_thread(
    app: AppHandle,
    dragged_window: WebviewWindow,
    dragged_label: String,
    grab_offset_x: f64,
    grab_offset_y: f64,
    cancel: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        let mut last_hover: Option<String> = None;

        loop {
            if cancel.load(Ordering::SeqCst) || !left_button_down() {
                break;
            }

            if let Ok(cursor) = app.cursor_position() {
                let target_x = cursor.x - grab_offset_x;
                let target_y = cursor.y - grab_offset_y;
                let _ = dragged_window.set_position(PhysicalPosition::new(target_x, target_y));

                let hover = hit_test_tab_strip(&app, &dragged_label, cursor.x, cursor.y);
                if hover != last_hover {
                    if let Some(prev) = &last_hover {
                        let _ = app.emit_to(prev, "drag-hover", DragHoverPayload { hovering: false });
                    }
                    if let Some(next) = &hover {
                        let _ = app.emit_to(next, "drag-hover", DragHoverPayload { hovering: true });
                    }
                    last_hover = hover;
                }
            }

            std::thread::sleep(POLL_INTERVAL);
        }

        if let Some(prev) = &last_hover {
            let _ = app.emit_to(prev, "drag-hover", DragHoverPayload { hovering: false });
        }

        finish_drag(&app, &dragged_window, &dragged_label, last_hover);

        // Clear last, so a new drag can't start until this one has fully resolved (docked or
        // left standalone).
        app.state::<DragState>().0.lock().unwrap().take();
    });
}

fn hit_test_tab_strip(app: &AppHandle, exclude_label: &str, cursor_x: f64, cursor_y: f64) -> Option<String> {
    for (label, window) in app.webview_windows() {
        if label == exclude_label {
            continue;
        }
        let Ok(pos) = window.outer_position() else { continue };
        let Ok(size) = window.outer_size() else { continue };
        let Ok(scale) = window.scale_factor() else { continue };

        let strip_height = TAB_STRIP_HEIGHT_LOGICAL * scale;
        let within_x = cursor_x >= pos.x as f64 && cursor_x <= pos.x as f64 + size.width as f64;
        let within_y = cursor_y >= pos.y as f64 && cursor_y <= pos.y as f64 + strip_height;
        if within_x && within_y {
            return Some(label);
        }
    }
    None
}

fn finish_drag(app: &AppHandle, dragged_window: &WebviewWindow, dragged_label: &str, hover: Option<String>) {
    let Some(target_label) = hover else { return };

    let registry = app.state::<WindowRegistry>();
    let mut guard = registry.0.lock().unwrap();

    // Re-check the target window still exists inside the same critical section as the registry
    // write, so a window that closed mid-drag self-heals into "stayed standalone" instead of
    // docking into a now-gone window.
    if app.get_webview_window(&target_label).is_none() {
        return;
    }

    let Some(dragged_ids) = guard.remove(dragged_label) else { return };
    let entry = guard.entry(target_label.clone()).or_default();
    for id in &dragged_ids {
        if !entry.contains(id) {
            entry.push(id.clone());
        }
    }
    let target_ids = entry.clone();
    drop(guard);

    let _ = app.emit_to(&target_label, "tabs-changed", TabsChangedPayload { chat_ids: target_ids });
    let _ = dragged_window.close();
}

/// Flips the cancel flag of whichever drag is active, if any, on app exit. Deliberately doesn't
/// join the poll thread — that risks blocking process exit if it's ever stuck, and the thread
/// holds no unique resource needing explicit cleanup (the OS reaps it on process teardown
/// regardless).
pub fn cancel_active_drag(app: &AppHandle) {
    if let Some(cancel) = app.state::<DragState>().0.lock().unwrap().as_ref() {
        cancel.store(true, Ordering::SeqCst);
    }
}
