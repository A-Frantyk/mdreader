use super::*;

#[test]
fn markdown_extensions_command_returns_the_sorted_configured_list() {
    // build.rs's generate_markdown_extensions sorts+dedupes, which is
    // what makes MARKDOWN_EXTENSIONS[0] ("markdown") the deterministic
    // default the save-as dialog appends. Every path/atomic-write test
    // compares against MARKDOWN_EXTENSIONS[0] rather than a literal, so
    // none of them would catch a reorder in tauri.conf.json's
    // fileAssociations — this is the one test that actually pins the
    // value.
    assert_eq!(markdown_extensions(), vec!["markdown", "md", "mdown", "mkd"]);
}

#[test]
fn clamp_zoom_passes_through_in_range_values() {
    assert_eq!(clamp_zoom(1.0), 1.0);
    assert_eq!(clamp_zoom(1.25), 1.25);
}

#[test]
fn clamp_zoom_clamps_to_the_min_and_max() {
    assert_eq!(clamp_zoom(0.1), ZOOM_MIN);
    assert_eq!(clamp_zoom(10.0), ZOOM_MAX);
}

#[test]
fn clamp_zoom_falls_back_to_unzoomed_for_non_finite_input() {
    assert_eq!(clamp_zoom(f64::NAN), 1.0);
    assert_eq!(clamp_zoom(f64::INFINITY), 1.0);
    assert_eq!(clamp_zoom(f64::NEG_INFINITY), 1.0);
}
