use super::*;
use super::testutil::{abs, r, r_with_assets, render_at, tdir};

#[test]
fn renders_headings_with_ids_and_toc() {
    let doc = r("# Title\n\n## Sub Heading\n\nBody");
    assert!(doc.html.contains("id=\"title\""));
    assert!(doc.html.contains("id=\"sub-heading\""));
    assert_eq!(doc.title.as_deref(), Some("Title"));
    assert_eq!(doc.headings.len(), 2);
    assert_eq!(doc.headings[0].level, 1);
    assert_eq!(doc.headings[1].level, 2);
}

#[test]
fn dedupes_heading_ids() {
    let doc = r("# Same\n\n# Same");
    assert!(doc.html.contains("id=\"same\""));
    assert!(doc.html.contains("id=\"same-1\""));
}

#[test]
fn preserves_inline_markup_inside_headings() {
    let doc = r("## A **bold** [link](https://example.com) `code`");
    assert!(doc.html.contains("<strong>bold</strong>"));
    assert!(doc.html.contains("<a href=\"https://example.com\""));
    assert!(doc.html.contains("<code>code</code>"));
    assert_eq!(doc.headings[0].text, "A bold link code");
}

#[test]
fn gfm_tables_render_body_cells_and_alignment() {
    let doc = r("| a | b |\n|:---|---:|\n| 1 | 2 |\n| 3 | 4 |");
    assert!(doc.html.contains("<td"));
    // ammonia re-serializes style without pulldown-cmark's space ("text-align:left").
    assert!(doc.html.replace(' ', "").contains("text-align:left"), "{}", doc.html);
    assert!(doc.html.replace(' ', "").contains("text-align:right"), "{}", doc.html);
    // "<thead>" also matches the "<th" substring — exclude it explicitly.
    let th_cells = doc.html.matches("<th").count() - doc.html.matches("<thead").count();
    assert_eq!(th_cells, 2);
    assert_eq!(doc.html.matches("<td").count(), 4);
}

#[test]
fn tasklists_and_strikethrough() {
    let doc = r("- [x] done\n- [ ] todo\n\n~~gone~~");
    assert!(doc.html.contains("type=\"checkbox\""));
    assert!(doc.html.contains("<del>gone</del>"));
}

#[test]
fn footnotes_number_sequentially() {
    let doc = r("First.[^a] Second.[^b]\n\n[^a]: one\n[^b]: two");
    assert!(doc.html.contains("footnote-definition-label\">1</sup>"));
    assert!(doc.html.contains("footnote-definition-label\">2</sup>"));
}

#[test]
fn highlights_code_fences_with_classes() {
    let doc = r("```rust\nfn main() {}\n```");
    assert!(doc.html.contains("class=\"code-block code\""));
    assert!(doc.html.contains("data-lang=\"rust\""));
}

#[test]
fn detects_and_preserves_mermaid_fence() {
    let doc = r("```mermaid\ngraph TD;\nA-->B;\n```");
    assert!(doc.has_mermaid);
    assert!(doc.html.contains("class=\"mermaid\""));
    assert!(doc.html.contains("graph TD;"));
}

#[test]
fn detects_math() {
    let doc = r("Euler's identity: $e^{i\\pi} + 1 = 0$");
    assert!(doc.has_math);
}

#[test]
fn ignores_dollar_signs_inside_code() {
    let doc = r("`$5.00 not math`\n\n```\n$ also not math\n```");
    assert!(!doc.has_math);
}

#[test]
fn strips_script_tags_and_event_handlers() {
    let doc = r("<script>alert(1)</script>\n\n<img src=x onerror=\"alert(1)\">");
    assert!(!doc.html.contains("<script"));
    assert!(!doc.html.contains("onerror"));
}

#[test]
fn strips_javascript_href() {
    let doc = r("[click me](javascript:alert(1))");
    assert!(!doc.html.contains("javascript:"));
}

