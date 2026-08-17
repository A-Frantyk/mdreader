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
//! whole attribute. See `events::resolve_event`'s comment for the full
//! story.
//!
//! Mermaid and math are NOT rendered here. We only detect their presence
//! so the frontend can lazy-load the (heavy) mermaid.js / KaTeX bundles
//! only for documents that actually need them. Mermaid fences are left as
//! `<pre class="mermaid">RAW_SOURCE</pre>` for mermaid.js to pick up
//! client-side; math is left as literal `$...$` / `$$...$$` text for
//! KaTeX's auto-render extension to find and typeset client-side.
//!
//! The driver here owns the single parser pass and the transformed event
//! accumulator; each concern it delegates to has its own submodule:
//! `paths` (destination resolution), `events` (Link/Image -> HTML),
//! `headings` (slug/id generation), `highlight` (syntect fences), and
//! `sanitize` (the ammonia allowlist).

mod events;
mod headings;
mod highlight;
mod paths;
mod sanitize;
#[cfg(test)]
mod testutil;
#[cfg(test)]
mod tests;

pub use highlight::SYNTAX_SET;

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use pulldown_cmark::{CodeBlockKind, CowStr, Event, Options, Parser, Tag, TagEnd};
use pulldown_cmark_escape::escape_html as escape_into;

use events::{resolve_event, resolve_image_event};
use headings::{slugify, unique_id};
use highlight::highlight_code_block;
use sanitize::sanitize;

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
                        // A local image's alt text is drained by
                        // resolve_image_event itself (see below), so it
                        // can't reach the Text/Code arm below the way it
                        // does for a non-local image — fold it into `plain`
                        // here instead, to keep contributing to the
                        // heading's slug/TOC text either way.
                        Event::Start(tag @ Tag::Image { .. }) => {
                            let (ev, alt) = resolve_image_event(tag, base_dir, &mut parser, &mut assets);
                            plain.push_str(&alt);
                            inner.push(ev);
                        }
                        other => {
                            if let Event::Text(t) | Event::Code(t) = &other {
                                plain.push_str(t);
                            }
                            inner.push(resolve_event(other, base_dir));
                        }
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
            Event::Start(tag @ Tag::Image { .. }) => {
                let (ev, _alt) = resolve_image_event(tag, base_dir, &mut parser, &mut assets);
                transformed.push(ev);
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
