use super::*;

#[test]
fn windows_drive_letter_is_not_treated_as_a_scheme() {
    assert!(!has_scheme("C:\\Users\\a\\file.md"));
    assert!(has_scheme("https://example.com"));
    assert!(has_scheme("mailto:a@b.com"));
}

#[test]
fn lexically_normalize_swallows_a_leading_parent_component() {
    // Documents the intentional (if surprising) behavior: a leading
    // ".." has nothing to pop against, so it's silently dropped
    // rather than preserved. Exercised end-to-end (not just here) by
    // relative_links_may_escape_base_dir / resolves_parent_relative_image
    // in render/tests.rs.
    // POSIX-only: this pins lexically_normalize's own separator-level
    // behavior on a hardcoded "/"-rooted input, not end-to-end
    // rendering (which those two tests already cover cross-platform via
    // tdir()).
    #[cfg(unix)]
    {
        assert_eq!(lexically_normalize(Path::new("../x")), PathBuf::from("x"));
        assert_eq!(lexically_normalize(Path::new("/../x")), PathBuf::from("/x"));
    }
}
