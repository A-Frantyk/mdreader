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
