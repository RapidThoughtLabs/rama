// Owns PTY child processes for cli-backed chats (docs/IMPLEMENTATION_PLAN.md Phase 8). Rust is
// the only place in this app with real OS-level pseudo-terminal support — Bun's `Bun.spawn` only
// gives plain pipes, which lack the raw-mode/resize/signal semantics an interactive CLI (Claude
// Code, Copilot, …) needs. The Bun engine only mirrors this process's output into a persisted
// artifact (see /chats/:id/pty/* routes) for history; it never spawns or controls the process.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager};

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState(Mutex<HashMap<String, PtySession>>);

fn pty_data_event(chat_id: &str) -> String {
    format!("pty-data:{chat_id}")
}

fn pty_exit_event(chat_id: &str) -> String {
    format!("pty-exit:{chat_id}")
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: tauri::State<PtyState>,
    chat_id: String,
    command: String,
    args: Vec<String>,
    cwd: String,
    env: HashMap<String, String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&command);
    cmd.args(&args);
    cmd.cwd(&cwd);
    for (key, value) in env {
        cmd.env(key, value);
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // The slave fd is only needed by the child; keeping it open in this process too would leave
    // a duplicate that stops the master's reader from ever seeing EOF once the child exits.
    drop(pair.slave);

    let killer = child.clone_killer();
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(chat_id.clone(), PtySession { master: pair.master, writer, killer });

    let reader_app = app.clone();
    let reader_chat_id = chat_id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let _ = reader_app.emit(&pty_data_event(&reader_chat_id), chunk);
                }
                Err(_) => break,
            }
        }

        let exit_code = child.wait().map(|status| status.exit_code()).unwrap_or(1);
        let _ = reader_app.emit(&pty_exit_event(&reader_chat_id), exit_code);
        reader_app.state::<PtyState>().0.lock().unwrap().remove(&reader_chat_id);
    });

    Ok(())
}

// Lets the frontend tell, on (re)mount, whether it should attach to an already-running PTY
// (replay history, keep listening) or spawn a fresh one — a chat's process outlives whichever
// tab/window happens to have it focused.
#[tauri::command]
pub fn pty_is_running(state: tauri::State<PtyState>, chat_id: String) -> Result<bool, String> {
    Ok(state.0.lock().map_err(|e| e.to_string())?.contains_key(&chat_id))
}

#[tauri::command]
pub fn pty_write(state: tauri::State<PtyState>, chat_id: String, data: String) -> Result<(), String> {
    let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
    let session = sessions.get_mut(&chat_id).ok_or_else(|| "no pty running for this chat".to_string())?;
    session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: tauri::State<PtyState>, chat_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.0.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&chat_id).ok_or_else(|| "no pty running for this chat".to_string())?;
    session
        .master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<PtyState>, chat_id: String) -> Result<(), String> {
    let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = sessions.remove(&chat_id) {
        session.killer.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Kills every still-running PTY on full app exit — mirrors `EngineHandle`'s `Drop`-based kill
/// in `engine.rs`, called from `lib.rs`'s existing `RunEvent::Exit` handler.
pub fn kill_all(app: &AppHandle) {
    let state = app.state::<PtyState>();
    let mut sessions = state.0.lock().unwrap();
    for (_, mut session) in sessions.drain() {
        let _ = session.killer.kill();
    }
}
