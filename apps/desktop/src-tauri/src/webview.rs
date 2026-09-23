// Owns the Web pane's child webviews (docs/MISSION_CONTROL_PLAN.md Phase M5, §8/§9 Risk 1). Every
// call into Tauri's `unstable` multiwebview API lives in this one file on purpose — a minor Tauri
// bump breaking this surface should mean fixing one file, not hunting through the app.
//
// Keyed by `page_id` (frontend-generated, no DB row — pages are as ephemeral as PTYs, §10 Open
// Question 1 applies equally here), via a `web-{page_id}` webview label.
//
// M6's `browser read`/`browser console` need a value *out* of a webview showing arbitrary,
// untrusted agent-browsed content — and `Webview::eval` is fire-and-forget by design (no return
// channel), for the same reason Tauri's IPC never lets a remote-origin page invoke commands
// without an explicit capability grant: a website the agent opened must not get a back door into
// this app's Rust layer. So results come out through two channels, both landing in the same
// `EvalState` oneshot map, never through `invoke`:
//
// - `rama-ipc://ipc/{ok|err}/{token}` — an async URI-scheme protocol (AGENT_BROWSER_PLAN.md
//   AB0), registered app-wide in `lib.rs` and fetched via `fetch(url, {method:"POST", body})`
//   from the injected eval script. The POST body carries the value, so this is the channel that
//   scales to a snapshot-sized payload without `rama-eval://`'s ~2-3x `encodeURIComponent`
//   blowup or any URL-length ceiling. `UriSchemeContext::webview_label()` (verified against the
//   Tauri 2.11.5 source — not yet exercised against a real hardened CSP) tells the handler which
//   page called, though the token alone is already enough to disambiguate.
// - `rama-eval://ok?token=…&value=…` — the original small-value/nav-based channel, kept as the
//   fallback the eval script's own `fetch(...).catch()` reaches for. A `location.href` navigation
//   is not `connect-src`-governed, so this is the one channel guaranteed to survive a remote
//   page's own CSP (AGENT_BROWSER_PLAN.md §4 hypothesis 4 — the plan's highest-probability
//   failure, and one no amount of source-reading can confirm; it needs a live round-trip against
//   a CSP-hardened site, e.g. github.com or youtube.com, before anything built on `rama-ipc`
//   alone is trusted). `on_navigation` on every page recognizes and cancels (`false`) both
//   schemes before they ever reach the real page — untrusted content never gains IPC access, and
//   the "navigation" it attempted doesn't go anywhere.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::webview::WebviewBuilder;
use tauri::{http, AppHandle, LogicalPosition, LogicalSize, Manager, UriSchemeContext, UriSchemeResponder, WebviewUrl};

#[derive(Default)]
pub struct EvalState(Mutex<HashMap<String, tokio::sync::oneshot::Sender<Result<String, String>>>>);

// AGENT_BROWSER_PLAN.md AB1 — built from `packages/page-runtime/src/hook.ts` by `bun run build`
// in that package; `build.rs` runs it before every `cargo build`/`cargo check` so this
// `include_str!` never goes stale relative to the TS source. Replaces the old inline
// CONSOLE_HOOK_SCRIPT (a 200-entry console ring and nothing else) with a still-tiny (<5KB
// minified, asserted in that package's own tests) bundle that also tracks in-flight network
// activity and DOM mutation timing for AB5's `settle()`. A `const` (not read at runtime) so a
// missing `dist/hook.iife.js` is a build-time error, not a silently-empty hook in production.
const HOOK_SCRIPT: &str = include_str!("../../../../packages/page-runtime/dist/hook.iife.js");

// AGENT_BROWSER_PLAN.md AB2 — the lazy a11y-walker bundle (`packages/page-runtime/src/dom.ts`).
// Unlike `HOOK_SCRIPT`, this is never an `initialization_script` — `webview_snapshot` below
// prepends its full source ahead of a call to `window.__ramaSnapshot(...)` on every invocation.
// That's cheap and correct rather than wasteful: `dom.ts` guards its own install behind
// `window.__ramaDomLoaded`, so re-sending it to a page that already has it is a same-tick no-op,
// and it means a page that navigated since the last snapshot always gets it reinstalled without
// this file needing to track "is it loaded" state of its own.
const DOM_SCRIPT: &str = include_str!("../../../../packages/page-runtime/dist/dom.iife.js");

fn page_webview_label(page_id: &str) -> String {
    format!("web-{page_id}")
}

fn eval_token() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{nanos:x}{n:x}")
}

