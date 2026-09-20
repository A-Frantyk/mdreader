//! Resolving relative link/image destinations to absolute filesystem paths.
//! See CLAUDE.md's path-resolution invariant for why this lives in Rust.

use std::path::{Path, PathBuf};

pub(super) fn resolve_local(base_dir: &Path, dest: &str) -> Option<PathBuf> {
    if dest.is_empty() || dest.starts_with('#') || has_scheme(dest) {
        return None;
    }
    let decoded = percent_encoding::percent_decode_str(dest)
        .decode_utf8_lossy()
        .into_owned();
    let candidate = Path::new(&decoded);
    let absolute = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        base_dir.join(candidate)
    };
    Some(
        absolute
            .canonicalize()
            .unwrap_or_else(|_| lexically_normalize(&absolute)),
    )
}

fn has_scheme(s: &str) -> bool {
    let mut chars = s.char_indices();
    match chars.next() {
        Some((_, c)) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    for (i, c) in chars {
        if c == ':' {
            // A single-letter "scheme" followed by ':' is a Windows drive
            // (`C:\...`), not a URI scheme.
            return i > 1;
        }
        if !(c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) {
            return false;
        }
    }
    false
}

/// Best-effort `..`/`.` collapse for paths that don't exist yet (so
/// `canonicalize` fails) — e.g. a link to a file that hasn't been created.
fn lexically_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests;
