//! The 10 Tauri IPC commands the frontend calls, plus the render+scope-grant
//! tail shared by the file-open path and the live-preview path.

use std::path::Path;
use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager};

use crate::files::{atomic_write, normalize_markdown_path, require_markdown_path};
use crate::{render, AppState, MARKDOWN_EXTENSIONS};

#[derive(serde::Serialize)]
pub(crate) struct OpenedDocument {
    path: String,
    doc: render::RenderedDoc,
}

/// Render markdown source and grant the webview's asset-protocol scope
/// access to exactly the local images it references. Shared by the
/// file-open path and the live-preview path (`render_markdown`) — both
/// need the same grant-on-render behavior, because `render()` returns a
/// fresh asset list on every call and a re-render that introduces a new
/// image reference must re-grant scope or the image silently fails to
/// load. Grants are additive and never revoked for the app's lifetime.
///
/// Under live preview this runs on every debounced keystroke, and a
/// half-typed path (`![](diagram.png)` mid-type grants `d`, `di`, `dia`,
/// …) would flood the scope set without the `is_file()` filter below.
pub(crate) fn render_and_grant(app: &AppHandle, source: &str, base_dir: &Path) -> render::RenderedDoc {
    let (doc, assets) = render::render(source, base_dir);

    let scope = app.asset_protocol_scope();
    for asset in assets.iter().filter(|a| a.is_file()) {
        let _ = scope.allow_file(asset);
    }

    doc
}

fn load_document(app: &AppHandle, path: &Path) -> Result<OpenedDocument, String> {
    let source = std::fs::read_to_string(path)
        .map_err(|e| format!("Couldn't read {}: {}", path.display(), e))?;

    let base_dir = path.parent().unwrap_or(Path::new("."));
    let doc = render_and_grant(app, &source, base_dir);

    Ok(OpenedDocument {
        path: path.to_string_lossy().into_owned(),
        doc,
    })
}

/// Returns `MARKDOWN_EXTENSIONS` in its declared order rather than
/// iterating `state.markdown_extensions` (a `HashSet`, so order is
/// unspecified) — the frontend's save-as filter list feeds the native
/// save dialog, and NSSavePanel/the Windows common dialog both append the
/// *first* filter extension when the user types a bare filename, so a
/// `HashSet`'s iteration order would make that default nondeterministic.
#[tauri::command]
pub(crate) fn markdown_extensions() -> Vec<String> {
    MARKDOWN_EXTENSIONS.iter().map(|s| s.to_string()).collect()
}

#[tauri::command(async)]
pub(crate) fn drain_pending_files(state: tauri::State<AppState>) -> Vec<String> {
    std::mem::take(&mut *state.pending.lock().unwrap())
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

#[tauri::command(async)]
pub(crate) fn open_markdown_file(
    app: AppHandle,
    state: tauri::State<AppState>,
    path: String,
) -> Result<OpenedDocument, String> {
    let path = Path::new(&path);
    require_markdown_path(&state, path)?;
    load_document(&app, path)
}

/// Kept separate from `open_markdown_file` — doubling that command's IPC
/// payload with source text nobody reads in view mode would be wasteful.
#[tauri::command(async)]
pub(crate) fn read_markdown_source(state: tauri::State<AppState>, path: String) -> Result<String, String> {
    require_markdown_path(&state, Path::new(&path))?;
    std::fs::read_to_string(&path).map_err(|e| format!("Couldn't read {}: {}", path, e))
}

#[tauri::command(async)]
pub(crate) fn render_markdown(
    app: AppHandle,
    source: String,
    base_path: Option<String>,
) -> Result<render::RenderedDoc, String> {
    let base_dir = match &base_path {
        Some(p) => Path::new(p).parent().map(|p| p.to_path_buf()).unwrap_or_else(|| std::path::PathBuf::from(".")),
        None => std::env::current_dir().map_err(|e| e.to_string())?,
    };
    Ok(render_and_grant(&app, &source, &base_dir))
}

/// A narrow, single-purpose command rather than `tauri-plugin-fs` — that
/// plugin would grant the webview broad, scope-configured filesystem
/// access, and this app renders untrusted markdown, so a command that
/// writes exactly one extension-validated path is a materially smaller
/// attack surface than a general-purpose fs bridge.
///
/// Writes to a temp file in the *same directory* as the target, then
/// renames over it: same-directory matters because a cross-filesystem
/// rename isn't atomic, and `std::fs::rename` replaces an existing
/// destination on both Windows and Unix, so one code path covers both
/// platforms without a `#[cfg]` split.
#[tauri::command(async)]
pub(crate) fn save_markdown_file(
    state: tauri::State<AppState>,
    path: String,
    contents: String,
) -> Result<(), String> {
    let path = Path::new(&path);
    require_markdown_path(&state, path)?;
    atomic_write(path, &contents)
}

#[tauri::command(async)]
pub(crate) fn save_markdown_file_as(
    state: tauri::State<AppState>,
    path: String,
    contents: String,
) -> Result<String, String> {
    let target = normalize_markdown_path(&state, Path::new(&path));
    atomic_write(&target, &contents)?;
    Ok(target.to_string_lossy().into_owned())
}

/// Flip once `app.js`'s `close-requested` listener is registered — see
/// `AppState::frontend_ready`'s doc comment for why this exists.
#[tauri::command]
pub(crate) fn mark_frontend_ready(state: tauri::State<AppState>) {
    state.frontend_ready.store(true, Ordering::Relaxed);
}

pub(crate) const ZOOM_MIN: f64 = 0.5;
pub(crate) const ZOOM_MAX: f64 = 3.0;

/// `factor` round-trips through JS `localStorage` (a string) before it gets
/// here, so this guards against corrupted/hand-edited storage the same way
/// `js/splitter.js`'s `splitRatio` guards its own persisted number: NaN
/// (parse failure) falls back to unzoomed rather than propagating into
/// `Webview::set_zoom`, whose native backends aren't guaranteed to reject
/// it gracefully.
pub(crate) fn clamp_zoom(factor: f64) -> f64 {
    if !factor.is_finite() {
        return 1.0;
    }
    factor.clamp(ZOOM_MIN, ZOOM_MAX)
}

/// `tauri::Webview<R>` is a `CommandArg` (grabbed straight off the invoke
/// message, `tauri-2.11.5/src/webview/mod.rs:2330`), so this needs no
/// `AppHandle`/window lookup. Deliberately a custom command rather than the
/// core plugin's `plugin:webview|set_webview_zoom`: that would need
/// `core:webview:allow-set-webview-zoom` added to `capabilities/default.json`,
/// widening the ACL surface a compromised webview (this app renders
/// untrusted markdown) can reach for a single numeric setting. Same
/// reasoning as `save_markdown_file` staying off `tauri-plugin-fs`.
#[tauri::command]
pub(crate) fn set_zoom(webview: tauri::Webview, factor: f64) -> Result<(), String> {
    webview.set_zoom(clamp_zoom(factor)).map_err(|e| e.to_string())
}

/// The only sanctioned way this app ends itself. `AppHandle::exit` sends
/// `Message::RequestExit`, which the runtime turns into an unprevented
/// `RunEvent::ExitRequested` and then `ControlFlow::Exit` directly — it
/// does not re-emit `WindowEvent::CloseRequested`, so calling this from
/// the frontend's already-confirmed quit sequence can't loop back into
/// the same prompt. `window.destroy()` was deliberately not used here: it
/// would need its own capability grant, where `AppHandle::exit` needs
/// none.
#[tauri::command]
pub(crate) fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[cfg(test)]
mod tests;