// Recognized by every page's `on_navigation` handler below — never actually allowed to navigate.
fn install_eval_bridge(builder: WebviewBuilder<tauri::Wry>, app: AppHandle) -> WebviewBuilder<tauri::Wry> {
    builder.initialization_script(HOOK_SCRIPT).on_navigation(move |url| {
        if url.scheme() != "rama-eval" {
            return true;
        }
        let ok = url.host_str() == Some("ok");
        let mut token: Option<String> = None;
        let mut value: Option<String> = None;
        for (k, v) in url.query_pairs() {
            match k.as_ref() {
                "token" => token = Some(v.into_owned()),
                "value" => value = Some(v.into_owned()),
                _ => {}
            }
        }
        if let (Some(token), Some(value)) = (token, value) {
            let sender = {
                let state = app.state::<EvalState>();
                let mut pending = state.0.lock().unwrap_or_else(|e| e.into_inner());
                pending.remove(&token)
            };
            if let Some(tx) = sender {
                let _ = tx.send(if ok { Ok(value) } else { Err(value) });
            }
        }
        false
    })
}

// Registered via `.register_asynchronous_uri_scheme_protocol("rama-ipc", handle_rama_ipc)` in
// lib.rs's builder. Path is `/{ok|err}/{token}` (scheme authority is unused — any host works,
// the injected script sends `rama-ipc://ipc/ok/{token}`); the POST body is the value. Resolves
// the same `EvalState` oneshot map `on_navigation`'s `rama-eval://` handler resolves, so a value
// can arrive on either channel and the caller in `webview_eval` doesn't need to know which one.
// `Access-Control-Allow-Origin: *` on the response isn't for the caller (nothing reads the
// response body — the eval script's `fetch(...).then` is unused, only `.catch` matters) but
// keeps a same-request CORS rejection from masquerading as the CSP failure AB0 is actually
// trying to detect.
pub fn handle_rama_ipc(ctx: UriSchemeContext<'_, tauri::Wry>, request: http::Request<Vec<u8>>, responder: UriSchemeResponder) {
    let mut segments = request.uri().path().trim_start_matches('/').splitn(2, '/');
    let ok = segments.next() == Some("ok");
    let token = segments.next().unwrap_or("").to_string();
    let value = String::from_utf8_lossy(request.body()).into_owned();

    let sender = {
        let state = ctx.app_handle().state::<EvalState>();
        let mut pending = state.0.lock().unwrap_or_else(|e| e.into_inner());
        pending.remove(&token)
    };
    if let Some(tx) = sender {
        let _ = tx.send(if ok { Ok(value) } else { Err(value) });
    }

    let response = http::Response::builder()
        .status(204)
        .header("Access-Control-Allow-Origin", "*")
        .body(Vec::new())
        .unwrap();
    responder.respond(response);
}

#[tauri::command]
pub fn webview_create(app: AppHandle, window_label: String, page_id: String, url: String) -> Result<(), String> {
    // `get_webview_window(...).webview.window()`, not the bare `get_window` — every other call
    // site in this codebase (lib.rs, drag.rs, window_registry.rs) resolves window labels via
    // `get_webview_window`; `get_window` is the lower-level, `#[cfg(feature = "unstable")]` API and
    // isn't guaranteed to stay on the same resolution path across Tauri versions. `WebviewWindow`
    // has no `add_child` of its own, so unwrap back to the `Window` it wraps for that call.
    let webview_window = app.get_webview_window(&window_label).ok_or_else(|| "no such window".to_string())?;
    let window = AsRef::<tauri::Webview<tauri::Wry>>::as_ref(&webview_window).window();
    let parsed = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    let label = page_webview_label(&page_id);
    let builder = install_eval_bridge(WebviewBuilder::new(&label, WebviewUrl::External(parsed)), app);
    // Created hidden at a near-zero size — useWebviewVisibility's ResizeObserver issues the first
    // real webview_set_bounds right after mount, so this never flashes at the window's corner.
    window
        .add_child(builder, LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0))
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn webview_navigate(app: AppHandle, page_id: String, url: String) -> Result<(), String> {
    let webview = app.get_webview(&page_webview_label(&page_id)).ok_or_else(|| "no such page".to_string())?;
    let parsed = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    webview.navigate(parsed).map_err(|e| e.to_string())
}

