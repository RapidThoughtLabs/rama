// Spawns and supervises the Bun engine sidecar (docs/IMPLEMENTATION_PLAN.md Phase 1).
//
// Dev-only path resolution: the engine dir is found relative to this crate's manifest dir.
// Production packaging (bundling the engine as a real Tauri sidecar binary) is a later
// concern, already flagged as an open question in the plan's §8.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize)]
pub struct EngineConnectionInfo {
    pub url: String,
    pub token: String,
}

#[derive(Deserialize)]
struct EngineAnnouncement {
    #[serde(rename = "engineUrl")]
    engine_url: String,
    token: String,
}

pub struct EngineHandle {
    child: Child,
    url: String,
    token: String,
}

impl Drop for EngineHandle {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

#[derive(Default)]
pub struct EngineState(pub Mutex<Option<EngineHandle>>);

fn engine_dir() -> PathBuf {
    // CARGO_MANIFEST_DIR is apps/desktop/src-tauri; the engine lives at the repo root's
    // engine/, three levels up (src-tauri -> desktop -> apps -> repo root).
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../engine")
}

/// Spawns `bun run src/index.ts`, blocks briefly to read its one-line connection
/// announcement off stdout, then keeps draining stdout on a background thread so the
/// child's pipe never fills up and blocks it.
pub fn spawn_engine() -> Result<EngineHandle, String> {
    let dir = engine_dir();
    let mut child = Command::new("bun")
        .args(["run", "src/index.ts"])
        .current_dir(&dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("failed to spawn engine (bun run src/index.ts in {dir:?}): {e}"))?;

    let stdout = child.stdout.take().ok_or("engine stdout was not captured")?;
    let mut reader = BufReader::new(stdout);
    let mut first_line = String::new();
    reader
        .read_line(&mut first_line)
        .map_err(|e| format!("failed to read engine announcement: {e}"))?;

    let announcement: EngineAnnouncement = serde_json::from_str(first_line.trim())
        .map_err(|e| format!("failed to parse engine announcement {first_line:?}: {e}"))?;

    std::thread::spawn(move || {
        for line in reader.lines().map_while(Result::ok) {
            println!("[engine] {line}");
        }
    });

    Ok(EngineHandle {
        child,
        url: announcement.engine_url,
        token: announcement.token,
    })
}

#[tauri::command]
pub fn get_engine_connection(state: tauri::State<EngineState>) -> Result<EngineConnectionInfo, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    guard
        .as_ref()
        .map(|h| EngineConnectionInfo { url: h.url.clone(), token: h.token.clone() })
        .ok_or_else(|| "engine not running".to_string())
}
