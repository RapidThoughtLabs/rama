// AGENT_BROWSER_PLAN.md AB1 — `webview.rs` `include_str!`s two files built from
// `packages/page-runtime` (a Bun/TS workspace package, not a Rust crate — Cargo has no way to
// depend on it directly). Shelling out to `bun run build` here, before `tauri_build::build()`,
// is what keeps those two `include_str!`s from going stale: without this, a change to
// `page-runtime/src/*.ts` would silently not appear in the app until someone remembered to run
// its build script by hand. `cargo:rerun-if-changed` is scoped to that package's `src/` so a
// plain `cargo check` with no page-runtime changes doesn't pay a `bun` invocation every time.
fn main() {
    let page_runtime_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/page-runtime");
    println!("cargo:rerun-if-changed={}", page_runtime_dir.join("src").display());

    let status = std::process::Command::new("bun").arg("run").arg("build").current_dir(&page_runtime_dir).status();
    match status {
        Ok(s) if s.success() => {}
        Ok(s) => panic!("`bun run build` in packages/page-runtime failed with {s} — see its output above"),
        Err(e) => panic!(
            "failed to run `bun run build` in packages/page-runtime ({e}) — is `bun` on PATH? \
             webview.rs's include_str!s need packages/page-runtime/dist/*.iife.js to exist."
        ),
    }

    tauri_build::build()
}