#[test]
fn style_on_table_cells_is_filtered_to_text_align() {
    let doc = r("<table><tr><td style=\"position:fixed;inset:0;text-align:center;background:url(https://evil/px)\">a</td></tr></table>");
    assert!(doc.html.contains("text-align"), "{}", doc.html);
    assert!(!doc.html.contains("position"), "{}", doc.html);
    assert!(!doc.html.contains("background"), "{}", doc.html);
    assert!(!doc.html.contains("evil"), "{}", doc.html);
    let doc = r("| a | b |\n|:--|--:|\n| 1 | 2 |");
    assert!(doc.html.replace(' ', "").contains("text-align:left"), "{}", doc.html);
    let doc = r("<div style=\"text-align:center\">x</div>");
    assert!(!doc.html.contains("style="), "{}", doc.html);
}

#[test]
fn strips_dangerous_url_schemes() {
    let doc = r("[a](data:text/html;base64,PHNjcmlwdD4=)\n\n[b](file:///etc/passwd)\n\n[c](vbscript:msgbox)\n\n![d](data:image/svg+xml;base64,PHN2Zz4=)\n\n<a href=\"jAvAsCrIpT:alert(1)\">e</a>\n\n<img src=\"data:image/png;base64,AAAA\">");
    for needle in ["data:", "file:", "vbscript:", "javascript:", "jAvAsCrIpT:", "passwd", "msgbox"] {
        assert!(!doc.html.contains(needle), "{needle} survived: {}", doc.html);
    }
    let doc = r("[ok](https://example.com/x)");
    assert!(doc.html.contains("href=\"https://example.com/x\""));
}

#[test]
fn strips_embedding_form_and_meta_tags() {
    let doc = r("<iframe srcdoc=\"<script>1</script>\"></iframe>\n<object data=x></object>\n<embed src=x>\n<form action=x><button formaction=y>b</button></form>\n<svg onload=alert(1)><a xlink:href=\"javascript:1\">s</a></svg>\n<math><mi>m</mi></math>\n<base href=\"https://evil/\">\n<meta http-equiv=refresh content=0>\n<link rel=stylesheet href=x>\n<style>body{display:none}</style>");
    for needle in [
        "<iframe", "srcdoc", "<object", "<embed", "<form", "formaction", "<svg", "xlink:href", "onload",
        "<math", "<base", "<meta", "<link", "<style", "display:none",
    ] {
        assert!(!doc.html.contains(needle), "{needle} survived: {}", doc.html);
    }
}

#[test]
fn strips_name_attribute_and_keeps_id_bare() {
    // `name` would enable DOM clobbering of window globals; `id` is
    // needed for heading anchors and is allowed (unprefixed).
    let doc = r("<a name=\"__TAURI__\" id=\"x\">t</a>");
    assert!(!doc.html.contains("name="), "{}", doc.html);
    assert!(doc.html.contains("id=\"x\""), "{}", doc.html);
}

#[test]
fn allows_raw_safe_html() {
    let doc = r("<div class=\"note\">hello</div>");
    assert!(doc.html.contains("class=\"note\""));
    assert!(doc.html.contains("hello"));
}

#[test]
fn resolves_relative_image_and_collects_asset() {
    let (doc, assets) = render("![alt](img/pic.png)", &tdir("docs"));
    let expected = tdir("docs/img/pic.png");
    assert!(doc.html.contains(&format!("data-path=\"{}\"", expected.display())), "{}", doc.html);
    assert_eq!(assets, vec![expected]);
}

// Intentional: relative destinations are NOT confined to the document's directory —
// the mitigation is at the frontend/require_markdown_path layer, not here.
#[test]
fn relative_links_may_escape_base_dir() {
    let (doc, _assets) = render("[up](../../outside.md)", &tdir("a/b"));
    let expected = tdir("outside.md");
    assert!(doc.html.contains(&format!("data-path=\"{}\"", expected.display())), "{}", doc.html);
}

