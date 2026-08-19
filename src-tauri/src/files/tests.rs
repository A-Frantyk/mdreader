use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use super::*;
use crate::MARKDOWN_EXTENSIONS;

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
    assert!(is_markdown_path(&state, Path::new("a.md")));
    assert!(is_markdown_path(&state, Path::new("a.MD")));
    assert!(is_markdown_path(&state, Path::new("a.Markdown")));
}

#[test]
fn is_markdown_path_rejects_other_extensions() {
    let state = test_state();
    assert!(!is_markdown_path(&state, Path::new("a.txt")));
    assert!(!is_markdown_path(&state, Path::new("a")));
    assert!(!is_markdown_path(&state, Path::new(".zshrc")));
}

#[test]
fn require_markdown_path_gates_by_extension() {
    let state = test_state();
    assert!(require_markdown_path(&state, Path::new("/tmp/notes.md")).is_ok());
    assert!(require_markdown_path(&state, Path::new("/tmp/notes.MD")).is_ok());
    for bad in ["/etc/passwd", "/tmp/x.txt", "/tmp/.ssh/id_rsa", "/tmp/a.md.exe", "/tmp/dir.md/file"] {
        assert!(require_markdown_path(&state, Path::new(bad)).is_err(), "{bad} accepted");
    }
}

#[test]
fn normalize_markdown_path_appends_extension_to_a_bare_name() {
    let state = test_state();
    assert_eq!(
        normalize_markdown_path(&state, Path::new("notes")),
        PathBuf::from(format!("notes.{}", MARKDOWN_EXTENSIONS[0]))
    );
}

#[test]
fn normalize_markdown_path_leaves_an_already_markdown_path_untouched() {
    let state = test_state();
    assert_eq!(
        normalize_markdown_path(&state, Path::new("notes.md")),
        PathBuf::from("notes.md")
    );
    assert_eq!(
        normalize_markdown_path(&state, Path::new("notes.MD")),
        PathBuf::from("notes.MD")
    );
}

#[test]
fn normalize_markdown_path_appends_rather_than_replacing_a_non_markdown_extension() {
    let state = test_state();
    assert_eq!(
        normalize_markdown_path(&state, Path::new("notes.txt")),
        PathBuf::from(format!("notes.txt.{}", MARKDOWN_EXTENSIONS[0]))
    );
    assert_eq!(
        normalize_markdown_path(&state, Path::new("my.notes")),
        PathBuf::from(format!("my.notes.{}", MARKDOWN_EXTENSIONS[0]))
    );
}

#[test]
fn normalize_markdown_path_preserves_the_parent_directory() {
    let state = test_state();
    assert_eq!(
        normalize_markdown_path(&state, Path::new("/some/dir/notes")),
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
    assert_eq!(normalize_markdown_path(&state, Path::new("/")), PathBuf::from("/"));
    assert_eq!(normalize_markdown_path(&state, Path::new("..")), PathBuf::from(".."));
}

#[test]
fn require_markdown_path_rejects_a_trailing_dot_or_space() {
    let state = test_state();
    for bad in ["/tmp/a.md.", "/tmp/a.md "] {
        assert!(require_markdown_path(&state, Path::new(bad)).is_err(), "{bad} accepted");
    }
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
