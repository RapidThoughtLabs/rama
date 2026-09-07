// Owns PTY child processes for Mission Control's Terminal pane (docs/MISSION_CONTROL_PLAN.md
// Phase M2, §6). Rust is the only place in this app with real OS-level pseudo-terminal support —
// Bun's `Bun.spawn` only gives plain pipes, which lack the raw-mode/resize/signal semantics an
// interactive shell needs. Keyed by `terminal_id` (a `terminals` row, engine/src/db/terminals.ts),
// not `chat_id` — a terminal is project-scoped and can outlive any one chat (§0.2), and a project
// can have more than one terminal open at once, which a chat-keyed map could never represent.

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

fn pty_data_event(terminal_id: &str) -> String {
    format!("pty-data:{terminal_id}")
}

fn pty_exit_event(terminal_id: &str) -> String {
    format!("pty-exit:{terminal_id}")
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: tauri::State<PtyState>,
    terminal_id: String,
    command: String,
    args: Vec<String>,
    cwd: String,
    env: HashMap<String, String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // docs/MISSION_CONTROL_PLAN.md §8 Phase M4 — idempotent by `terminal_id`. An agent-created
    // background terminal (bash `background: true`) is spawned in response to a `terminal.created`
    // broadcast the engine sends over the project WS topic; every open window on that project
    // reacts to it (there is no single-leader election between windows), so more than one window
    // can call this for the same terminal_id at nearly the same instant. `PtyState` is one
    // `HashMap` shared by every window of this app instance (`app.state::<PtyState>()`), so the
    // fix belongs here, not in the frontend: the first call wins, the rest are safe no-ops.
    if state.0.lock().map_err(|e| e.to_string())?.contains_key(&terminal_id) {
        return Ok(());
    }

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
        .insert(terminal_id.clone(), PtySession { master: pair.master, writer, killer });

    let reader_app = app.clone();
    let reader_terminal_id = terminal_id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let _ = reader_app.emit(&pty_data_event(&reader_terminal_id), chunk);
                }
                Err(_) => break,
            }
        }

        let exit_code = child.wait().map(|status| status.exit_code()).unwrap_or(1);
        let _ = reader_app.emit(&pty_exit_event(&reader_terminal_id), exit_code);
        reader_app.state::<PtyState>().0.lock().unwrap().remove(&reader_terminal_id);
    });

    Ok(())
}

// Lets the frontend tell, on (re)mount, whether it should attach to an already-running PTY
// (replay scrollback, keep listening) or spawn a fresh one — a terminal's process outlives
// whichever tab/window happens to have it focused.
#[tauri::command]
pub fn pty_is_running(state: tauri::State<PtyState>, terminal_id: String) -> Result<bool, String> {
    Ok(state.0.lock().map_err(|e| e.to_string())?.contains_key(&terminal_id))
}

// docs/MISSION_CONTROL_PLAN.md §6 — lets a freshly opened window reattach to shells started by a
// window that has since closed: it intersects this list against `GET /projects/:id/terminals`
// (a `terminals` row that isn't in this list is rendered "ended — app restarted", not running).
#[tauri::command]
pub fn pty_list_running(state: tauri::State<PtyState>) -> Result<Vec<String>, String> {
    Ok(state.0.lock().map_err(|e| e.to_string())?.keys().cloned().collect())
}

#[tauri::command]
pub fn pty_write(state: tauri::State<PtyState>, terminal_id: String, data: String) -> Result<(), String> {
    let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
    let session = sessions.get_mut(&terminal_id).ok_or_else(|| "no pty running for this terminal".to_string())?;
    session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: tauri::State<PtyState>, terminal_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.0.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&terminal_id).ok_or_else(|| "no pty running for this terminal".to_string())?;
    session
        .master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<PtyState>, terminal_id: String) -> Result<(), String> {
    let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = sessions.remove(&terminal_id) {
        session.killer.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Kills every still-running PTY on full app exit — mirrors `EngineHandle`'s `Drop`-based kill
/// in `engine.rs`, called from `lib.rs`'s existing `RunEvent::Exit` handler. This is Mission
/// Control's Open Question 1: sessions survive windows closing, but not the app quitting.
pub fn kill_all(app: &AppHandle) {
    let state = app.state::<PtyState>();
    let mut sessions = state.0.lock().unwrap();
    for (_, mut session) in sessions.drain() {
        let _ = session.killer.kill();
    }
}
