//! Markdown -> sanitized HTML rendering.
//!
//! Pipeline: pulldown-cmark (GFM) -> syntect (code fence highlighting) ->
//! ammonia (sanitize). All of it runs as ONE pass over the parser's event
//! stream, transformed and fed through a single `pulldown_cmark::html::push_html`
//! call — `HtmlWriter` carries state across events (table head/body,
//! footnote numbering), so calling it more than once per document silently
//! corrupts that state. Headings and code fences are rewritten into
//! `Event::Html(..)` (the library's own escape hatch) inline in the stream;
//! everything else — including tables, footnotes, and inline markup inside
//! headings — flows through untouched and gets pulldown-cmark's own,
//! correct rendering.
//!
//! Relative image/link destinations are resolved to absolute filesystem
//! paths here, not in the frontend: this is the only place that knows the
//! document's directory and has real path semantics (`std::path`, not a
//! separator-sniffing guess). Images additionally get their resolved path
//! returned so the caller can grant the webview's asset-protocol scope
//! access to exactly that file.
//!
//! Mermaid and math are NOT rendered here. We only detect their presence
//! so the frontend can lazy-load the (heavy) mermaid.js / KaTeX bundles
//! only for documents that actually need them. Mermaid fences are left as
//! `<pre class="mermaid">RAW_SOURCE</pre>` for mermaid.js to pick up
//! client-side; math is left as literal `$...$` / `$$...$$` text for
//! KaTeX's auto-render extension to find and typeset client-side.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use pulldown_cmark::{CodeBlockKind, CowStr, Event, Options, Parser, Tag, TagEnd};
use pulldown_cmark_escape::escape_html as escape_into;
use syntect::html::{ClassStyle, ClassedHTMLGenerator};
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;

pub static SYNTAX_SET: LazyLock<SyntaxSet> = LazyLock::new(SyntaxSet::load_defaults_newlines);

#[derive(Debug, Clone, serde::Serialize)]
pub struct RenderedDoc {
    pub html: String,
    pub title: Option<String>,
    pub headings: Vec<Heading>,
    pub has_mermaid: bool,
    pub has_math: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Heading {
    pub level: u8,
    pub id: String,
    pub text: String,
}

/// Render markdown source rooted at `base_dir` (the document's own
/// directory, used to resolve relative image/link destinations). Returns
/// the document plus the absolute paths of every local image it
/// references, so the caller can grant asset-protocol scope precisely
/// rather than for the whole directory.
pub fn render(source: &str, base_dir: &Path) -> (RenderedDoc, Vec<PathBuf>) {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_SMART_PUNCTUATION);
    options.insert(Options::ENABLE_HEADING_ATTRIBUTES);

    let mut headings: Vec<Heading> = Vec::new();
    let mut used_ids: HashSet<String> = HashSet::new();
    let mut has_mermaid = false;
    let mut has_math = false;
    let mut title: Option<String> = None;
    let mut assets: Vec<PathBuf> = Vec::new();

    // The transformed stream fed to the single, final `push_html` call.
    let mut transformed: Vec<Event> = Vec::new();

