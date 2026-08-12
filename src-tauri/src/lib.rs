mod render;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

// Generates `pub const MARKDOWN_EXTENSIONS: &[&str]` from `tauri.conf.json`'s
// bundle.fileAssociations at *build* time — see build.rs's
// `generate_markdown_extensions` doc comment for why this can't be read
// back from `Context::config()` at runtime (it can't, on any platform:
// tauri-utils' codegen unconditionally drops that field when embedding
// the config into the binary).
include!(concat!(env!("OUT_DIR"), "/markdown_extensions.rs"));

/// Markdown-file paths waiting to be opened, plus the set of extensions
/// (from `MARKDOWN_EXTENSIONS`, generated from `tauri.conf.json`'s
/// `bundle.fileAssociations` — the single source of truth, since that's
/// what the OS itself uses to route files to this app) that count as
/// "markdown" for argv/drop filtering.
///
/// Every entry point funnels through `queue`, which always pushes here
/// first. The `main` window is created before `.setup()` runs (Tauri
/// builds config windows, then calls the setup hook), so at cold start
/// `get_webview_window("main")` is already `Some` even though the page
/// hasn't loaded and has no listener attached yet — emitting straight to
/// it would silently lose the event. Queuing unconditionally and treating
/// the emitted event as a hint (not the payload) means the frontend can
/// always recover by draining on load, regardless of timing.
struct AppState {
    pending: Mutex<Vec<PathBuf>>,
    markdown_extensions: HashSet<String>,
}

#[derive(serde::Serialize)]
struct OpenedDocument {
    path: String,
    doc: render::RenderedDoc,
}

fn is_markdown_path(state: &AppState, path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| state.markdown_extensions.contains(&e.to_ascii_lowercase()))
}

/// Read + render a markdown file. Relative image/link destinations are
/// resolved to absolute paths by the renderer itself (it's the only side
/// that knows the document's directory); we just grant the webview's
/// asset-protocol scope access to exactly the image files it found, so
/// opening one document doesn't whitelist anything beyond what it embeds.
fn load_document(app: &AppHandle, path: &std::path::Path) -> Result<OpenedDocument, String> {
    let source = std::fs::read_to_string(path)
        .map_err(|e| format!("Couldn't read {}: {}", path.display(), e))?;

    let base_dir = path.parent().unwrap_or(std::path::Path::new("."));
    let (doc, assets) = render::render(&source, base_dir);

    let scope = app.asset_protocol_scope();
    for asset in &assets {
        let _ = scope.allow_file(asset);
    }

    Ok(OpenedDocument {
        path: path.to_string_lossy().into_owned(),
        doc,
    })
}

/// Queue a path for the frontend to open, and — if the window already
/// exists — nudge it to drain the queue now. See `AppState` for why the
/// nudge is a hint rather than the payload.
fn queue(app: &AppHandle, path: PathBuf) {
    app.state::<AppState>().pending.lock().unwrap().push(path);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("files-pending", ());
        let _ = window.set_focus();
    }
}

fn queue_markdown_args(app: &AppHandle, paths: impl Iterator<Item = PathBuf>) {
    let state = app.state::<AppState>();
    let markdown_paths: Vec<PathBuf> = paths.filter(|p| is_markdown_path(&state, p)).collect();
    drop(state);
    for path in markdown_paths {
        queue(app, path);
    }
}

/// Lets the frontend classify a clicked link ("try to open it as a
/// document" vs "hand it to the OS") without hand-duplicating the
/// extension list that already lives in `tauri.conf.json`.
#[tauri::command]
fn markdown_extensions(state: tauri::State<AppState>) -> Vec<String> {
    state.markdown_extensions.iter().cloned().collect()
}

#[tauri::command(async)]
fn drain_pending_files(state: tauri::State<AppState>) -> Vec<String> {
    std::mem::take(&mut *state.pending.lock().unwrap())
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

#[tauri::command(async)]
fn open_markdown_file(app: AppHandle, path: String) -> Result<OpenedDocument, String> {
    load_document(&app, std::path::Path::new(&path))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    let configured_extensions: HashSet<String> =
        MARKDOWN_EXTENSIONS.iter().map(|s| s.to_string()).collect();

    let builder = tauri::Builder::default()
        .manage(AppState {
            pending: Mutex::new(Vec::new()),
            markdown_extensions: configured_extensions,
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());

    // Entry path 3 (app already running, forward the new process's argv,
    // then let it exit) is Windows/Linux-only. On macOS this plugin
    // forwards `std::env::args()` — but macOS never puts an "Open With"
    // file in argv; it delivers it via `application:openURLs:` (see the
    // RunEvent::Opened handler below), which fires on whichever process
    // LaunchServices routes to — including an already-running one, with
    // no separate process ever spawned. Registering this plugin on macOS
    // meant a repeat "Open With" would connect to the running instance,
    // forward an *empty* argv, and exit — silently dropping the file.
    // Confirmed against tauri-plugin-single-instance's macOS impl.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        queue_markdown_args(app, argv.into_iter().skip(1).map(PathBuf::from));
    }));

    builder
        .setup(|app| {
            // Prewarm syntect's syntax set (a ~360 KB deserialization) on
            // a background thread so it's ready by the time a document
            // with code fences actually needs it, instead of blocking
            // the first render.
            std::thread::spawn(|| std::sync::LazyLock::force(&render::SYNTAX_SET));

            // Entry path 1: cold start on Windows/Linux — the file path
            // is a plain argv entry. `args_os` (not `args`) so a
            // non-UTF-8 filename can't panic the app before it paints.
            queue_markdown_args(app.handle(), std::env::args_os().skip(1).map(PathBuf::from));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            markdown_extensions,
            drain_pending_files,
            open_markdown_file
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Entry path 2: cold start on macOS — the file path never
            // appears in argv, it arrives as RunEvent::Opened, which
            // (like .setup()) always runs after the window is built. The
            // variant itself only exists on macOS/iOS/Android
            // (tauri-2.11.5/src/app.rs:257-263) — matching on it
            // unconditionally is a compile error on Windows/Linux, not
            // just a no-op, so this has to be cfg-gated. Desktop-only
            // scope (Windows/Linux/macOS, no iOS/Android), so gate to
            // exactly the one platform that's both in scope and needs it.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                let paths = urls.into_iter().filter_map(|url| {
                    (url.scheme() == "file").then(|| url.to_file_path().ok()).flatten()
                });
                queue_markdown_args(app_handle, paths);
            }
        });
}
