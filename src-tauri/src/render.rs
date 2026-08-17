//! Markdown -> sanitized HTML rendering.
//!
//! Everything runs as ONE pass over the parser's event stream, transformed
//! and fed through a single `pulldown_cmark::html::push_html` call —
//! `HtmlWriter` carries state across events (table head/body, footnote
//! numbering), so calling it more than once per document silently corrupts
//! that state. Code fences are rewritten into a single `Event::Html(..)`
//! per block; headings keep their real `Start`/`End` events (only `id` is
//! overridden, with an anchor `<a>` spliced in as a sibling `Event::Html`),
//! so their inline markup still gets pulldown-cmark's own rendering.
//! Everything else flows through untouched.
//!
//! Relative image/link destinations are resolved to absolute filesystem
//! paths here, not in the frontend: this is the only place that knows the
//! document's directory and has real path semantics (`std::path`, not a
//! separator-sniffing guess). Images additionally get their resolved path
//! returned so the caller can grant the webview's asset-protocol scope
//! access to exactly that file. A resolved path is emitted as `data-path`,
//! never `src`/`href` — ammonia applies URL semantics to those, and a
//! Windows path (`C:\...`) parses as URL scheme `c`, silently dropping the
//! whole attribute. See `resolve_event`'s comment for the full story.
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

/// Returns the document plus the absolute paths of every local image it
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
                // Buffered events still flow through the one shared
                // push_html call below — a separate call here shipped
                // once, breaking nested image/link resolution and
                // footnote numbering for anything nested in a heading.
                let mut inner: Vec<Event> = Vec::new();
                let mut plain = String::new();
                while let Some(inner_event) = parser.next() {
                    match inner_event {
                        Event::End(TagEnd::Heading(_)) => break,
                        Event::Text(t) => {
                            plain.push_str(&t);
                            inner.push(Event::Text(t));
                        }
                        Event::Code(t) => {
                            plain.push_str(&t);
                            inner.push(Event::Code(t));
                        }
                        // A local image's alt text is drained by
                        // resolve_local_image itself (see below), so it
                        // can't reach the Text arm above the way it does
                        // for a non-local image — fold it into `plain`
                        // here instead, to keep contributing to the
                        // heading's slug/TOC text either way.
                        Event::Start(Tag::Image { link_type, dest_url, title, id: img_id }) => {
                            match resolve_local(base_dir, &dest_url) {
                                Some(path) => {
                                    let (ev, alt) =
                                        resolve_local_image(&title, &mut parser, &mut assets, path);
                                    plain.push_str(&alt);
                                    inner.push(ev);
                                }
                                None => inner.push(Event::Start(Tag::Image {
                                    link_type,
                                    dest_url,
                                    title,
                                    id: img_id,
                                })),
                            }
                        }
                        other => inner.push(resolve_event(other, base_dir)),
                    }
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
            Event::Start(Tag::Image { link_type, dest_url, title, id }) => {
                match resolve_local(base_dir, &dest_url) {
                    Some(path) => {
                        let (ev, _alt) = resolve_local_image(&title, &mut parser, &mut assets, path);
                        transformed.push(ev);
                    }
                    None => transformed.push(Event::Start(Tag::Image { link_type, dest_url, title, id })),
                }
            }
            Event::Start(Tag::Link { .. }) => {
                transformed.push(resolve_event(event, base_dir));
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

/// Shared by the top-level match and the heading-inner-event loop so
/// there's exactly one place this logic lives — headings buffer their
/// content separately (to compute a slug before re-emitting the `Start`
/// event) but must apply the identical resolution, or images/links nested
/// in a heading silently keep their unresolved relative path.
// Local link/image destinations deliberately do NOT flow into `href=`/`src=`
// — see the "Path resolution stays in Rust" invariant in CLAUDE.md. Ammonia
// applies URL semantics to those attributes, and a resolved Windows path
// (`C:\Users\...`) parses as URL scheme `c`, which isn't in ammonia's scheme
// allowlist — the whole attribute is silently dropped. `data-path` isn't
// URL-typed, so ammonia (with the tag_attributes allowlist below) passes it
// through byte-for-byte on every platform. resolve_local already returns
// None for anything external/anchored/scheme'd, so those keep flowing
// through pulldown-cmark's normal `href=`/`src=` output untouched.
fn resolve_event<'a>(event: Event<'a>, base_dir: &Path) -> Event<'a> {
    match event {
        Event::Start(Tag::Link { link_type, dest_url, title, id }) => {
            match resolve_local(base_dir, &dest_url) {
                Some(path) => {
                    let mut html = String::from("<a data-path=\"");
                    let _ = escape_into(&mut html, &path.to_string_lossy());
                    // role/tabindex restore what a plain `<a href>` gets for
                    // free — keyboard focus and a pointer cursor — since an
                    // <a> with no href is otherwise inert to both. See
                    // app.js's contentWrap keydown handler for the Enter/
                    // Space side of this.
                    html.push_str("\" role=\"link\" tabindex=\"0\"");
                    if !title.is_empty() {
                        html.push_str(" title=\"");
                        let _ = escape_into(&mut html, &title);
                        html.push('"');
                    }
                    html.push('>');
                    Event::Html(CowStr::from(html))
                }
                None => Event::Start(Tag::Link { link_type, dest_url, title, id }),
            }
        }
        other => other,
    }
}

