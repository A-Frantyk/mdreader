//! Shared test-only helpers for building base dirs and rendering — used by
//! render's own driver tests and by submodule tests that need a rendered
//! document rather than a bare private-fn call.

use std::path::{Path, PathBuf};

use super::{render, RenderedDoc};

pub(super) fn render_at(source: &str, base_dir: &str) -> RenderedDoc {
    render(source, Path::new(base_dir)).0
}

// Windows has no bare-root-without-drive-letter concept the way POSIX
// does: a literal "/tmp/mdreader-test" base_dir doesn't panic there
// (render() never calls base_dir.is_absolute()), but a *destination*
// resolved against it — or asserted against directly in html — must be
// built through these two helpers, not a hardcoded POSIX string, or the
// resulting `data-path` never matches what render() actually produced.
// This is exactly the class of bug that shipped: see the module doc's
// note on ammonia dropping `C:\...` attributes entirely.
pub(super) fn test_base_dir() -> PathBuf {
    if cfg!(windows) { PathBuf::from(r"C:\mdreader-test") } else { PathBuf::from("/tmp/mdreader-test") }
}

pub(super) fn join_rel(mut root: PathBuf, rel: &str) -> PathBuf {
    for seg in rel.split('/').filter(|s| !s.is_empty()) {
        root.push(seg);
    }
    root
}

pub(super) fn tdir(rel: &str) -> PathBuf {
    join_rel(test_base_dir(), rel)
}

// A path outside test_base_dir() entirely — for asserting that an
// already-absolute destination is collected as-is, not joined onto the
// base. Needs its own drive letter on Windows: an absolute POSIX-style
// literal like "/definitely/..." is NOT `Path::is_absolute()` there (no
// drive prefix), which would silently exercise the base_dir.join()
// branch instead of the "kept as-is" branch this is meant to test.
pub(super) fn abs(rel: &str) -> PathBuf {
    join_rel(if cfg!(windows) { PathBuf::from(r"C:\") } else { PathBuf::from("/") }, rel)
}

pub(super) fn r(source: &str) -> RenderedDoc {
    render(source, &test_base_dir()).0
}

pub(super) fn r_with_assets(source: &str) -> (RenderedDoc, Vec<PathBuf>) {
    render(source, &test_base_dir())
}
