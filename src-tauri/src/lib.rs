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
///
/// `frontend_ready` guards the same class of race for the close handshake
/// (see the `on_window_event` handler in `run`): a `CloseRequested` that
/// fires before `app.js` has registered its `close-requested` listener
/// would have its `prevent_close()` + emit silently dropped, leaving the
/// window unclosable. The frontend flips this to `true` (via
/// `mark_frontend_ready`) only after that listener exists; until then the
/// handler lets the window close normally instead of trying to hand off
/// to a listener that isn't there yet.
struct AppState {
    pending: Mutex<Vec<PathBuf>>,
    markdown_extensions: HashSet<String>,
    frontend_ready: AtomicBool,
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

/// Ensure a save-dialog result ends up with a markdown extension, for the
/// "create a new document" flow: the OS save dialog lets a user type a
/// bare name (`notes`) or, on GTK, never appends an extension at all even
/// when a filter is set. Appends `MARKDOWN_EXTENSIONS[0]` rather than
/// replacing whatever's already there — `Path::set_extension` would turn
/// `my.notes` into `my.md`, silently discarding part of the name the user
/// typed. Appending also matches what the native save dialogs themselves
/// do on macOS/Windows when they add a default extension, so all three
/// platforms converge on the same result. Already-markdown paths (matched
/// via `is_markdown_path`, so extension casing is preserved) pass through
/// unchanged.
fn normalize_markdown_path(state: &AppState, path: &std::path::Path) -> PathBuf {
    if is_markdown_path(state, path) {
        return path.to_path_buf();
    }
    let mut file_name = path.file_name().unwrap_or_default().to_owned();
    file_name.push(".");
    file_name.push(MARKDOWN_EXTENSIONS[0]);
    path.with_file_name(file_name)
}

/// Render markdown source and grant the webview's asset-protocol scope
/// access to exactly the local images it references. Shared by the
/// file-open path and the live-preview path (`render_markdown`) — both
/// need the same grant-on-render behavior, because `render()` returns a
/// fresh asset list on every call and a re-render that introduces a new
/// image reference must re-grant scope or the image silently fails to
/// load. Grants are additive and never revoked for the app's lifetime.
///
/// Under live-preview re-rendering this function runs on every debounced
/// keystroke, and `render()`'s asset list reflects whatever the image
/// destination *currently* is — including a half-typed path mid-edit
/// (`![](diagram.png)` grants scope for `d`, `di`, `dia`, … along the
/// way). Filtering to paths that exist on disk before granting keeps that
/// stream of transient, never-real paths out of the scope set; a grant
/// for a path that doesn't exist yet is useless anyway, since there's
/// nothing there for the asset protocol to serve.
fn render_and_grant(app: &AppHandle, source: &str, base_dir: &std::path::Path) -> render::RenderedDoc {
    let (doc, assets) = render::render(source, base_dir);

    let scope = app.asset_protocol_scope();
    for asset in assets.iter().filter(|a| a.is_file()) {
        let _ = scope.allow_file(asset);
    }

    doc
}

/// Read + render a markdown file. Relative image/link destinations are
/// resolved to absolute paths by the renderer itself (it's the only side
/// that knows the document's directory); see `render_and_grant` for the
/// scope-granting half of this.
fn load_document(app: &AppHandle, path: &std::path::Path) -> Result<OpenedDocument, String> {
    let source = std::fs::read_to_string(path)
        .map_err(|e| format!("Couldn't read {}: {}", path.display(), e))?;

    let base_dir = path.parent().unwrap_or(std::path::Path::new("."));
    let doc = render_and_grant(app, &source, base_dir);

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
/// extension list that already lives in `tauri.conf.json`. Returns
/// `MARKDOWN_EXTENSIONS` in its declared order rather than iterating
/// `state.markdown_extensions` (a `HashSet`, so iteration order is
/// unspecified and varies run to run) — order matters here because the
/// frontend's save-as filter list feeds the native save dialog, and both
/// NSSavePanel (macOS) and the Windows common dialog append the *first*
/// filter extension when the user types a bare filename. A `HashSet`
/// iteration order would make that default extension nondeterministic.
#[tauri::command]
fn markdown_extensions() -> Vec<String> {
    MARKDOWN_EXTENSIONS.iter().map(|s| s.to_string()).collect()
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

/// Read a markdown file's raw source, for the editor. Kept separate from
/// `open_markdown_file`'s payload — that command runs on every view-only
/// open (the common case), and doubling its IPC payload with source text
/// nobody reads in view mode would be wasteful. Fetched lazily, once, the
/// first time a tab enters edit mode.
#[tauri::command(async)]
fn read_markdown_source(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Couldn't read {}: {}", path, e))
}

/// Re-render markdown source for the live preview pane. `base_path` is
/// the document's own path, used the same way `load_document` uses a
/// file's parent directory to resolve relative image/link destinations;
/// `None` for an untitled document with no path yet, in which case the
/// current working directory stands in until Save As gives it a real one.
#[tauri::command(async)]
fn render_markdown(
    app: AppHandle,
    source: String,
    base_path: Option<String>,
) -> Result<render::RenderedDoc, String> {
    let base_dir = match &base_path {
        Some(p) => std::path::Path::new(p)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from(".")),
        None => std::env::current_dir().map_err(|e| e.to_string())?,
    };
    Ok(render_and_grant(&app, &source, &base_dir))
}

/// Write edited content back to disk. A narrow, single-purpose command
/// rather than `tauri-plugin-fs` — that plugin would grant the webview
/// broad, scope-configured filesystem access, and this app renders
/// untrusted markdown, so a command that writes exactly one
/// extension-validated path is a materially smaller attack surface than a
/// general-purpose fs bridge.
///
/// Writes to a temp file in the *same directory* as the target, then
/// renames over it: same-directory matters because a cross-filesystem
/// rename isn't atomic, and `std::fs::rename` replaces an existing
/// destination on both Windows and Unix, so one code path covers both
/// platforms without a `#[cfg]` split.
/// The atomic-write half of `save_markdown_file`, factored out so it's
/// unit-testable without an `AppHandle`/`State` — it only needs a path
/// that exists on a real filesystem.
fn atomic_write(target: &std::path::Path, contents: &str) -> Result<(), String> {
    let dir = target
        .parent()
        .ok_or_else(|| format!("No parent directory for {}", target.display()))?;
    let file_name = target
        .file_name()
        .ok_or_else(|| format!("No file name for {}", target.display()))?;
    let tmp_path = dir.join(format!(".{}.mdreader-tmp", file_name.to_string_lossy()));

    std::fs::write(&tmp_path, contents)
        .map_err(|e| format!("Couldn't write {}: {}", tmp_path.display(), e))?;
    std::fs::rename(&tmp_path, target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        format!("Couldn't save {}: {}", target.display(), e)
    })
}

#[tauri::command(async)]
fn save_markdown_file(
    state: tauri::State<AppState>,
    path: String,
    contents: String,
) -> Result<(), String> {
    let path = std::path::Path::new(&path);
    if !is_markdown_path(&state, path) {
        return Err(format!("Refusing to save non-markdown path: {}", path.display()));
    }
    atomic_write(path, &contents)
}

/// The write half of "create a new document": the target came straight
/// out of a native save dialog, so unlike `save_markdown_file` it isn't
/// guaranteed to already have a markdown extension — `normalize_markdown_path`
/// appends one if needed. Reuses `atomic_write` verbatim (same validated,
/// single-purpose write path as `save_markdown_file`, not a new one) and
/// returns the final path so the frontend never has to build or guess an
/// extension itself.
#[tauri::command(async)]
fn save_markdown_file_as(
    state: tauri::State<AppState>,
    path: String,
    contents: String,
) -> Result<String, String> {
    let target = normalize_markdown_path(&state, std::path::Path::new(&path));
    atomic_write(&target, &contents)?;
    Ok(target.to_string_lossy().into_owned())
}

/// Flip once `app.js`'s `close-requested` listener is registered — see
/// `AppState::frontend_ready`'s doc comment for why this exists.
#[tauri::command]
fn mark_frontend_ready(state: tauri::State<AppState>) {
    state.frontend_ready.store(true, Ordering::Relaxed);
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
fn quit_app(app: AppHandle) {
    app.exit(0);
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

    // A hand-built menu, not `Menu::default()` — see menu.rs's module doc
    // for why the default can't be reused (no File submenu on Linux, and
    // its Window/File submenus carry an accelerator that collides with
    // this app's own Cmd/Ctrl+W). `Builder::menu` (not `App::set_menu` in
    // `.setup()`) so `Builder::build`'s "only install the macOS default
    // when no menu was set" check suppresses that default outright,
    // instead of installing-then-replacing it. Both `Builder::menu` and
    // `Builder::on_menu_event` are `#[cfg(desktop)]` in the tauri crate
    // itself — matching this project's mobile-is-not-a-target scope, but
    // still gated here rather than assumed, per the platform-gating
    // invariant.
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
        // Not platform-gated (`WindowEvent::CloseRequested` carries no
        // `#[cfg]` in the tauri crate) — intercepts the window's close
        // button/Alt+F4/Cmd+W-on-titlebar the same way on every platform.
        // `prevent_close()` is called synchronously, in the same handler
        // invocation that receives the event: the runtime checks whether
        // it was called immediately after running listeners, so any
        // `await` before it would let the window close anyway — this
        // handler can only prevent-and-emit, never await the frontend's
        // answer. The frontend drives the actual unsaved-changes prompt
        // sequence after receiving "close-requested", then calls
        // `quit_app` (== `AppHandle::exit`) when done, which does not
        // loop back into this handler.
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
            markdown_extensions,
            drain_pending_files,
            open_markdown_file,
            read_markdown_source,
            render_markdown,
            save_markdown_file,
            save_markdown_file_as,
            mark_frontend_ready,
            quit_app
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state() -> AppState {
        AppState {
            pending: Mutex::new(Vec::new()),
            markdown_extensions: ["md", "markdown", "mdown", "mkd"].iter().map(|s| s.to_string()).collect(),
            frontend_ready: AtomicBool::new(false),
        }
    }

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mdreader-libtest-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn is_markdown_path_accepts_configured_extensions_case_insensitively() {
        let state = test_state();
        assert!(is_markdown_path(&state, std::path::Path::new("a.md")));
        assert!(is_markdown_path(&state, std::path::Path::new("a.MD")));
        assert!(is_markdown_path(&state, std::path::Path::new("a.Markdown")));
    }

    #[test]
    fn is_markdown_path_rejects_other_extensions() {
        let state = test_state();
        assert!(!is_markdown_path(&state, std::path::Path::new("a.txt")));
        assert!(!is_markdown_path(&state, std::path::Path::new("a")));
        assert!(!is_markdown_path(&state, std::path::Path::new(".zshrc")));
    }

    #[test]
    fn normalize_markdown_path_appends_extension_to_a_bare_name() {
        let state = test_state();
        assert_eq!(
            normalize_markdown_path(&state, std::path::Path::new("notes")),
            PathBuf::from(format!("notes.{}", MARKDOWN_EXTENSIONS[0]))
        );
    }

    #[test]
    fn normalize_markdown_path_leaves_an_already_markdown_path_untouched() {
        let state = test_state();
        assert_eq!(
            normalize_markdown_path(&state, std::path::Path::new("notes.md")),
            PathBuf::from("notes.md")
        );
        assert_eq!(
            normalize_markdown_path(&state, std::path::Path::new("notes.MD")),
            PathBuf::from("notes.MD")
        );
    }

    #[test]
    fn normalize_markdown_path_appends_rather_than_replacing_a_non_markdown_extension() {
        // set_extension would turn "my.notes" into "my.md", silently
        // discarding part of the name the user typed — append instead.
        let state = test_state();
        assert_eq!(
            normalize_markdown_path(&state, std::path::Path::new("notes.txt")),
            PathBuf::from(format!("notes.txt.{}", MARKDOWN_EXTENSIONS[0]))
        );
        assert_eq!(
            normalize_markdown_path(&state, std::path::Path::new("my.notes")),
            PathBuf::from(format!("my.notes.{}", MARKDOWN_EXTENSIONS[0]))
        );
    }

    #[test]
    fn normalize_markdown_path_preserves_the_parent_directory() {
        let state = test_state();
        assert_eq!(
            normalize_markdown_path(&state, std::path::Path::new("/some/dir/notes")),
            PathBuf::from(format!("/some/dir/notes.{}", MARKDOWN_EXTENSIONS[0]))
        );
    }

    #[test]
    fn atomic_write_creates_and_round_trips_contents() {
        let dir = test_dir("roundtrip");
        let target = dir.join("doc.md");
        atomic_write(&target, "hello world").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "hello world");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write_overwrites_an_existing_file_with_no_stale_bytes() {
        let dir = test_dir("overwrite");
        let target = dir.join("doc.md");
        std::fs::write(&target, "a very long original that must not leak into the result").unwrap();
        atomic_write(&target, "short").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "short");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write_leaves_no_temp_file_behind_on_success() {
        let dir = test_dir("notemp");
        let target = dir.join("doc.md");
        atomic_write(&target, "content").unwrap();
        let leftover: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("mdreader-tmp"))
            .collect();
        assert!(leftover.is_empty(), "leftover temp files: {leftover:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write_to_a_nonexistent_directory_fails_without_touching_target() {
        // Guards the failure path: no parent directory means atomic_write
        // must return Err (from the initial std::fs::write to the temp
        // path in that directory) rather than panicking or silently
        // succeeding.
        let target = std::env::temp_dir()
            .join("mdreader-libtest-missing-dir-does-not-exist")
            .join("doc.md");
        assert!(atomic_write(&target, "x").is_err());
        assert!(!target.exists());
    }
}
