use super::*;
use crate::render::testutil::r;

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
