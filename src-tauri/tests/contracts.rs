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

/// Concatenation of every file in src/js/ (classic scripts, one global scope — see
/// CLAUDE.md), so `handleMenuAction` can live in any of them without this check moving.
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

/// menu.rs's id constants and the frontend's handleMenuAction switch are a string
/// contract across two languages; `menu` isn't `pub`, so this reads both as text.
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

/// Shipped bug: `close_window` hijacks Cmd+W on macOS before this app's own handler
/// sees it. Checks for the call, not the word — menu.rs's own doc mentions it too.
#[test]
fn menu_never_offers_close_window() {
    let menu_rs = repo_file("src-tauri/src/menu.rs");
    assert!(
        !menu_rs.contains("close_window(handle"),
        "menu.rs must never construct PredefinedMenuItem::close_window"
    );
}

/// The generated CodeMirror theme and styles.css's chrome must own disjoint token-class
/// selectors by *namespace*, not a hardcoded list — see CLAUDE.md's two-theme-layer
/// invariant. A collision's winner would depend on link order; caught once already.
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

/// A typo'd `--syntax-*` property degrades silently to its `var()` fallback rather than
/// erroring — this is the only thing that would catch one.
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

#[test]
fn ui_custom_properties_are_generated_and_not_overridden() {
    let styles = repo_file("src/styles.css");
    let themes = [repo_file("src/code-theme-light.css"), repo_file("src/code-theme-dark.css")];
    let mut checked = 0;
    for part in styles.split("var(--ui-").skip(1) {
        let name = part.split(|c: char| c == ')' || c == ',').next().unwrap();
        let declaration = format!("--ui-{name}:");
        assert!(!styles.contains(&declaration), "styles.css overrides {declaration}");
        for theme in &themes {
            let value = theme.split(&declaration).nth(1)
                .unwrap_or_else(|| panic!("generated theme is missing {declaration}"))
                .split(';').next().unwrap().trim();
            assert!(value.starts_with('#'), "{declaration} is not a color: {value}");
            assert!(matches!(value.len(), 7 | 9), "invalid UI hex color {value}");
            assert!(value[1..].chars().all(|c| c.is_ascii_hexdigit()));
        }
        checked += 1;
    }
    assert!(checked >= 25, "expected the app to consume the generated UI palette");
}

/// A broken JSON->Theme conversion could silently drop almost every scope without the
/// build failing. Both vendored themes define 200+ tokenColors entries.
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

/// A broken generator could emit byte-identical light/dark files without the build
/// failing — nothing would notice until dark mode showed light-theme-colored fences.
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