/// Builds a complete `<img>` tag for a local (resolved) image destination
/// and returns it alongside the raw, unescaped alt text — a caller inside a
/// heading folds that into the heading's own plain-text accumulator (slug +
/// TOC text), matching how alt text nested in a heading already contributed
/// via the generic Text/Code accumulation before this function existed.
///
/// Drains `parser` to the matching `TagEnd::Image` itself, mirroring
/// pulldown_cmark::html::HtmlWriter::raw_text's event handling — a local
/// image bypasses the writer's own `Tag::Image` handling entirely (see
/// resolve_event's comment above for why `data-path` replaces `src`).
/// Deliberately not reproduced: FootnoteReference numbering inside alt text
/// (needs the writer's private counter, out of reach here) and the
/// TaskListMarker/InlineMath/DisplayMath variants (none occur in practice
/// inside `![alt](...)`). Footnote numbering everywhere else in the
/// document is unaffected — it still goes through the single shared
/// push_html call at the end of render().
fn resolve_local_image<'a>(
    title: &CowStr<'a>,
    parser: &mut Parser<'a>,
    assets: &mut Vec<PathBuf>,
    path: PathBuf,
) -> (Event<'a>, String) {
    assets.push(path.clone());
    let mut alt = String::new();
    let mut nest = 0i32;
    while let Some(event) = parser.next() {
        match event {
            Event::Start(_) => nest += 1,
            Event::End(_) => {
                if nest == 0 {
                    break;
                }
                nest -= 1;
            }
            Event::Text(t) | Event::Code(t) | Event::InlineHtml(t) => alt.push_str(&t),
            Event::SoftBreak | Event::HardBreak | Event::Rule => alt.push(' '),
            _ => {}
        }
    }
    let mut html = String::from("<img data-path=\"");
    let _ = escape_into(&mut html, &path.to_string_lossy());
    html.push_str("\" alt=\"");
    let _ = escape_into(&mut html, &alt);
    if !title.is_empty() {
        html.push_str("\" title=\"");
        let _ = escape_into(&mut html, title);
    }
    html.push_str("\" />");
    (Event::Html(CowStr::from(html)), alt)
}

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

