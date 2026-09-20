//! Syntect-based syntax highlighting for fenced code blocks.

use std::sync::LazyLock;

use pulldown_cmark_escape::escape_html as escape_into;
use syntect::html::{ClassStyle, ClassedHTMLGenerator};
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;

pub static SYNTAX_SET: LazyLock<SyntaxSet> = LazyLock::new(SyntaxSet::load_defaults_newlines);

pub(super) fn highlight_code_block(code: &str, lang: &str) -> String {
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
    // "code", not "code-block": build.rs's generated theme CSS targets this exact class.
    format!("<pre class=\"code-block code\"{lang_class}><code>{body}</code></pre>\n")
}