    let mut parser = Parser::new_ext(source, options);
    while let Some(event) = parser.next() {
        match event {
            Event::Start(Tag::CodeBlock(kind)) => {
                let lang = match &kind {
                    CodeBlockKind::Fenced(info) => {
                        info.split_whitespace().next().unwrap_or("").to_string()
                    }
                    CodeBlockKind::Indented => String::new(),
                };
                let mut code = String::new();
                for inner in parser.by_ref() {
                    match inner {
                        Event::Text(text) => code.push_str(&text),
                        Event::End(TagEnd::CodeBlock) => break,
                        _ => {}
                    }
                }
                let block_html = if lang.eq_ignore_ascii_case("mermaid") {
                    has_mermaid = true;
                    let mut escaped = String::new();
                    let _ = escape_into(&mut escaped, &code);
                    format!("<pre class=\"mermaid\">{escaped}</pre>\n")
                } else {
                    highlight_code_block(&code, &lang)
                };
                transformed.push(Event::Html(CowStr::from(block_html)));
            }
            Event::Start(Tag::Heading { level, id, classes, attrs }) => {
                // Buffer inner events only to compute a slug from the
                // plain text when there's no explicit `{#id}` — the slug
                // is needed on the *Start* event, which comes before the
                // text that determines it. Everything buffered here still
                // flows through the one shared `push_html` call below
                // (never a separate one): a separate call was the exact
                // bug this file's module doc warns about, just scoped to
                // headings — it broke path resolution for images/links
                // nested in a heading (resolve_event never ran on them)
                // and footnote numbering for references nested in a
                // heading (a second HtmlWriter means a second, wrong,
                // footnote counter).
                let mut inner: Vec<Event> = Vec::new();
                let mut plain = String::new();
                for inner_event in parser.by_ref() {
                    match &inner_event {
                        Event::End(TagEnd::Heading(_)) => break,
                        Event::Text(t) | Event::Code(t) => plain.push_str(t),
                        _ => {}
                    }
                    inner.push(resolve_event(inner_event, base_dir, &mut assets));
                }
                let level_num = level as u8;
                let slug = unique_id(
                    id.map(|c| c.to_string())
                        .unwrap_or_else(|| slugify(&plain)),
                    &mut used_ids,
                );
                if title.is_none() && level_num == 1 {
                    title = Some(plain.clone());
                }
                headings.push(Heading {
                    level: level_num,
                    id: slug.clone(),
                    text: plain,
                });

                let mut id_attr = String::new();
                let _ = escape_into(&mut id_attr, &slug);
                let anchor_html =
                    format!("<a class=\"anchor\" href=\"#{id_attr}\" aria-hidden=\"true\">#</a>");

                // `classes`/`attrs` (from `{.foo #bar key=val}` syntax,
                // enabled by ENABLE_HEADING_ATTRIBUTES) pass through
                // unmodified — pulldown-cmark's own writer renders them,
                // only `id` needed overriding.
                transformed.push(Event::Start(Tag::Heading {
                    level,
                    id: Some(CowStr::from(slug)),
                    classes,
                    attrs,
                }));
                transformed.push(Event::Html(CowStr::from(anchor_html)));
                transformed.extend(inner);
                transformed.push(Event::End(TagEnd::Heading(level)));
            }
            Event::Start(Tag::Image { .. }) => {
                transformed.push(resolve_event(event, base_dir, &mut assets));
            }
            Event::Start(Tag::Link { .. }) => {
                transformed.push(resolve_event(event, base_dir, &mut assets));
            }
            Event::Text(t) if t.contains('$') => {
                has_math = true;
                transformed.push(Event::Text(t));
            }
            other => transformed.push(other),
        }
    }

    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, transformed.into_iter());
    let html = sanitize(&html);

    (
        RenderedDoc {
            html,
            title,
            headings,
            has_mermaid,
            has_math,
        },
        assets,
    )
}

/// Rewrites an `Image`/`Link` start event's destination in place if it's a
/// local relative path (see `resolve_local`), collecting the resolved
/// path into `assets` for images so the caller can grant asset-protocol
/// scope to exactly the files a document references. A no-op for every
/// other event. Shared by the top-level match and the heading-inner-event
/// loop so there's exactly one place this logic lives — headings buffer
/// their content separately (to compute a slug before re-emitting the
/// `Start` event) but must apply the identical resolution, or images and
/// links nested in a heading silently keep their unresolved relative path.
fn resolve_event<'a>(event: Event<'a>, base_dir: &Path, assets: &mut Vec<PathBuf>) -> Event<'a> {
    match event {
        Event::Start(Tag::Image { link_type, dest_url, title, id }) => {
            let dest_url = match resolve_local(base_dir, &dest_url) {
                Some(path) => {
                    let resolved = CowStr::from(path.to_string_lossy().into_owned());
                    assets.push(path);
                    resolved
                }
                None => dest_url,
            };
            Event::Start(Tag::Image { link_type, dest_url, title, id })
        }
        Event::Start(Tag::Link { link_type, dest_url, title, id }) => {
            let dest_url = match resolve_local(base_dir, &dest_url) {
                Some(path) => CowStr::from(path.to_string_lossy().into_owned()),
                None => dest_url,
            };
            Event::Start(Tag::Link { link_type, dest_url, title, id })
        }
        other => other,
    }
}

