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

/// The Rust-side gate every path-taking command goes through — read
/// (`open_markdown_file`, `read_markdown_source`) and write
/// (`save_markdown_file`) alike. The frontend also filters by extension
/// (open dialog, drop handler, link click), but that's UX, not the
/// security boundary: this app renders untrusted markdown inside a
/// webview that has `window.__TAURI__` exposed, so any command that
/// takes a path must refuse non-markdown targets *here*, where a
/// compromised page can't skip the check. Keeps `~/.ssh/id_rsa`-style
/// reads off the table even if the webview is ever subverted.
fn require_markdown_path(state: &AppState, path: &std::path::Path) -> Result<(), String> {
    if is_markdown_path(state, path) {
        Ok(())
    } else {
        Err(format!("Not a markdown file: {}", path.display()))
    }
}

/// Ensure a save-dialog result ends up with a markdown extension, for the
/// "create a new document" flow: the OS save dialog lets a user type a
/// bare name (`notes`) or, on GTK, never appends an extension at all even
/// when a filter is set. Appends `MARKDOWN_EXTENSIONS[0]` rather than
/// replacing whatever's already there — `Path::set_extension` would turn
/// `my.notes` into `my.md`, silently discarding part of the name the user
/// typed. Appending also matches what the native save dialogs themselves
/// do on macOS/Windows when they add a default extension, so all three
/// platforms converge on the same result.
fn normalize_markdown_path(state: &AppState, path: &std::path::Path) -> PathBuf {
    if is_markdown_path(state, path) {
        return path.to_path_buf();
    }
    let Some(file_name) = path.file_name() else {
        // No file name component at all (e.g. "/" or ".."). There's
        // nothing sensible to append an extension to — falling through to
        // `unwrap_or_default` used to synthesize a bare ".markdown" in
        // the parent directory instead. Leave the path unchanged; the
        // caller (save-as) still ends up refused downstream by whatever
        // actually tries to write there.
        return path.to_path_buf();
    };
    let mut file_name = file_name.to_owned();
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
/// Under live preview this runs on every debounced keystroke, and a
/// half-typed path (`![](diagram.png)` mid-type grants `d`, `di`, `dia`,
/// …) would flood the scope set without the `is_file()` filter below.
fn render_and_grant(app: &AppHandle, source: &str, base_dir: &std::path::Path) -> render::RenderedDoc {
    let (doc, assets) = render::render(source, base_dir);

    let scope = app.asset_protocol_scope();
    for asset in assets.iter().filter(|a| a.is_file()) {
        let _ = scope.allow_file(asset);
    }

    doc
}

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

/// Returns `MARKDOWN_EXTENSIONS` in its declared order rather than
/// iterating `state.markdown_extensions` (a `HashSet`, so order is
/// unspecified) — the frontend's save-as filter list feeds the native
/// save dialog, and NSSavePanel/the Windows common dialog both append the
/// *first* filter extension when the user types a bare filename, so a
/// `HashSet`'s iteration order would make that default nondeterministic.
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
fn open_markdown_file(
    app: AppHandle,
    state: tauri::State<AppState>,
    path: String,
) -> Result<OpenedDocument, String> {
    let path = std::path::Path::new(&path);
    require_markdown_path(&state, path)?;
    load_document(&app, path)
}

/// Kept separate from `open_markdown_file` — doubling that command's IPC
/// payload with source text nobody reads in view mode would be wasteful.
#[tauri::command(async)]
fn read_markdown_source(state: tauri::State<AppState>, path: String) -> Result<String, String> {
    require_markdown_path(&state, std::path::Path::new(&path))?;
    std::fs::read_to_string(&path).map_err(|e| format!("Couldn't read {}: {}", path, e))
}

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

/// Factored out from `save_markdown_file` so it's unit-testable without
/// an `AppHandle`/`State` — it only needs a path that exists on a real
/// filesystem.
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

    // Preserve the target's existing permissions — std::fs::write always
    // creates the temp file with the platform default mode (0644), and a
    // rename doesn't fix that up, so without this a document saved as
    // 0600 would silently become world-readable on every save. Only
    // applies when a target already exists (a first save has no prior
    // permissions to preserve, so it keeps the default).
    #[cfg(unix)]
    if let Ok(metadata) = std::fs::metadata(target) {
        let _ = std::fs::set_permissions(&tmp_path, metadata.permissions());
    }

    std::fs::rename(&tmp_path, target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        format!("Couldn't save {}: {}", target.display(), e)
    })
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
fn save_markdown_file(
    state: tauri::State<AppState>,
    path: String,
    contents: String,
) -> Result<(), String> {
    let path = std::path::Path::new(&path);
    require_markdown_path(&state, path)?;
    atomic_write(path, &contents)
}

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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state() -> AppState {
        AppState {
            pending: Mutex::new(Vec::new()),
            // Derived from the real constant, not hand-duplicated — a
            // hardcoded list here could silently drift from
            // tauri.conf.json's fileAssociations without any test noticing.
            markdown_extensions: MARKDOWN_EXTENSIONS.iter().map(|s| s.to_string()).collect(),
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
    fn require_markdown_path_gates_by_extension() {
        let state = test_state();
        assert!(require_markdown_path(&state, std::path::Path::new("/tmp/notes.md")).is_ok());
        assert!(require_markdown_path(&state, std::path::Path::new("/tmp/notes.MD")).is_ok());
        for bad in ["/etc/passwd", "/tmp/x.txt", "/tmp/.ssh/id_rsa", "/tmp/a.md.exe", "/tmp/dir.md/file"] {
            assert!(require_markdown_path(&state, std::path::Path::new(bad)).is_err(), "{bad} accepted");
        }
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
    fn normalize_markdown_path_leaves_a_path_with_no_file_name_alone() {
        // `Path::file_name()` is `None` for "/" and "..". Previously this
        // fell through to `unwrap_or_default()`, turning "/" into
        // "/.markdown" and ".." into a bare ".markdown" in the parent —
        // synthesizing a file name out of nothing rather than leaving an
        // un-normalizable path as-is.
        let state = test_state();
        assert_eq!(
            normalize_markdown_path(&state, std::path::Path::new("/")),
            PathBuf::from("/")
        );
        assert_eq!(
            normalize_markdown_path(&state, std::path::Path::new("..")),
            PathBuf::from("..")
        );
    }

    #[test]
    fn require_markdown_path_rejects_a_trailing_dot_or_space() {
        let state = test_state();
        for bad in ["/tmp/a.md.", "/tmp/a.md "] {
            assert!(require_markdown_path(&state, std::path::Path::new(bad)).is_err(), "{bad} accepted");
        }
    }

    #[test]
    fn markdown_extensions_command_returns_the_sorted_configured_list() {
        // build.rs's generate_markdown_extensions sorts+dedupes, which is
        // what makes MARKDOWN_EXTENSIONS[0] ("markdown") the deterministic
        // default the save-as dialog appends. Every existing test compares
        // against MARKDOWN_EXTENSIONS[0] rather than a literal, so none of
        // them would catch a reorder in tauri.conf.json's fileAssociations
        // — this is the one test that actually pins the value.
        assert_eq!(markdown_extensions(), vec!["markdown", "md", "mdown", "mkd"]);
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
        let target = std::env::temp_dir()
            .join("mdreader-libtest-missing-dir-does-not-exist")
            .join("doc.md");
        assert!(atomic_write(&target, "x").is_err());
        assert!(!target.exists());
    }

    #[test]
    fn atomic_write_cleans_up_its_temp_file_when_the_rename_fails() {
        // Target is an existing directory, not a file — `fs::rename`
        // refuses to replace a directory with a file, so this forces the
        // one branch (the temp-file cleanup on rename failure) none of
        // the other atomic_write tests exercise.
        let dir = test_dir("rename-fails");
        let target = dir.join("doc.md");
        std::fs::create_dir(&target).unwrap();

        assert!(atomic_write(&target, "content").is_err());
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
    #[cfg(unix)]
    fn atomic_write_preserves_the_target_files_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = test_dir("permissions");
        let target = dir.join("secret.md");
        std::fs::write(&target, "original").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();

        atomic_write(&target, "updated").unwrap();

        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "save must not widen an existing file's permissions");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write_round_trips_unicode_and_crlf_contents() {
        let dir = test_dir("unicode-crlf");
        let target = dir.join("doc.md");
        let contents = "café 日本語 🎉\r\nline two\r\n";
        atomic_write(&target, contents).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), contents);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(unix)]
    fn atomic_write_replaces_a_symlink_target_not_its_destination() {
        let dir = test_dir("symlink");
        let real_dest = dir.join("real.md");
        std::fs::write(&real_dest, "original destination contents").unwrap();
        let link = dir.join("link.md");
        std::os::unix::fs::symlink(&real_dest, &link).unwrap();

        atomic_write(&link, "new contents").unwrap();

        // The link itself now points at (or contains) the new contents,
        // but the file it used to point to is untouched — rename() swaps
        // the directory entry, it doesn't write through a symlink.
        assert_eq!(std::fs::read_to_string(&link).unwrap(), "new contents");
        assert_eq!(std::fs::read_to_string(&real_dest).unwrap(), "original destination contents");
        assert!(!link.is_symlink(), "rename over a symlink should replace the link itself");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