#[test]
fn resolves_parent_relative_image() {
    let (doc, _assets) = render("![alt](../shared/logo.png)", &tdir("docs"));
    let expected = tdir("shared/logo.png");
    assert!(doc.html.contains(&format!("data-path=\"{}\"", expected.display())), "{}", doc.html);
}

#[test]
fn leaves_external_and_scheme_links_untouched() {
    let doc = r("[ext](https://example.com/x) [mail](mailto:a@b.com) [anchor](#top)");
    assert!(doc.html.contains("href=\"https://example.com/x\""));
    assert!(doc.html.contains("href=\"mailto:a@b.com\""));
    assert!(doc.html.contains("href=\"#top\""));
}

#[test]
fn resolves_relative_markdown_link_to_absolute_path() {
    let doc = r("[other](other.md)");
    let expected = tdir("other.md");
    assert!(doc.html.contains(&format!("data-path=\"{}\"", expected.display())), "{}", doc.html);
}

#[test]
fn percent_decodes_relative_paths() {
    let (_doc, assets) = r_with_assets("![](my%20image.png)");
    assert_eq!(assets, vec![tdir("my image.png")]);
}

#[test]
fn resolves_images_and_links_inside_headings() {
    let (doc, assets) = r_with_assets("## ![icon](icon.png) [text](other.md)");
    let icon = tdir("icon.png");
    let other = tdir("other.md");
    assert!(doc.html.contains(&format!("data-path=\"{}\"", icon.display())), "{}", doc.html);
    assert!(doc.html.contains(&format!("data-path=\"{}\"", other.display())), "{}", doc.html);
    assert_eq!(assets, vec![icon]);
}

#[test]
fn footnote_reference_inside_heading_numbers_correctly() {
    let doc = r("First.[^a]\n\n## Section[^b]\n\n[^a]: one\n[^b]: two");
    // [^b] (inside the heading) must be 2, not 1 — a second, isolated HtmlWriter would produce that.
    assert!(doc.html.contains("footnote-definition-label\">1</sup>"));
    assert!(doc.html.contains("footnote-definition-label\">2</sup>"));
    assert!(doc.html.contains(
        "<sup class=\"footnote-reference\"><a href=\"#a\" rel=\"noopener noreferrer\">1</a></sup>"
    ));
    assert!(doc.html.contains(
        "<sup class=\"footnote-reference\"><a href=\"#b\" rel=\"noopener noreferrer\">2</a></sup>"
    ));
}

#[test]
fn heading_classes_and_attrs_survive() {
    let doc = r("## Title {.warning #custom-id}");
    assert!(doc.html.contains("class=\"warning\""));
    assert!(doc.html.contains("id=\"custom-id\""));
}

#[test]
fn heading_ids_cannot_break_out_of_the_attribute() {
    let doc = r("# T {#a\" onclick=\"x}");
    assert!(!doc.html.contains("onclick"));
}

// Live-preview coverage: render_markdown calls render() on every debounced keystroke,
// against source states nobody would ever save.

#[test]
fn empty_source_renders_an_empty_document() {
    let doc = r("");
    assert_eq!(doc.html, "");
    assert!(doc.headings.is_empty());
    assert_eq!(doc.title, None);
    assert!(!doc.has_mermaid);
    assert!(!doc.has_math);
}

#[test]
fn nonexistent_base_dir_does_not_panic() {
    // The untitled-document case: render_markdown falls back to current_dir(), not guaranteed to exist.
    let doc = render_at("# Hello\n\n![x](missing.png)", "/tmp/mdreader-test-does-not-exist");
    assert!(doc.html.contains("Hello"));
}