/// Mermaid and KaTeX output is injected client-side after this point and
/// never passes through here.
fn sanitize(html: &str) -> String {
    ammonia::Builder::default()
        .add_tags(["input"]) // GFM task-list checkboxes
        .add_generic_attributes(["class", "id"]) // syntect scope spans, heading anchors
        .add_tag_attributes("input", ["type", "checked", "disabled"])
        .add_tag_attributes("a", ["aria-hidden", "data-path", "role", "tabindex"])
        .add_tag_attributes("img", ["data-path"])
        .add_tag_attributes("pre", ["data-lang"])
        // `style` is allowed only here, and only `text-align` survives:
        // ammonia's default (`style_properties: None`) passes a style
        // block through verbatim, so raw `<td style="position:fixed;
        // inset:0;background:url(https://…)">` would paint over the
        // window and beacon out. Only widen this for a property
        // pulldown-cmark itself emits.
        .add_tag_attributes("td", ["style"])
        .add_tag_attributes("th", ["style"])
        .filter_style_properties(["text-align"].into_iter().collect())
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

    // Windows has no bare-root-without-drive-letter concept the way POSIX
    // does: a literal "/tmp/mdreader-test" base_dir doesn't panic there
    // (render() never calls base_dir.is_absolute()), but a *destination*
    // resolved against it — or asserted against directly in html — must be
    // built through these two helpers, not a hardcoded POSIX string, or the
    // resulting `data-path` never matches what render() actually produced.
    // This is exactly the class of bug that shipped: see the module doc's
    // note on ammonia dropping `C:\...` attributes entirely.
    fn test_base_dir() -> PathBuf {
        if cfg!(windows) { PathBuf::from(r"C:\mdreader-test") } else { PathBuf::from("/tmp/mdreader-test") }
    }

    fn tdir(rel: &str) -> PathBuf {
        let mut p = test_base_dir();
        for seg in rel.split('/').filter(|s| !s.is_empty()) {
            p.push(seg);
        }
        p
    }

    // A path outside test_base_dir() entirely — for asserting that an
    // already-absolute destination is collected as-is, not joined onto the
    // base. Needs its own drive letter on Windows: an absolute POSIX-style
    // literal like "/definitely/..." is NOT `Path::is_absolute()` there (no
    // drive prefix), which would silently exercise the base_dir.join()
    // branch instead of the "kept as-is" branch this is meant to test.
    fn abs(rel: &str) -> PathBuf {
        let mut p = if cfg!(windows) { PathBuf::from(r"C:\") } else { PathBuf::from("/") };
        for seg in rel.split('/').filter(|s| !s.is_empty()) {
            p.push(seg);
        }
        p
    }

    fn r(source: &str) -> RenderedDoc {
        render(source, &test_base_dir()).0
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
        assert_eq!(doc.headings[0].text, "A bold link code");
    }

    #[test]
    fn gfm_tables_render_body_cells_and_alignment() {
        let doc = r("| a | b |\n|:---|---:|\n| 1 | 2 |\n| 3 | 4 |");
        assert!(doc.html.contains("<td"));
        // ammonia's style filter re-serializes declarations without the
        // space pulldown-cmark emits (`text-align:left`), so match on the
        // property/value pair rather than exact whitespace.
        assert!(doc.html.replace(' ', "").contains("text-align:left"), "{}", doc.html);
        assert!(doc.html.replace(' ', "").contains("text-align:right"), "{}", doc.html);
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

    // Intentional: relative destinations are NOT confined to the
    // document's directory. The mitigation lives on the frontend
    // (openWithSystem's denylist + confirm dialog) and in lib.rs's
    // Rust-side extension checks, not here.
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
        let (_doc, assets) = render("![](my%20image.png)", &test_base_dir());
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
        // [^a] must be footnote 1 and [^b] (inside the heading) must be
        // 2 — not both "1", which a second, isolated HtmlWriter for the
        // heading would produce. href is the raw label (`#a`/`#b`), not a
        // synthesized id; `rel="noopener noreferrer"` is ammonia's own.
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
        render(source, &test_base_dir())
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

    // Live-preview coverage: `render()` is unchanged, but `render_markdown`
    // (lib.rs) now calls it on every debounced keystroke, so it runs
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
        // The untitled-document case: render_markdown falls back to
        // current_dir(), which isn't guaranteed to exist either.
        let doc = render_at("# Hello\n\n![x](missing.png)", "/tmp/mdreader-test-does-not-exist");
        assert!(doc.html.contains("Hello"));
    }

    #[test]
    fn partial_markdown_states_do_not_panic() {
        // Every one of these is a plausible mid-keystroke buffer state.
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
        // Guards the "drain the parser until End(CodeBlock)" loop —
        // an unclosed fence must not consume the rest of the document
        // silently or panic.
        let doc = r("```rust\nfn x() {}\n");
        assert!(doc.html.contains("code-block"));
    }

    #[test]
    fn asset_list_reflects_only_the_current_source_not_prior_calls() {
        // render() is a pure function of its arguments — the asset list
        // must not accumulate across calls. This is exactly what
        // `render_and_grant`'s per-call scope-granting in lib.rs relies
        // on: a re-render after removing an image reference should not
        // still list that image.
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
    fn slugify_keeps_unicode_letters() {
        assert_eq!(slugify("Über"), "über");
        assert_eq!(slugify("日本語"), "日本語");
    }

    #[test]
    fn slugify_falls_back_to_section_for_punctuation_only_headings() {
        assert_eq!(slugify("!!!"), "section");
        let doc = r("# !!!\n\n# Section");
        assert_eq!(doc.headings[0].id, "section");
        assert_eq!(doc.headings[1].id, "section-1");
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
        // A comma is not whitespace, so the whole "rust,ignore" is looked
        // up as one syntax token (and found by neither name) — this pins
        // the documented "first whitespace-delimited token" behavior.
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
        // KaTeX's auto-render also matches "\(...\)" / "\[...\]" in
        // app.js's renderMathFor. But `(` and `)` are CommonMark-escapable
        // punctuation, so pulldown-cmark itself consumes the backslash
        // before this function ever sees the text — confirmed by
        // inspecting the parser's event stream directly. The rendered
        // HTML text nodes therefore never contain a literal backslash
        // either, so KaTeX's own browser-side delimiter scan would fail
        // identically. There's no gap to close here: has_math staying
        // false for this input is consistent with what actually reaches
        // the DOM, not a missed detection.
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
        // A destination that doesn't exist on disk forces the
        // lexically_normalize fallback (not canonicalize), so the
        // assertion doesn't depend on this machine's filesystem layout
        // (e.g. macOS symlinking /etc -> /private/etc). The destination is
        // built via abs(), not tdir() — this test's whole point is that an
        // already-absolute path is returned unchanged rather than joined
        // onto base_dir, so it deliberately sits outside test_base_dir().
        let dest = abs("definitely/does/not/exist.png");
        let (doc, assets) = render(&format!("![missing]({})", dest.display()), &tdir("docs"));
        assert!(doc.html.contains(&format!("data-path=\"{}\"", dest.display())), "{}", doc.html);
        assert_eq!(assets, vec![dest]);
    }

    #[test]
    fn lexically_normalize_swallows_a_leading_parent_component() {
        // Documents the intentional (if surprising) behavior: a leading
        // ".." has nothing to pop against, so it's silently dropped
        // rather than preserved. Exercised end-to-end (not just here) by
        // relative_links_may_escape_base_dir / resolves_parent_relative_image.
        // POSIX-only: this pins lexically_normalize's own separator-level
        // behavior on a hardcoded "/"-rooted input, not end-to-end
        // rendering (which the two tests above already cover
        // cross-platform via tdir()).
        #[cfg(unix)]
        {
            assert_eq!(lexically_normalize(Path::new("../x")), PathBuf::from("x"));
            assert_eq!(lexically_normalize(Path::new("/../x")), PathBuf::from("/x"));
        }
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
        // The broadest guard for the "one push_html call" invariant: each
        // of these features is also tested in isolation above, which is
        // exactly what let the original writer-state-corruption bug hide
        // — this asserts all three still behave correctly when they share
        // one document and one HtmlWriter.
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
        // Dependency-free timing stand-in (no dev-dependencies exist in
        // this crate). Run with --release; sanity-checks against the
        // ~200ms live-preview debounce in app.js.
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
}
