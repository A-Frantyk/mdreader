mod commands;
mod files;
mod render;
#[cfg(desktop)]
mod menu;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

// Generates `pub const MARKDOWN_EXTENSIONS: &[&str]` from `tauri.conf.json`'s
// bundle.fileAssociations at *build* time — see build.rs's
// `generate_markdown_extensions` doc comment for why this can't be read
// back from `Context::config()` at runtime.
include!(concat!(env!("OUT_DIR"), "/markdown_extensions.rs"));

/// Every entry point funnels through `queue`, which always pushes here
/// first. The `main` window is created before `.setup()` runs (Tauri
/// builds config windows, then calls the setup hook), so at cold start
/// `get_webview_window("main")` is already `Some` even though the page
/// hasn't loaded and has no listener attached yet — emitting straight to
/// it would silently lose the event. Queuing unconditionally and treating
/// the emitted event as a hint (not the payload) means the frontend can
/// always recover by draining on load, regardless of timing.
///
/// `frontend_ready` guards the same race for the close handshake (see
/// `on_window_event` in `run`): a `CloseRequested` firing before `app.js`
/// registers its `close-requested` listener would have its
/// `prevent_close()` + emit silently dropped. The frontend flips this via
/// `mark_frontend_ready` only once that listener exists.
pub(crate) struct AppState {
    pub(crate) pending: Mutex<Vec<PathBuf>>,
    pub(crate) markdown_extensions: HashSet<String>,
    pub(crate) frontend_ready: AtomicBool,
}

fn queue(app: &AppHandle, path: PathBuf) {
    app.state::<AppState>().pending.lock().unwrap().push(path);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("files-pending", ());
        let _ = window.set_focus();
    }
}

fn queue_markdown_args(app: &AppHandle, paths: impl Iterator<Item = PathBuf>) {
    let state = app.state::<AppState>();
    let markdown_paths: Vec<PathBuf> = paths.filter(|p| files::is_markdown_path(&state, p)).collect();
    drop(state);
    for path in markdown_paths {
        queue(app, path);
    }
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
            frontend_ready: AtomicBool::new(false),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());

    // `Builder::menu` (not `App::set_menu` in `.setup()`), so
    // `Builder::build`'s "only install the macOS default when no menu was
    // set" check suppresses that default outright instead of
    // installing-then-replacing it. See menu.rs's module doc for why the
    // default itself can't be reused.
    #[cfg(desktop)]
    let builder = builder.menu(menu::build).on_menu_event(menu::handle);

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
            // Prewarm syntect's syntax set (~360 KB deserialization) so a
            // document with code fences doesn't block on the first render.
            std::thread::spawn(|| std::sync::LazyLock::force(&render::SYNTAX_SET));

            // `args_os` (not `args`) so a non-UTF-8 filename can't panic
            // the app before it paints.
            queue_markdown_args(app.handle(), std::env::args_os().skip(1).map(PathBuf::from));
            Ok(())
        })
        // `prevent_close()` is called synchronously, in the same handler
        // invocation that receives the event — the runtime checks whether
        // it was called immediately after running listeners, so any
        // `await` before it would let the window close anyway.
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !window.state::<AppState>().frontend_ready.load(Ordering::Relaxed) {
                    return; // no listener could exist yet — let it close normally
                }
                api.prevent_close();
                let _ = window.emit("close-requested", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::markdown_extensions,
            commands::drain_pending_files,
            commands::open_markdown_file,
            commands::read_markdown_source,
            commands::render_markdown,
            commands::save_markdown_file,
            commands::save_markdown_file_as,
            commands::mark_frontend_ready,
            commands::quit_app
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {
            // RunEvent::Opened only exists on macOS/iOS/Android
            // (tauri-2.11.5/src/app.rs:257-263) — matching on it
            // unconditionally is a compile error on Windows/Linux, not
            // just a no-op, so this has to be cfg-gated to the one
            // platform that's both in scope and needs it.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                let paths = urls.into_iter().filter_map(|url| {
                    (url.scheme() == "file").then(|| url.to_file_path().ok()).flatten()
                });
                queue_markdown_args(_app_handle, paths);
            }
        });
}
