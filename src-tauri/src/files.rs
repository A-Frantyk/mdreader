//! Markdown-path validation and the app's one filesystem write path.

use std::path::{Path, PathBuf};

use crate::{AppState, MARKDOWN_EXTENSIONS};

pub(crate) fn is_markdown_path(state: &AppState, path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| state.markdown_extensions.contains(&e.to_ascii_lowercase()))
}

/// The Rust-side gate every path-taking command goes through — the security boundary
/// (frontend extension filters are UX only). See CLAUDE.md's per-command-validation invariant.
pub(crate) fn require_markdown_path(state: &AppState, path: &Path) -> Result<(), String> {
    if is_markdown_path(state, path) {
        Ok(())
    } else {
        Err(format!("Not a markdown file: {}", path.display()))
    }
}

/// The OS save dialog lets a user type a bare name, or on GTK never appends an extension
/// even with a filter set. Appends `MARKDOWN_EXTENSIONS[0]` rather than replacing —
/// `Path::set_extension` would turn `my.notes` into `my.md`, discarding part of the name.
pub(crate) fn normalize_markdown_path(state: &AppState, path: &Path) -> PathBuf {
    if is_markdown_path(state, path) {
        return path.to_path_buf();
    }
    let Some(file_name) = path.file_name() else {
        // "/" or "..": no name to append to. Shipped bug: unwrap_or_default() used to
        // synthesize a bare ".markdown" in the parent directory instead.
        return path.to_path_buf();
    };
    let mut file_name = file_name.to_owned();
    file_name.push(".");
    file_name.push(MARKDOWN_EXTENSIONS[0]);
    path.with_file_name(file_name)
}

/// Factored out from `save_markdown_file` so it's unit-testable without an `AppHandle`/`State`.
pub(crate) fn atomic_write(target: &Path, contents: &str) -> Result<(), String> {
    let dir = target
        .parent()
        .ok_or_else(|| format!("No parent directory for {}", target.display()))?;
    let file_name = target
        .file_name()
        .ok_or_else(|| format!("No file name for {}", target.display()))?;
    let tmp_path = dir.join(format!(".{}.mdreader-tmp", file_name.to_string_lossy()));

    std::fs::write(&tmp_path, contents)
        .map_err(|e| format!("Couldn't write {}: {}", tmp_path.display(), e))?;

    // std::fs::write always creates the temp file at 0644; without this, a 0600 document
    // would silently become world-readable on every save.
    #[cfg(unix)]
    if let Ok(metadata) = std::fs::metadata(target) {
        let _ = std::fs::set_permissions(&tmp_path, metadata.permissions());
    }

    std::fs::rename(&tmp_path, target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        format!("Couldn't save {}: {}", target.display(), e)
    })
}

#[cfg(test)]
mod tests;
