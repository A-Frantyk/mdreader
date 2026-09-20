//! Markdown -> sanitized HTML: single parser pass, single `push_html` call
//! (see CLAUDE.md's one-`push_html`-call invariant). Delegates to `paths`
//! (destination resolution), `events` (Link/Image -> HTML), `headings`
//! (slug/id generation), `highlight` (syntect fences), `sanitize` (ammonia
//! allowlist) — see CLAUDE.md's path-resolution invariant for `data-path`.

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
                // Buffered, not push_html'd separately — a second call here shipped once and broke
                // footnote numbering (CLAUDE.md's one-push_html invariant).
                let mut inner: Vec<Event> = Vec::new();
                let mut plain = String::new();
                while let Some(inner_event) = parser.next() {
                    match inner_event {
                        Event::End(TagEnd::Heading(_)) => break,
                        // resolve_image_event drains a local image's alt text, so fold it into `plain` here.
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
