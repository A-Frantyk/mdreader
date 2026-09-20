//! Turning `Tag::Link`/`Tag::Image` parser events into resolved `<a data-path>`/
//! `<img data-path>` HTML — see CLAUDE.md's path-resolution invariant for why.

use std::path::{Path, PathBuf};

use pulldown_cmark::{CowStr, Event, Parser, Tag};
use pulldown_cmark_escape::escape_html as escape_into;

use super::paths::resolve_local;

/// Appends ` name="escaped(value)"` to `html` — shared by the `<a>` and `<img>` builders below.
fn push_attr(html: &mut String, name: &str, value: &str) {
    html.push(' ');
    html.push_str(name);
    html.push_str("=\"");
    let _ = escape_into(&mut *html, value);
    html.push('"');
}

/// Handles `Tag::Link` only — `Tag::Image` needs its alt text drained too, which an
/// `Event -> Event` shape can't do. `data-path`, not `href`: see CLAUDE.md.
pub(super) fn resolve_event<'a>(event: Event<'a>, base_dir: &Path) -> Event<'a> {
    match event {
        Event::Start(Tag::Link { link_type, dest_url, title, id }) => {
            match resolve_local(base_dir, &dest_url) {
                Some(path) => {
                    let mut html = String::from("<a");
                    push_attr(&mut html, "data-path", &path.to_string_lossy());
                    // Restores what a plain `<a href>` gets for free: focus and a pointer cursor.
                    html.push_str(" role=\"link\" tabindex=\"0\"");
                    if !title.is_empty() {
                        push_attr(&mut html, "title", &title);
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

/// Shared by the top-level match and the heading-inner-event loop, so this logic
/// lives in exactly one place. A non-local destination is re-emitted unchanged.
pub(super) fn resolve_image_event<'a>(
    tag: Tag<'a>,
    base_dir: &Path,
    parser: &mut Parser<'a>,
    assets: &mut Vec<PathBuf>,
) -> (Event<'a>, String) {
    let Tag::Image { ref dest_url, ref title, .. } = tag else {
        unreachable!("resolve_image_event is only ever called with Tag::Image")
    };
    match resolve_local(base_dir, dest_url) {
        Some(path) => resolve_local_image(title, parser, assets, path),
        None => (Event::Start(tag), String::new()),
    }
}

/// Builds a complete `<img>` tag plus the raw alt text, for a caller inside a heading
/// to fold into its own slug/TOC accumulator. Drains `parser` to `TagEnd::Image`,
/// mirroring `pulldown_cmark::html::HtmlWriter::raw_text` — deliberately not reproduced:
/// footnote numbering inside alt text (needs the writer's private counter) and the
/// TaskListMarker/InlineMath/DisplayMath variants (none occur inside `![alt](...)`).
fn resolve_local_image<'a>(
    title: &str,
    parser: &mut Parser<'a>,
    assets: &mut Vec<PathBuf>,
    path: PathBuf,
) -> (Event<'a>, String) {
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
    let mut html = String::from("<img");
    push_attr(&mut html, "data-path", &path.to_string_lossy());
    push_attr(&mut html, "alt", &alt);
    if !title.is_empty() {
        push_attr(&mut html, "title", title);
    }
    html.push_str(" />");
    assets.push(path);
    (Event::Html(CowStr::from(html)), alt)
}
