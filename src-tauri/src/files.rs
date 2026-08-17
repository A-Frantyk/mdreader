//! Markdown-path validation and the app's one filesystem write path.

use std::path::{Path, PathBuf};

use crate::{AppState, MARKDOWN_EXTENSIONS};

pub(crate) fn is_markdown_path(state: &AppState, path: &Path) -> bool {
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
pub(crate) fn require_markdown_path(state: &AppState, path: &Path) -> Result<(), String> {
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
pub(crate) fn normalize_markdown_path(state: &AppState, path: &Path) -> PathBuf {
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

/// Factored out from `save_markdown_file` so it's unit-testable without
/// an `AppHandle`/`State` — it only needs a path that exists on a real
/// filesystem.
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

#[cfg(test)]
mod tests;
