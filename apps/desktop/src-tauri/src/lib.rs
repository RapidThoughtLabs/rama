mod drag;
mod engine;
mod pty;
mod secrets;
mod webview;
mod window_registry;

use drag::pop_out_chat;
use engine::{get_engine_connection, spawn_engine, EngineState};
use pty::{pty_is_running, pty_kill, pty_list_running, pty_resize, pty_spawn, pty_write, PtyState};
use secrets::{delete_provider_key, get_provider_key, set_provider_key};
use tauri::Manager;
use webview::{webview_create, webview_destroy, webview_eval, webview_navigate, webview_set_bounds, webview_set_visible, EvalState};
use window_registry::{
    add_chat_to_window, attach_lifecycle_handlers, get_window_tabs, initialize_window_tabs, list_all_window_tabs,
    remove_chat_from_windows, WindowRegistry,
};

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(EngineState::default())
        .manage(WindowRegistry::default())
        .manage(PtyState::default())
        .manage(EvalState::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            get_engine_connection,
            set_provider_key,
            get_provider_key,
            delete_provider_key,
            initialize_window_tabs,
            get_window_tabs,
            list_all_window_tabs,
            add_chat_to_window,
            remove_chat_from_windows,
            pop_out_chat,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            pty_is_running,
            pty_list_running,
            webview_create,
            webview_navigate,
            webview_set_bounds,
            webview_set_visible,
            webview_destroy,
            webview_eval
        ])
        .setup(|app| {
            match spawn_engine() {
                Ok(handle) => {
                    *app.state::<EngineState>().0.lock().unwrap() = Some(handle);
                }
                Err(err) => {
                    eprintln!("[rama] engine failed to start: {err}");
                }
            }
            if let Some(main_window) = app.get_webview_window("main") {
                attach_lifecycle_handlers(&main_window);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            pty::kill_all(app_handle);
            drop(app_handle.state::<EngineState>().0.lock().unwrap().take());
        }
    });
}
