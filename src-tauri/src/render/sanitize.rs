//! Ammonia allowlist configuration — the one place untrusted HTML gets
//! cleaned before it reaches the webview.

/// Mermaid and KaTeX output is injected client-side after this point and
/// never passes through here.
pub(super) fn sanitize(html: &str) -> String {
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
