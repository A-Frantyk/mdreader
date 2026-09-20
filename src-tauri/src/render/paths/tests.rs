use super::*;

#[test]
fn windows_drive_letter_is_not_treated_as_a_scheme() {
    assert!(!has_scheme("C:\\Users\\a\\file.md"));
    assert!(has_scheme("https://example.com"));
    assert!(has_scheme("mailto:a@b.com"));
}

#[test]
fn lexically_normalize_swallows_a_leading_parent_component() {
    // Intentional: a leading ".." has nothing to pop against, so it's dropped, not preserved.
    // POSIX-only — pins the separator-level behavior on a hardcoded "/" input.
    #[cfg(unix)]
    {
        assert_eq!(lexically_normalize(Path::new("../x")), PathBuf::from("x"));
        assert_eq!(lexically_normalize(Path::new("/../x")), PathBuf::from("/x"));
    }
}
