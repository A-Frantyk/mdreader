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

/// Shared by the file-open and live-preview paths. Scope grants are additive and never
/// revoked — see CLAUDE.md's scope.allow_file invariant for why `is_file()` below matters.
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

/// Declared order, not `state.markdown_extensions` (a HashSet — unordered): NSSavePanel and the
/// Windows common dialog both append the *first* filter extension to a bare typed filename.
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

/// The app's one filesystem write, deliberately not `tauri-plugin-fs` — see CLAUDE.md.
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

/// Flip once the frontend's `close-requested` listener is registered — see `AppState`'s doc comment.
#[tauri::command]
pub(crate) fn mark_frontend_ready(state: tauri::State<AppState>) {
    state.frontend_ready.store(true, Ordering::Relaxed);
}

pub(crate) const ZOOM_MIN: f64 = 0.5;
pub(crate) const ZOOM_MAX: f64 = 3.0;

/// Guards against corrupted/hand-edited localStorage: NaN falls back to unzoomed rather
/// than reaching `Webview::set_zoom`, whose native backends may not reject it gracefully.
pub(crate) fn clamp_zoom(factor: f64) -> f64 {
    if !factor.is_finite() {
        return 1.0;
    }
    factor.clamp(ZOOM_MIN, ZOOM_MAX)
}

/// `tauri::Webview<R>` is a `CommandArg` (tauri-2.11.5/src/webview/mod.rs:2330), no
/// AppHandle lookup needed. Custom command, not the core plugin's `set_webview_zoom` —
/// same smaller-ACL reasoning as `save_markdown_file` staying off `tauri-plugin-fs`.
#[tauri::command]
pub(crate) fn set_zoom(webview: tauri::Webview, factor: f64) -> Result<(), String> {
    webview.set_zoom(clamp_zoom(factor)).map_err(|e| e.to_string())
}

/// The only sanctioned way this app ends itself — see CLAUDE.md's quit invariant.
#[tauri::command]
pub(crate) fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[cfg(test)]
mod tests;