/// Resolve `dest` to an absolute filesystem path if it's a same-machine
/// relative/absolute path (no URI scheme, not an in-page `#anchor`).
/// Returns `None` for anything that should be left untouched: external
/// URLs, `mailto:`/`tel:` links, and page-local anchors.
fn resolve_local(base_dir: &Path, dest: &str) -> Option<PathBuf> {
    if dest.is_empty() || dest.starts_with('#') || has_scheme(dest) {
        return None;
    }
    let decoded = percent_encoding::percent_decode_str(dest)
        .decode_utf8_lossy()
        .into_owned();
    let candidate = Path::new(&decoded);
    let absolute = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        base_dir.join(candidate)
    };
    Some(
        absolute
            .canonicalize()
            .unwrap_or_else(|_| lexically_normalize(&absolute)),
    )
}

/// `RFC 3986`-style scheme detection (`scheme:`), enough to tell a URL
/// (`https://…`, `mailto:…`) apart from a filesystem path — including a
/// Windows drive letter, which is not a scheme despite the colon.
fn has_scheme(s: &str) -> bool {
    let mut chars = s.char_indices();
    match chars.next() {
        Some((_, c)) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    for (i, c) in chars {
        if c == ':' {
            // A single-letter "scheme" followed by ':' is a Windows drive
            // (`C:\...`), not a URI scheme.
            return i > 1;
        }
        if !(c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) {
            return false;
        }
    }
    false
}

/// Best-effort `..`/`.` collapse for paths that don't exist yet (so
/// `canonicalize` fails) — e.g. a link to a file that hasn't been created.
fn lexically_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn slugify(text: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = true; // suppress leading dash
    for ch in text.chars().flat_map(|c| c.to_lowercase()) {
        if ch.is_alphanumeric() {
            slug.push(ch);
            last_was_dash = false;
        } else if !last_was_dash {
            slug.push('-');
            last_was_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        slug.push_str("section");
    }
    slug
}

fn unique_id(base: String, used: &mut HashSet<String>) -> String {
    if !used.contains(&base) {
        used.insert(base.clone());
        return base;
    }
    let mut n = 1;
    loop {
        let candidate = format!("{base}-{n}");
        if used.insert(candidate.clone()) {
            return candidate;
        }
        n += 1;
    }
}

fn highlight_code_block(code: &str, lang: &str) -> String {
    let syntax = SYNTAX_SET
        .find_syntax_by_token(lang)
        .unwrap_or_else(|| SYNTAX_SET.find_syntax_plain_text());

    let mut generator =
        ClassedHTMLGenerator::new_with_class_style(syntax, &SYNTAX_SET, ClassStyle::Spaced);
    for line in LinesWithEndings::from(code) {
        let _ = generator.parse_html_for_line_which_includes_newline(line);
    }
    let body = generator.finalize();

    let lang_class = if lang.is_empty() {
        String::new()
    } else {
        let mut escaped = String::new();
        let _ = escape_into(&mut escaped, lang);
        format!(" data-lang=\"{escaped}\"")
    };
    // `code` (not `code-block`) is the class name build.rs's generated
    // theme CSS targets for foreground/background colors — see
    // `syntect::html::css_for_theme_with_class_style`.
    format!("<pre class=\"code-block code\"{lang_class}><code>{body}</code></pre>\n")
}

/// CSS classes syntect/mermaid/katex depend on, layered onto ammonia's
/// otherwise-conservative default allowlist. `class`/`id` cover syntect's
/// scope spans and our own heading anchors; `input` + its attributes cover
/// GFM task-list checkboxes. Mermaid and KaTeX output is injected
/// client-side after this point and never passes through here.
fn sanitize(html: &str) -> String {
    ammonia::Builder::default()
        .add_tags(["input"]) // GFM task-list checkboxes
        .add_generic_attributes(["class", "id"]) // syntect scope spans, heading anchors
        .add_tag_attributes("input", ["type", "checked", "disabled"])
        .add_tag_attributes("a", ["aria-hidden"])
        .add_tag_attributes("pre", ["data-lang"])
        // pulldown-cmark's own GFM table-alignment output — its only
        // source of `style` in our HTML. Mermaid/KaTeX render
        // client-side and never pass through this sanitizer, so `style`
        // is intentionally not allowed anywhere else.
        .add_tag_attributes("td", ["style"])
        .add_tag_attributes("th", ["style"])
        .link_rel(Some("noopener noreferrer"))
        .clean(html)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render_at(source: &str, base_dir: &str) -> RenderedDoc {
        render(source, Path::new(base_dir)).0
    }

    fn r(source: &str) -> RenderedDoc {
        render_at(source, "/tmp/mdreader-test")
    }

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
        // The plain-text projection (TOC/slug/title) still has the text.
        assert_eq!(doc.headings[0].text, "A bold link code");
    }

    #[test]
    fn gfm_tables_render_body_cells_and_alignment() {
        let doc = r("| a | b |\n|:---|---:|\n| 1 | 2 |\n| 3 | 4 |");
        assert!(doc.html.contains("<td"));
        assert!(doc.html.contains("text-align: left"));
        assert!(doc.html.contains("text-align: right"));
        // Only the header row's 2 cells should be <th> ("<thead>" also
        // matches the "<th" substring, so exclude it explicitly).
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
    fn allows_raw_safe_html() {
        let doc = r("<div class=\"note\">hello</div>");
        assert!(doc.html.contains("class=\"note\""));
        assert!(doc.html.contains("hello"));
    }

    #[test]
    fn resolves_relative_image_and_collects_asset() {
        let (doc, assets) = render("![alt](img/pic.png)", Path::new("/tmp/mdreader-test/docs"));
        assert!(doc.html.contains("/tmp/mdreader-test/docs/img/pic.png"));
        assert_eq!(assets, vec![PathBuf::from("/tmp/mdreader-test/docs/img/pic.png")]);
    }

    #[test]
    fn resolves_parent_relative_image() {
        let (doc, _assets) = render("![alt](../shared/logo.png)", Path::new("/tmp/mdreader-test/docs"));
        assert!(doc.html.contains("/tmp/mdreader-test/shared/logo.png"));
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
        assert!(doc.html.contains("href=\"/tmp/mdreader-test/other.md\""));
    }

    #[test]
    fn percent_decodes_relative_paths() {
        let (_doc, assets) = render("![](my%20image.png)", Path::new("/tmp/mdreader-test"));
        assert_eq!(assets, vec![PathBuf::from("/tmp/mdreader-test/my image.png")]);
    }

    #[test]
    fn resolves_images_and_links_inside_headings() {
        let (doc, assets) = r_with_assets("## ![icon](icon.png) [text](other.md)");
        assert!(doc.html.contains("src=\"/tmp/mdreader-test/icon.png\""));
        assert!(doc.html.contains("href=\"/tmp/mdreader-test/other.md\""));
        assert_eq!(assets, vec![PathBuf::from("/tmp/mdreader-test/icon.png")]);
    }

    #[test]
    fn footnote_reference_inside_heading_numbers_correctly() {
        let doc = r("First.[^a]\n\n## Section[^b]\n\n[^a]: one\n[^b]: two");
        // [^a] appears first in document order, so it must be footnote 1
        // and [^b] (inside the heading) must be 2 — not both "1", which
        // is what a second, isolated HtmlWriter for the heading would
        // produce (its own numbering starts fresh). Reference href is the
        // raw label (`#a`/`#b`), not a synthesized id — confirmed against
        // pulldown-cmark's html.rs FootnoteReference handling.
        // `rel="noopener noreferrer"` is ammonia's own addition on every
        // anchor (link_rel), present in the real rendered output.
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

    fn r_with_assets(source: &str) -> (RenderedDoc, Vec<PathBuf>) {
        render(source, Path::new("/tmp/mdreader-test"))
    }

    #[test]
    fn windows_drive_letter_is_not_treated_as_a_scheme() {
        assert!(!has_scheme("C:\\Users\\a\\file.md"));
        assert!(has_scheme("https://example.com"));
        assert!(has_scheme("mailto:a@b.com"));
    }

    #[test]
    fn heading_ids_cannot_break_out_of_the_attribute() {
        let doc = r("# T {#a\" onclick=\"x}");
        assert!(!doc.html.contains("onclick"));
    }
}
