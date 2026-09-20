//! Shared test-only helpers for building base dirs and rendering — used by
//! render's own driver tests and by submodule tests that need a rendered
//! document rather than a bare private-fn call.

use std::path::{Path, PathBuf};

use super::{render, RenderedDoc};

pub(super) fn render_at(source: &str, base_dir: &str) -> RenderedDoc {
    render(source, Path::new(base_dir)).0
}

// Every destination must go through these helpers, not a hardcoded POSIX string, or
// the resulting data-path won't match what render() produced on Windows — see
// CLAUDE.md's path-resolution invariant for the class of bug this guards against.
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

// Outside test_base_dir() entirely, with its own drive letter: a bare "/..." literal
// is not Path::is_absolute() on Windows, which would exercise the wrong branch.
pub(super) fn abs(rel: &str) -> PathBuf {
    join_rel(if cfg!(windows) { PathBuf::from(r"C:\") } else { PathBuf::from("/") }, rel)
}

pub(super) fn r(source: &str) -> RenderedDoc {
    render(source, &test_base_dir()).0
}

pub(super) fn r_with_assets(source: &str) -> (RenderedDoc, Vec<PathBuf>) {
    render(source, &test_base_dir())
}
