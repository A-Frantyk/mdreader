//! Turning `Tag::Link`/`Tag::Image` parser events into resolved
//! `<a data-path>`/`<img data-path>` HTML — see render.rs's module doc for
//! why a local destination bypasses `href=`/`src=` entirely.

use std::path::{Path, PathBuf};

use pulldown_cmark::{CowStr, Event, Parser, Tag};
use pulldown_cmark_escape::escape_html as escape_into;

use super::paths::resolve_local;

/// Appends ` name="escaped(value)"` to `html` — the one shape both
/// `resolve_event`'s `<a>` and `resolve_image_event`'s `<img>` builders need
/// repeatedly (`data-path`, `alt`, `title`).
fn push_attr(html: &mut String, name: &str, value: &str) {
    html.push(' ');
    html.push_str(name);
    html.push_str("=\"");
    let _ = escape_into(&mut *html, value);
    html.push('"');
}

// Local link/image destinations deliberately do NOT flow into `href=`/`src=`
// — see the "Path resolution stays in Rust" invariant in CLAUDE.md. Ammonia
// applies URL semantics to those attributes, and a resolved Windows path
// (`C:\Users\...`) parses as URL scheme `c`, which isn't in ammonia's scheme
// allowlist — the whole attribute is silently dropped. `data-path` isn't
// URL-typed, so ammonia (with the tag_attributes allowlist below) passes it
// through byte-for-byte on every platform. resolve_local already returns
// None for anything external/anchored/scheme'd, so those keep flowing
// through pulldown-cmark's normal `href=`/`src=` output untouched.
/// Handles `Tag::Link` only — `Tag::Image` needs its alt text drained too
/// (see `resolve_image_event`), which an `Event -> Event` shape can't do.
pub(super) fn resolve_event<'a>(event: Event<'a>, base_dir: &Path) -> Event<'a> {
    match event {
        Event::Start(Tag::Link { link_type, dest_url, title, id }) => {
            match resolve_local(base_dir, &dest_url) {
                Some(path) => {
                    let mut html = String::from("<a");
                    push_attr(&mut html, "data-path", &path.to_string_lossy());
                    // role/tabindex restore what a plain `<a href>` gets for
                    // free — keyboard focus and a pointer cursor — since an
                    // <a> with no href is otherwise inert to both. See
                    // app.js's contentWrap keydown handler for the Enter/
                    // Space side of this.
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

/// Resolves a `Tag::Image` Start event — shared by the top-level match and
/// the heading-inner-event loop so there's exactly one place this logic
/// lives, same reasoning as `resolve_event`. A local destination is fully
/// built here (see `resolve_local_image`); anything else is re-emitted
/// unchanged, and its alt-text/End events are left for the caller's own
/// loop to pick up on its next iteration, same as before this function
/// existed.
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
