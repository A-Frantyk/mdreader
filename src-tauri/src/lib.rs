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

// Generated from tauri.conf.json's bundle.fileAssociations at build time — see build.rs.
include!(concat!(env!("OUT_DIR"), "/markdown_extensions.rs"));

/// Queue-always pattern for both the file-open race and the close handshake — see CLAUDE.md.
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

    // Builder::menu, not App::set_menu in .setup() — suppresses Builder::build's macOS default
    // menu outright rather than installing then replacing it.
    #[cfg(desktop)]
    let builder = builder.menu(menu::build).on_menu_event(menu::handle);

    // macOS-excluded — see CLAUDE.md's single-instance-plugin invariant.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        queue_markdown_args(app, argv.into_iter().skip(1).map(PathBuf::from));
    }));

    builder
        .setup(|app| {
            // Prewarm syntect's syntax set (~360 KB deserialization) off the render hot path.
            std::thread::spawn(|| std::sync::LazyLock::force(&render::SYNTAX_SET));
            // args_os, not args: a non-UTF-8 filename must not panic before the app paints.
            queue_markdown_args(app.handle(), std::env::args_os().skip(1).map(PathBuf::from));
            Ok(())
        })
        // prevent_close() must run synchronously here — see CLAUDE.md's close-handshake invariant.
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !window.state::<AppState>().frontend_ready.load(Ordering::Relaxed) {
                    return;
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
            commands::quit_app,
            commands::set_zoom
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {
            // RunEvent::Opened is macOS/iOS/Android-only (tauri-2.11.5/src/app.rs:257-263) —
            // matching it unconditionally is a compile error, not a no-op, on Windows/Linux.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                let paths = urls.into_iter().filter_map(|url| {
                    (url.scheme() == "file").then(|| url.to_file_path().ok()).flatten()
                });
                queue_markdown_args(_app_handle, paths);
            }
        });
}