#[test]
fn partial_markdown_states_do_not_panic() {
    let partial_inputs = [
        "|a|",
        "| a | b |\n|---",
        "```",
        "```rus",
        "```rust\nfn x() {",
        "[link](",
        "![](img",
        "$$",
        "$unterminated",
        "- [",
        "<div",
        "[^",
        "# {#",
        "~~unterminated",
        "**unterminated",
    ];
    for source in partial_inputs {
        let doc = r(source);
        assert!(!doc.html.contains("<script"), "input {source:?} leaked into html unsanitized");
    }
}

#[test]
fn unclosed_fence_still_produces_a_code_block() {
    // An unclosed fence must not consume the rest of the document silently or panic.
    let doc = r("```rust\nfn x() {}\n");
    assert!(doc.html.contains("code-block"));
}

#[test]
fn asset_list_reflects_only_the_current_source_not_prior_calls() {
    // render() is pure — the asset list must not accumulate across calls, which is what
    // render_and_grant's per-call scope-granting relies on.
    let dir = std::env::temp_dir().join("mdreader-test-assets");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("a.png"), b"").unwrap();
    std::fs::write(dir.join("b.png"), b"").unwrap();

    let (_, assets_a) = render("![a](a.png)", &dir);
    assert_eq!(assets_a.len(), 1);
    assert!(assets_a[0].ends_with("a.png"));

    let (_, assets_b) = render("![b](b.png)", &dir);
    assert_eq!(assets_b.len(), 1);
    assert!(assets_b[0].ends_with("b.png"));

    let (_, assets_both) = render("![a](a.png) ![b](b.png)", &dir);
    assert_eq!(assets_both.len(), 2);
}

#[test]
fn title_is_none_when_the_first_heading_is_not_an_h1() {
    let doc = r("## Sub\n\nBody");
    assert_eq!(doc.title, None);
    assert_eq!(doc.headings.len(), 1);
    assert_eq!(doc.headings[0].level, 2);
}

#[test]
fn title_comes_from_the_first_h1_only() {
    let doc = r("# First\n\n# Second");
    assert_eq!(doc.title.as_deref(), Some("First"));
}

#[test]
fn explicit_heading_id_colliding_with_a_generated_one_is_deduped() {
    let doc = r("# Same\n\n# Same\n\n# X {#same-1}");
    let ids: Vec<&str> = doc.headings.iter().map(|h| h.id.as_str()).collect();
    assert_eq!(ids, vec!["same", "same-1", "same-1-1"]);
}

#[test]
fn unknown_fence_language_falls_back_to_plain_text() {
    let doc = r("```notalang\nplain body\n```");
    assert!(doc.html.contains("code-block"), "{}", doc.html);
    assert!(doc.html.contains("data-lang=\"notalang\""), "{}", doc.html);
    assert!(doc.html.contains("plain body"), "{}", doc.html);
}

#[test]
fn fence_info_string_uses_only_its_first_token() {
    // A comma is not whitespace, so "rust,ignore" is looked up as one token and found by neither name.
    let doc = r("```rust,ignore\nfn f() {}\n```");
    assert!(doc.html.contains("data-lang=\"rust,ignore\""), "{}", doc.html);

    let doc = r("```rust extra info\nfn f() {}\n```");
    assert!(doc.html.contains("data-lang=\"rust\""), "{}", doc.html);
}

#[test]
fn indented_code_block_has_no_data_lang_attribute() {
    let doc = r("    fn f() {}\n");
    assert!(doc.html.contains("code-block"), "{}", doc.html);
    assert!(!doc.html.contains("data-lang"), "{}", doc.html);
}

#[test]
fn mermaid_fence_matches_case_insensitively_and_escapes_its_body() {
    let doc = r("```Mermaid\n<script>bad</script>\n```");
    assert!(doc.has_mermaid);
    assert!(doc.html.contains("class=\"mermaid\""));
    assert!(!doc.html.contains("<script>bad</script>"), "{}", doc.html);
    assert!(doc.html.contains("&lt;script&gt;"), "{}", doc.html);
}

#[test]
fn display_math_sets_has_math() {
    let doc = r("$$\nx^2\n$$");
    assert!(doc.has_math);
}

