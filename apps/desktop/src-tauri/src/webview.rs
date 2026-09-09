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
// this app's Rust layer. So results come out through `on_navigation` instead of `invoke`: the
// injected script's result triggers a `rama-eval://` navigation, which every page's `on_navigation`
// handler recognizes, decodes, and cancels (`false`) before it ever reaches the real page — the
// untrusted content never gains IPC access, and the "navigation" it attempted doesn't go anywhere.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl};

#[derive(Default)]
pub struct EvalState(Mutex<HashMap<String, tokio::sync::oneshot::Sender<Result<String, String>>>>);

const CONSOLE_HOOK_SCRIPT: &str = r#"(function () {
  if (window.__ramaConsoleHooked) return;
  window.__ramaConsoleHooked = true;
  window.__ramaConsole = [];
  var push = function (level, args) {
    try {
      window.__ramaConsole.push(level + ': ' + Array.prototype.map.call(args, String).join(' '));
      if (window.__ramaConsole.length > 200) window.__ramaConsole.shift();
    } catch (e) {}
  };
  ['log', 'warn', 'error', 'info'].forEach(function (level) {
    var orig = console[level];
    console[level] = function () {
      push(level, arguments);
      return orig.apply(console, arguments);
    };
  });
})();"#;

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
    builder.initialization_script(CONSOLE_HOOK_SCRIPT).on_navigation(move |url| {
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

#[tauri::command]
pub fn webview_create(app: AppHandle, window_label: String, page_id: String, url: String) -> Result<(), String> {
    let window = app.get_window(&window_label).ok_or_else(|| "no such window".to_string())?;
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

// M6's `browser read`/`browser console` — `expr` is always one of two hardcoded expressions this
// app supplies (never agent- or page-controlled text), so interpolating it into the eval script is
// not an injection vector; only its *result*, coming back from untrusted page content, is treated
// as data (a JS string), never re-executed. See the module doc comment for why this goes out
// through `on_navigation` instead of an IPC `invoke` callback.
#[tauri::command]
pub async fn webview_eval(
    app: AppHandle,
    eval_state: tauri::State<'_, EvalState>,
    page_id: String,
    expr: String,
) -> Result<String, String> {
    let webview = app.get_webview(&page_webview_label(&page_id)).ok_or_else(|| "no such page".to_string())?;
    let token = eval_token();
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    eval_state.0.lock().map_err(|e| e.to_string())?.insert(token.clone(), tx);

    let js = format!(
        "(function(){{try{{var __v=(function(){{{expr}}})();location.href='rama-eval://ok?token='+encodeURIComponent('{token}')+'&value='+encodeURIComponent(String(__v));}}catch(__e){{location.href='rama-eval://err?token='+encodeURIComponent('{token}')+'&value='+encodeURIComponent(String(__e));}}}})();"
    );
    if let Err(e) = webview.eval(&js) {
        eval_state.0.lock().ok().map(|mut m| m.remove(&token));
        return Err(e.to_string());
    }

    match tokio::time::timeout(Duration::from_secs(8), rx).await {
        Ok(Ok(inner)) => inner,
        Ok(Err(_)) => Err("eval channel dropped".to_string()),
        Err(_) => {
            eval_state.0.lock().ok().map(|mut m| m.remove(&token));
            Err("timed out waiting for the page to respond — it may still be loading".to_string())
        }
    }
}
