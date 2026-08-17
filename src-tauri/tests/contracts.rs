//! Cross-file invariants that no in-module `#[cfg(test)]` block can see,
//! because each one spans two files (or a generated + a hand-written one).
//! These are `include_str!`/read-file checks, not behavioral tests — the
//! point is to catch a silent drift between two things CLAUDE.md documents
//! as needing to stay in lockstep.

use std::path::Path;

fn repo_file(rel: &str) -> String {
    // CARGO_MANIFEST_DIR is src-tauri/; every path here is relative to the
    // repo root one level up.
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()))
}

/// menu.rs's NEW/OPEN/SAVE/QUIT id constants and app.js's
/// handleMenuAction switch are a string contract across two languages —
/// nothing else checks that a rename on one side doesn't silently orphan
/// a menu item as a no-op on the other. `menu` isn't a `pub` module (no
/// reason for it to be, outside this one cross-file check), so this reads
/// both sides as text rather than adding a visibility hole to production
/// code just for a test to import through.
#[test]
fn menu_ids_match_the_frontend_switch() {
    let menu_rs = repo_file("src-tauri/src/menu.rs");
    let app_js = repo_file("src/app.js");
    for (const_name, id) in [("NEW", "new"), ("OPEN", "open"), ("SAVE", "save"), ("QUIT", "quit")] {
        let const_decl = format!("pub const {const_name}: &str = \"{id}\";");
        assert!(menu_rs.contains(&const_decl), "menu.rs is missing {const_decl:?}");
        let switch_case = format!("case \"{id}\":");
        assert!(app_js.contains(&switch_case), "app.js's handleMenuAction is missing {switch_case:?}");
    }
}

/// `PredefinedMenuItem::close_window` must never be constructed in
/// menu.rs — see its module doc. This was a real, shipped bug: it
/// hijacks Cmd+W on macOS before the webview's own "close active tab"
/// handler ever sees the keystroke. Checks for the call, not just the
/// word — the module doc comment itself mentions "close_window" several
/// times to explain the omission, so a plain substring check on the
/// whole file would trip on its own documentation.
#[test]
fn menu_never_offers_close_window() {
    let menu_rs = repo_file("src-tauri/src/menu.rs");
    assert!(
        !menu_rs.contains("close_window(handle"),
        "menu.rs must never construct PredefinedMenuItem::close_window"
    );
}

/// The generated CodeMirror syntax theme and the hand-written chrome
/// theme in styles.css must own disjoint token-class selectors — see
/// build.rs's generate_codemirror_theme_css doc comment. If both define
/// the same class, which one wins depends on stylesheet link order; this
/// was caught and fixed once already.
#[test]
fn generated_codemirror_themes_avoid_selectors_owned_by_styles_css() {
    let styles_css = repo_file("src/styles.css");
    let owned_by_styles_css = ["cm-comment", "cm-variable-2", "cm-tag"];
    for class in owned_by_styles_css {
        assert!(
            styles_css.contains(&format!(".{class}")),
            "styles.css no longer defines .{class} — is the disjoint-selector split still needed?"
        );
    }

    for generated in ["src/codemirror-theme-light.css", "src/codemirror-theme-dark.css"] {
        let css = repo_file(generated);
        for class in owned_by_styles_css {
            assert!(
                !css.contains(&format!(".{class} {{")),
                "{generated} defines .{class}, which styles.css also owns — dueling same-specificity selectors"
            );
        }
    }
}

/// A broken `codemirror_theme_css`/`css_for_theme_with_class_style` could
/// emit two byte-identical files for light and dark without the build
/// failing — nothing would notice until someone opened the editor in dark
/// mode and every fence token was still light-theme-colored.
#[test]
fn generated_themes_differ_between_light_and_dark() {
    for (light, dark) in [
        ("src/code-theme-light.css", "src/code-theme-dark.css"),
        ("src/codemirror-theme-light.css", "src/codemirror-theme-dark.css"),
    ] {
        let light_css = repo_file(light);
        let dark_css = repo_file(dark);
        assert!(!light_css.trim().is_empty(), "{light} is empty");
        assert!(!dark_css.trim().is_empty(), "{dark} is empty");
        assert_ne!(light_css, dark_css, "{light} and {dark} are byte-identical");
    }
}