#[test]
fn escaped_katex_delimiters_do_not_set_has_math() {
    // `(`/`)` are CommonMark-escapable, so pulldown-cmark consumes the backslash before this
    // sees the text — confirmed against the parser's event stream. The DOM never sees it either,
    // so KaTeX's own delimiter scan fails identically: not a missed detection.
    let doc = r(r"Inline \(x\) and display \[y\] math.");
    assert!(!doc.has_math);
    assert!(!doc.html.contains('\\'), "{}", doc.html);
}

#[test]
fn empty_link_destination_resolves_to_nothing() {
    let doc = r("[x]()");
    assert!(doc.html.contains("href=\"\""), "{}", doc.html);
}

#[test]
fn absolute_image_destination_is_collected_as_is() {
    // Nonexistent path forces the lexically_normalize fallback (not canonicalize), avoiding
    // filesystem-layout dependence (e.g. macOS symlinking /etc -> /private/etc).
    let dest = abs("definitely/does/not/exist.png");
    let (doc, assets) = render(&format!("![missing]({})", dest.display()), &tdir("docs"));
    assert!(doc.html.contains(&format!("data-path=\"{}\"", dest.display())), "{}", doc.html);
    assert_eq!(assets, vec![dest]);
}

#[test]
fn setext_headings_get_ids_and_a_toc_entry() {
    let doc = r("Title\n=====\n\nBody");
    assert!(doc.html.contains("id=\"title\""), "{}", doc.html);
    assert_eq!(doc.title.as_deref(), Some("Title"));
    assert_eq!(doc.headings[0].level, 1);
}

#[test]
fn tables_footnotes_and_tasklists_in_one_document_keep_writer_state() {
    // Broadest guard for the one-push_html invariant: each feature is isolated above,
    // which is exactly what let the original writer-state-corruption bug hide.
    let doc = r("| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n\n\
                  - [x] done\n- [ ] todo\n\n\
                  Ref one.[^a] Ref two.[^b]\n\n\
                  [^a]: note one\n[^b]: note two");

    let th_cells = doc.html.matches("<th").count() - doc.html.matches("<thead").count();
    assert_eq!(th_cells, 3, "{}", doc.html);
    assert_eq!(doc.html.matches("<td").count(), 3, "{}", doc.html);
    let flat = doc.html.replace(' ', "");
    assert!(flat.contains("text-align:left"), "{}", doc.html);
    assert!(flat.contains("text-align:center"), "{}", doc.html);
    assert!(flat.contains("text-align:right"), "{}", doc.html);

    assert_eq!(doc.html.matches("type=\"checkbox\"").count(), 2, "{}", doc.html);

    assert!(doc.html.contains("footnote-definition-label\">1</sup>"), "{}", doc.html);
    assert!(doc.html.contains("footnote-definition-label\">2</sup>"), "{}", doc.html);
}

#[test]
#[ignore] // run explicitly: `cargo test --release -- --ignored render_timing`
fn render_timing_on_realistic_documents() {
    // No dev-dependencies in this crate — hence a hand-rolled timing stand-in.
    // Run --release; sanity-checks against the ~200ms live-preview debounce.
    let fixture = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/large.md"),
    )
    .expect("fixtures/large.md must exist — see the render_timing test");
    let base_dir = std::env::temp_dir();

    let mut samples = Vec::new();
    for _ in 0..20 {
        let start = std::time::Instant::now();
        let _ = render(&fixture, &base_dir);
        samples.push(start.elapsed());
    }
    samples.sort();
    let p50 = samples[samples.len() / 2];
    let p95 = samples[samples.len() * 95 / 100];
    eprintln!(
        "render() on fixtures/large.md ({} bytes): p50={:?} p95={:?}",
        fixture.len(),
        p50,
        p95
    );
    // Not a hard assertion — a human reads the eprintln output.
}
