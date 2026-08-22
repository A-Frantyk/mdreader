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

/// Concatenation of every file in src/js/ — the frontend is a series of
/// classic scripts sharing one global scope (see CLAUDE.md), not one file,
/// so `handleMenuAction` could in principle live in any of them. Reading
/// the whole directory rather than a hardcoded path means this check
/// doesn't need an edit if that file ever moves again.
fn repo_js_sources() -> String {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("src/js");
    let mut entries: Vec<_> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", dir.display()))
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "js"))
        .collect();
    entries.sort();
    entries
        .into_iter()
        .map(|p| std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("failed to read {}: {e}", p.display())))
        .collect::<Vec<_>>()
        .join("\n")
}

/// menu.rs's NEW/OPEN/SAVE/QUIT id constants and the frontend's
/// handleMenuAction switch are a string contract across two languages —
/// nothing else checks that a rename on one side doesn't silently orphan
/// a menu item as a no-op on the other. `menu` isn't a `pub` module (no
/// reason for it to be, outside this one cross-file check), so this reads
/// both sides as text rather than adding a visibility hole to production
/// code just for a test to import through.
#[test]
fn menu_ids_match_the_frontend_switch() {
    let menu_rs = repo_file("src-tauri/src/menu.rs");
    let js = repo_js_sources();
    for (const_name, id) in [
        ("NEW", "new"),
        ("OPEN", "open"),
        ("SAVE", "save"),
        ("QUIT", "quit"),
        ("ZOOM_IN", "zoom-in"),
        ("ZOOM_OUT", "zoom-out"),
        ("ZOOM_RESET", "zoom-reset"),
        ("ABOUT", "about"),
    ] {
        let const_decl = format!("pub const {const_name}: &str = \"{id}\";");
        assert!(menu_rs.contains(&const_decl), "menu.rs is missing {const_decl:?}");
        let switch_case = format!("case \"{id}\":");
        assert!(js.contains(&switch_case), "handleMenuAction is missing {switch_case:?}");
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
/// build.rs's generate_codemirror_theme_css doc comment. They're disjoint
/// by *namespace* now (edit-mode.js's tokenTypeOverrides renames every
/// Markdown token to `cm-md-*`), not by a hardcoded list of classes
/// styles.css keeps for itself, so this asserts the contract both
/// directions without hardcoding which classes those are: whatever plain
/// CodeMirror classes the generated theme actually defines, styles.css
/// must not also define a `.cm-s-mdreader .cm-<that class>` rule for; and
/// styles.css's own cm-md-* namespace must never leak into the generated
/// file. If both ever did define the same class, which one wins would
/// depend on stylesheet link order — this was caught and fixed once
/// already, on the previous hardcoded-list version of this contract.
#[test]
fn generated_codemirror_themes_avoid_selectors_owned_by_styles_css() {
    let styles_css = repo_file("src/styles.css");

    for generated in ["src/codemirror-theme-light.css", "src/codemirror-theme-dark.css"] {
        let css = repo_file(generated);
        assert!(
            !css.contains("cm-md-"),
            "{generated} defines a cm-md-* class — that namespace belongs to styles.css alone"
        );

        for line in css.lines() {
            let Some(class_start) = line.find(".cm-s-mdreader-syntax .cm-") else { continue };
            let rest = &line[class_start + ".cm-s-mdreader-syntax .".len()..];
            let class = rest.split(|c: char| !(c.is_ascii_alphanumeric() || c == '-')).next().unwrap_or("");
            assert!(!class.is_empty(), "couldn't parse a class name out of {generated} line {line:?}");
            let collision = format!(".cm-s-mdreader .{class} {{");
            assert!(
                !styles_css.contains(&collision),
                "styles.css defines {collision}, which {generated} also owns as .cm-s-mdreader-syntax .{class} — \
                 dueling same-specificity selectors"
            );
        }
    }
}

/// Every `--syntax-*` custom property styles.css reads must be defined in
/// *both* generated palettes — build.rs's syntax_root_css. A typo'd
/// property name degrades silently to its `var()` fallback rather than
/// erroring, so this is the only thing that would catch one.
#[test]
fn syntax_custom_properties_defined_in_both_themes() {
    let styles_css = repo_file("src/styles.css");
    let light = repo_file("src/code-theme-light.css");
    let dark = repo_file("src/code-theme-dark.css");

    let mut checked = 0;
    let mut idx = 0;
    while let Some(pos) = styles_css[idx..].find("var(--syntax-") {
        let start = idx + pos + "var(".len();
        let name_end = styles_css[start..]
            .find(|c: char| c == ',' || c == ')')
            .map(|n| start + n)
            .unwrap_or(styles_css.len());
        let name = &styles_css[start..name_end];
        for (file_name, css) in [("code-theme-light.css", &light), ("code-theme-dark.css", &dark)] {
            assert!(
                css.contains(&format!("{name}:")),
                "styles.css references {name}, which src/{file_name} does not define"
            );
        }
        checked += 1;
        idx = name_end;
    }
    assert!(checked > 0, "expected styles.css to reference at least one --syntax-* property");
}

/// A broken VS Code JSON → syntect `Theme` conversion (build.rs's
/// `load_vscode_theme`) could silently drop almost every scope — e.g. a
/// panic-free `.and_then` chain returning `None` everywhere — without the
/// build failing. Both vendored themes define 200+ tokenColors entries;
/// a healthy conversion should carry the overwhelming majority of them
/// through as distinct CSS rules.
#[test]
fn generated_code_theme_css_has_substantial_rule_count() {
    for file in ["src/code-theme-light.css", "src/code-theme-dark.css"] {
        let css = repo_file(file);
        let rule_count = css.matches(" {\n").count();
        assert!(
            rule_count > 50,
            "{file} only has {rule_count} rules — the VS Code theme JSON → syntect Theme \
             conversion may be dropping most scopes"
        );
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