// Reload/back/forward used to be routed through `webview_eval`'s ack round-trip (`history.back();
// return '';`, signaled back via a `rama-eval://` navigation — see the module doc). That's broken
// for exactly these three calls: the signal itself is a navigation (`location.href = 'rama-eval:...'`),
// dispatched synchronously right after `history.back()`/`location.reload()` queue theirs, so the two
// navigations race on the same frame. Whichever wins, the eval promise settles either way — but the
// *actual* back/forward/reload can lose that race and never happen, which is exactly what "the
// button does nothing" looks like. These three go straight to Tauri/wry instead: `.reload()` is a
// real API on Webview, and back/forward fire `webview.eval` directly with no ack expected, so there's
// no second navigation competing with the one the button asked for.
#[tauri::command]
pub fn webview_reload(app: AppHandle, page_id: String) -> Result<(), String> {
    let webview = app.get_webview(&page_webview_label(&page_id)).ok_or_else(|| "no such page".to_string())?;
    webview.reload().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn webview_go_back(app: AppHandle, page_id: String) -> Result<(), String> {
    let webview = app.get_webview(&page_webview_label(&page_id)).ok_or_else(|| "no such page".to_string())?;
    webview.eval("history.back();").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn webview_go_forward(app: AppHandle, page_id: String) -> Result<(), String> {
    let webview = app.get_webview(&page_webview_label(&page_id)).ok_or_else(|| "no such page".to_string())?;
    webview.eval("history.forward();").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn webview_set_bounds(app: AppHandle, page_id: String, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    let webview = app.get_webview(&page_webview_label(&page_id)).ok_or_else(|| "no such page".to_string())?;
    webview.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    webview.set_size(LogicalSize::new(width.max(1.0), height.max(1.0))).map_err(|e| e.to_string())
}

// docs/MISSION_CONTROL_PLAN.md §8 Phase M5 — "the rule that keeps it survivable." A native child
// webview always paints above the DOM, so useWebviewVisibility (WebStage.tsx) calls this whenever
// the Web pane isn't the active pane, Mission Control is collapsed, or a modal (Settings, the
// command palette) is open — otherwise it renders on top of them regardless of z-index.
#[tauri::command]
pub fn webview_set_visible(app: AppHandle, page_id: String, visible: bool) -> Result<(), String> {
    let webview = app.get_webview(&page_webview_label(&page_id)).ok_or_else(|| "no such page".to_string())?;
    if visible { webview.show() } else { webview.hide() }.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn webview_destroy(app: AppHandle, page_id: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&page_webview_label(&page_id)) {
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// M6's `browser read`/`browser console`, and AB2's `snapshot` — `expr` is always a hardcoded
// expression this app supplies (never agent- or page-controlled text), so interpolating it into
// the eval script is not an injection vector; only its *result*, coming back from untrusted page
// content, is treated as data (a JS string), never re-executed. See the module doc comment for
// why this goes out through a URI scheme / `on_navigation` instead of an IPC `invoke` callback.
//
// `timeout_ms` defaults to 8s (today's hard-coded value) but is now a real argument — AB5's
// `settle()` legitimately needs up to 30s, which the old constant made unreachable.
const DEFAULT_EVAL_TIMEOUT_MS: u64 = 8_000;

#[tauri::command]
pub async fn webview_eval(
    app: AppHandle,
    eval_state: tauri::State<'_, EvalState>,
    page_id: String,
    expr: String,
    timeout_ms: Option<u64>,
) -> Result<String, String> {
    let webview = app.get_webview(&page_webview_label(&page_id)).ok_or_else(|| "no such page".to_string())?;
    let token = eval_token();
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    eval_state.0.lock().map_err(|e| e.to_string())?.insert(token.clone(), tx);

    // Tries the `rama-ipc://` POST-body channel first (no size ceiling, no encodeURIComponent
    // blowup); falls back to the `rama-eval://` navigation only if `fetch` itself is missing or
    // its promise rejects — which is exactly what a CSP `connect-src` block looks like from the
    // page's side. See the module doc for why both exist.
    // AGENT_BROWSER_PLAN.md AB5 — `settle()`/action ops are genuinely async (they poll over real
    // time), so `__v` may come back as a Promise rather than a value. Detected structurally
    // (`typeof __v.then === 'function'`) rather than `instanceof Promise`, since a happy-dom-style
    // thenable or a cross-realm Promise from the page itself might not share this realm's
    // constructor. A synchronous `expr` (every eval before this phase) is unaffected — `__v.then`
    // is undefined and it falls straight to the old `__send(true,__v)` path.
    let js = format!(
        "(function(){{\
           var __token='{token}';\
           function __send(__ok,__value){{\
             var __body;try{{__body=String(__value);}}catch(__e){{__body='';}}\
             var __path='rama-ipc://ipc/'+(__ok?'ok':'err')+'/'+__token;\
             if(typeof fetch==='function'){{\
               fetch(__path,{{method:'POST',body:__body}}).catch(function(){{\
                 location.href='rama-eval://'+(__ok?'ok':'err')+'?token='+encodeURIComponent(__token)+'&value='+encodeURIComponent(__body);\
               }});\
             }}else{{\
               location.href='rama-eval://'+(__ok?'ok':'err')+'?token='+encodeURIComponent(__token)+'&value='+encodeURIComponent(__body);\
             }}\
           }}\
           try{{\
             var __v=(function(){{{expr}}})();\
             if(__v&&typeof __v.then==='function'){{\
               __v.then(function(__r){{__send(true,__r);}},function(__e){{__send(false,__e);}});\
             }}else{{\
               __send(true,__v);\
             }}\
           }}catch(__e){{__send(false,__e);}}\
         }})();"
    );
    if let Err(e) = webview.eval(&js) {
        eval_state.0.lock().ok().map(|mut m| m.remove(&token));
        return Err(e.to_string());
    }

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_EVAL_TIMEOUT_MS));
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(inner)) => inner,
        Ok(Err(_)) => Err("eval channel dropped".to_string()),
        Err(_) => {
            eval_state.0.lock().ok().map(|mut m| m.remove(&token));
            Err("timed out waiting for the page to respond — it may still be loading".to_string())
        }
    }
}

const SNAPSHOT_TIMEOUT_MS: u64 = 15_000;

// AGENT_BROWSER_PLAN.md AB2 — `browser snapshot`'s native leg. Always re-sends `DOM_SCRIPT`
// ahead of the call (see that const's own comment for why that's cheap, not wasteful) rather than
// exposing a separate "inject the bundle" command — one round trip, one place that can fail.
// `window.__ramaSnapshot` returns a JSON string (`{text, gen, refCount}`), not the raw §6.1 text,
// so the caller doesn't need a second eval to learn the generation the refs were assigned at —
// see `dom.ts` for the exact shape. `depth` is matched against a fixed set rather than
// interpolated as-is: it reaches this function from an already-validated Zod enum on the engine
// side, but nothing forces that to stay true forever, and this is string interpolation into a
// script that's about to run.
#[tauri::command]
pub async fn webview_snapshot(
    app: AppHandle,
    eval_state: tauri::State<'_, EvalState>,
    page_id: String,
    depth: Option<String>,
) -> Result<String, String> {
    let depth_js = if depth.as_deref() == Some("full") { "full" } else { "outline" };
    let expr = format!("{DOM_SCRIPT}\nreturn window.__ramaSnapshot('{depth_js}');");
    webview_eval(app, eval_state, page_id, expr, Some(SNAPSHOT_TIMEOUT_MS)).await
}

// AGENT_BROWSER_PLAN.md AB3 — `read` v2's native leg. Same "always re-send DOM_SCRIPT" shape as
// `webview_snapshot`, for the same reason (dom.ts's own `__ramaDomLoaded` guard makes that cheap,
// not wasteful). Given the same timeout budget as snapshot: Readability's `parse()` walks the
// whole cloned document, which is comparable work to the a11y walker.
const READ_TIMEOUT_MS: u64 = 15_000;

#[tauri::command]
pub async fn webview_read(app: AppHandle, eval_state: tauri::State<'_, EvalState>, page_id: String) -> Result<String, String> {
    let expr = format!("{DOM_SCRIPT}\nreturn window.__ramaRead();");
    webview_eval(app, eval_state, page_id, expr, Some(READ_TIMEOUT_MS)).await
}

// AGENT_BROWSER_PLAN.md AB4 — the four action ops' native leg. `action_json` is already a
// Zod-validated, JSON-serialized `{op, ref?, text?, submit?, key?, to?}` object built by
// tools/browser.ts and passed straight through — untouched, since it's opaque to Rust and
// `window.__ramaAction` (dom.ts) does the actual parsing and validation. `{action_json:?}` uses
// Rust's `Debug` string escaping to embed it as a safe, already-quoted JS string literal (handles
// `"`, `\`, and control characters the same way `serde_json` would); nothing here re-executes the
// JSON's *content* as code, only passes it as data into `__ramaAction`'s own `JSON.parse`.
const ACTION_TIMEOUT_MS: u64 = 10_000;

#[tauri::command]
pub async fn webview_action(
    app: AppHandle,
    eval_state: tauri::State<'_, EvalState>,
    page_id: String,
    action_json: String,
) -> Result<String, String> {
    let expr = format!("{DOM_SCRIPT}\nreturn window.__ramaAction({action_json:?});");
    webview_eval(app, eval_state, page_id, expr, Some(ACTION_TIMEOUT_MS)).await
}
