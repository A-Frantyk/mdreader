// The formatting-toolbar / keyboard-shortcut text transforms — the most
// logic-dense functions in app.js, and (before this suite) completely
// unexercised by anything. Each takes a `cm` parameter and touches no DOM
// or Tauri IPC, so `fakeCm` (a real line-buffer implementing the handful
// of CodeMirror 5 methods these functions call) is enough on its own.
import test from "node:test";
import assert from "node:assert/strict";
import { freshApp, fakeCm } from "./harness.mjs";

test("posAfterText", async (t) => {
  const { window } = freshApp();
  // posAfterText's return value is a plain object created inside jsdom's
  // vm context, so it carries that realm's Object.prototype — deepStrictEqual
  // treats it as unequal to a same-shaped literal from this (Node) realm
  // even when every property matches. structuredClone re-materializes it
  // here, in the calling realm, before comparing.
  const posOf = (...args) => structuredClone(window.posAfterText(...args));

  await t.test("single-line insert advances ch by the text length", () => {
    assert.deepEqual(posOf({ line: 2, ch: 3 }, "abc"), { line: 2, ch: 6 });
  });
  await t.test("multi-line insert lands on the inserted text's last line", () => {
    assert.deepEqual(posOf({ line: 2, ch: 3 }, "one\ntwo\nthree"), { line: 4, ch: 5 });
  });
  await t.test("empty text leaves the position unchanged", () => {
    assert.deepEqual(posOf({ line: 2, ch: 3 }, ""), { line: 2, ch: 3 });
  });
  await t.test("text ending in a newline lands at ch 0 of the new line", () => {
    assert.deepEqual(posOf({ line: 0, ch: 5 }, "abc\n"), { line: 1, ch: 0 });
  });
});

test("wrapSelection", async (t) => {
  await t.test("unwraps when the selection itself includes the markers", () => {
    const { window } = freshApp();
    const cm = fakeCm("**hello** world");
    cm.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 9 }); // "**hello**"
    window.wrapSelection(cm, "**");
    assert.equal(cm.getValue(), "hello world");
    assert.deepEqual(cm.getCursor("from"), { line: 0, ch: 0 });
    assert.deepEqual(cm.getCursor("to"), { line: 0, ch: 5 });
  });

  await t.test("unwraps when the markers sit just outside the selection", () => {
    const { window } = freshApp();
    const cm = fakeCm("**hello** world");
    cm.setSelection({ line: 0, ch: 2 }, { line: 0, ch: 7 }); // "hello", markers just outside
    window.wrapSelection(cm, "**");
    assert.equal(cm.getValue(), "hello world");
  });

  await t.test("wraps an empty selection and leaves the cursor between the markers", () => {
    const { window } = freshApp();
    const cm = fakeCm("hello world");
    cm.setCursor({ line: 0, ch: 5 }); // between "hello" and " world"
    window.wrapSelection(cm, "**");
    assert.equal(cm.getValue(), "hello**** world");
    assert.deepEqual(cm.getCursor("from"), { line: 0, ch: 7 });
    assert.deepEqual(cm.getCursor("to"), { line: 0, ch: 7 });
  });

  await t.test("wraps a multi-line selection, placing positions via posAfterText not flat arithmetic", () => {
    const { window } = freshApp();
    const cm = fakeCm("line one\nline two");
    cm.setSelection({ line: 0, ch: 5 }, { line: 1, ch: 4 }); // "one\nline"
    window.wrapSelection(cm, "~~");
    assert.equal(cm.getValue(), "line ~~one\nline~~ two");
    // A flat `to.ch + marker.length` would have landed on line 0, not 1.
    assert.deepEqual(cm.getCursor("from"), { line: 0, ch: 7 });
    assert.deepEqual(cm.getCursor("to"), { line: 1, ch: 4 });
  });

  await t.test("toggling a plain wrap on and back off restores the exact original text", () => {
    const { window } = freshApp();
    const cm = fakeCm("plain text");
    cm.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 5 }); // "plain"
    window.wrapSelection(cm, "*");
    assert.equal(cm.getValue(), "*plain* text");
    cm.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 7 }); // "*plain*"
    window.wrapSelection(cm, "*");
    assert.equal(cm.getValue(), "plain text");
  });

  await t.test("documents the */** ambiguity: italicizing text already inside ** peels one marker off each side", () => {
    // wrapSelection can't tell "the single '*' just outside the
    // selection" apart from "the outer half of a '**' pair" — this is a
    // known, undisambiguated limitation (see the function's doc comment
    // in app.js), pinned here so a future change to that logic is a
    // deliberate one.
    const { window } = freshApp();
    const cm = fakeCm("**bold**");
    cm.setSelection({ line: 0, ch: 2 }, { line: 0, ch: 6 }); // "bold"
    window.wrapSelection(cm, "*");
    assert.equal(cm.getValue(), "*bold*");
  });
});

test("toggleLinePrefix", async (t) => {
  await t.test("adds the prefix to every line of a multi-line selection", () => {
    const { window } = freshApp();
    const cm = fakeCm("one\ntwo\nthree");
    cm.setSelection({ line: 0, ch: 0 }, { line: 2, ch: 5 });
    window.toggleLinePrefix(cm, /^[-*+]\s+/, () => "- ", { stripOtherListMarkers: true });
    assert.equal(cm.getValue(), "- one\n- two\n- three");
  });

  await t.test("strips the prefix when every touched line already has it", () => {
    const { window } = freshApp();
    const cm = fakeCm("- one\n- two");
    cm.setSelection({ line: 0, ch: 0 }, { line: 1, ch: 5 });
    window.toggleLinePrefix(cm, /^[-*+]\s+/, () => "- ", { stripOtherListMarkers: true });
    assert.equal(cm.getValue(), "one\ntwo");
  });

  await t.test("a mixed selection (some lines already prefixed) resolves to add, not strip", () => {
    const { window } = freshApp();
    const cm = fakeCm("- one\ntwo");
    cm.setSelection({ line: 0, ch: 0 }, { line: 1, ch: 3 });
    window.toggleLinePrefix(cm, /^[-*+]\s+/, () => "- ", { stripOtherListMarkers: true });
    assert.equal(cm.getValue(), "- one\n- two");
  });

  await t.test("ordered-list numbering is sequential across only the freshly-added lines", () => {
    // Bug fix regression: `n` used to advance for every touched line,
    // including ones skipped because they already had a number — on a
    // partially-numbered selection that produced duplicate/skipped
    // numbers instead of a clean 1. 2. 3. sequence.
    const { window } = freshApp();
    const cm = fakeCm("1. one\ntwo\nthree");
    cm.setSelection({ line: 0, ch: 0 }, { line: 2, ch: 5 });
    window.toggleLinePrefix(cm, /^\d+[.)]\s+/, (n) => `${n}. `, { stripOtherListMarkers: true });
    assert.equal(cm.getValue(), "1. one\n1. two\n2. three");
  });

  await t.test("stripOtherListMarkers converts an existing bullet line to numbered rather than stacking", () => {
    const { window } = freshApp();
    const cm = fakeCm("- item");
    cm.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 6 });
    window.toggleLinePrefix(cm, /^\d+[.)]\s+/, (n) => `${n}. `, { stripOtherListMarkers: true });
    assert.equal(cm.getValue(), "1. item");
  });

  await t.test("blockquote deliberately preserves a nested list marker", () => {
    const { window } = freshApp();
    const cm = fakeCm("- item");
    cm.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 6 });
    window.toggleLinePrefix(cm, /^>\s?/, () => "> "); // no stripOtherListMarkers
    assert.equal(cm.getValue(), "> - item");
  });

  await t.test("the whole multi-line toggle runs inside exactly one cm.operation", () => {
    const { window } = freshApp();
    const cm = fakeCm("one\ntwo\nthree");
    cm.setSelection({ line: 0, ch: 0 }, { line: 2, ch: 5 });
    window.toggleLinePrefix(cm, /^[-*+]\s+/, () => "- ", { stripOtherListMarkers: true });
    assert.equal(cm.operationCalls, 1);
  });
});

test("setHeading / cycleHeading", async (t) => {
  await t.test("sets an ATX heading level 1 through 6", () => {
    const { window } = freshApp();
    for (let level = 1; level <= 6; level++) {
      const cm = fakeCm("Some text");
      cm.setCursor({ line: 0, ch: 0 });
      window.setHeading(cm, level);
      assert.equal(cm.getValue(), `${"#".repeat(level)} Some text`);
    }
  });

  await t.test("level 0 clears an existing heading back to a plain paragraph", () => {
    const { window } = freshApp();
    const cm = fakeCm("### Some text");
    cm.setCursor({ line: 0, ch: 0 });
    window.setHeading(cm, 0);
    assert.equal(cm.getValue(), "Some text");
  });

  await t.test("only affects the selection's first line", () => {
    const { window } = freshApp();
    const cm = fakeCm("one\ntwo");
    cm.setSelection({ line: 0, ch: 0 }, { line: 1, ch: 3 });
    window.setHeading(cm, 2);
    assert.equal(cm.getValue(), "## one\ntwo");
  });

  await t.test("a heading marker with no following space is left alone and gets re-prefixed", () => {
    // /^(#{1,6})\s+/ requires whitespace after the hashes, so "###nospace"
    // doesn't match the existing-heading branch — this pins that as
    // current behavior rather than an assumed fix.
    const { window } = freshApp();
    const cm = fakeCm("###nospace");
    cm.setCursor({ line: 0, ch: 0 });
    window.setHeading(cm, 2);
    assert.equal(cm.getValue(), "## ###nospace");
  });

  await t.test("cycleHeading advances 1 through 6 then wraps to plain, and back to 1", () => {
    const { window } = freshApp();
    const cm = fakeCm("Text");
    cm.setCursor({ line: 0, ch: 0 });
    window.cycleHeading(cm); // -> H1
    assert.equal(cm.getValue(), "# Text");
    for (let i = 0; i < 5; i++) window.cycleHeading(cm); // H2..H6
    assert.equal(cm.getValue(), "###### Text");
    window.cycleHeading(cm); // wraps to plain
    assert.equal(cm.getValue(), "Text");
    window.cycleHeading(cm); // back to H1
    assert.equal(cm.getValue(), "# Text");
  });
});

test("insertLink / insertImage", async (t) => {
  await t.test("insertLink with a selection wraps it and selects the url placeholder", () => {
    const { window } = freshApp();
    const cm = fakeCm("click here");
    cm.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 10 });
    window.insertLink(cm);
    assert.equal(cm.getValue(), "[click here](url)");
    assert.equal(cm.getRange(cm.getCursor("from"), cm.getCursor("to")), "url");
  });

  await t.test("insertLink with no selection inserts a full placeholder and selects 'text'", () => {
    const { window } = freshApp();
    const cm = fakeCm("");
    cm.setCursor({ line: 0, ch: 0 });
    window.insertLink(cm);
    assert.equal(cm.getValue(), "[text](url)");
    assert.equal(cm.getRange(cm.getCursor("from"), cm.getCursor("to")), "text");
  });

  await t.test("insertImage with a selection uses it as alt text and selects the url placeholder", () => {
    const { window } = freshApp();
    const cm = fakeCm("a diagram");
    cm.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 9 });
    window.insertImage(cm);
    assert.equal(cm.getValue(), "![a diagram](url)");
    assert.equal(cm.getRange(cm.getCursor("from"), cm.getCursor("to")), "url");
  });

  await t.test("insertImage with no selection selects 'alt'", () => {
    const { window } = freshApp();
    const cm = fakeCm("");
    cm.setCursor({ line: 0, ch: 0 });
    window.insertImage(cm);
    assert.equal(cm.getValue(), "![alt](url)");
    assert.equal(cm.getRange(cm.getCursor("from"), cm.getCursor("to")), "alt");
  });
});

test("insertHorizontalRule / insertTable", async (t) => {
  await t.test("horizontal rule is padded with blank lines on both sides", () => {
    const { window } = freshApp();
    const cm = fakeCm("above\nbelow");
    cm.setCursor({ line: 0, ch: 5 }); // end of "above"
    window.insertHorizontalRule(cm);
    assert.equal(cm.getValue(), "above\n\n---\n\n\nbelow");
  });

  await t.test("table skeleton is padded and the cursor lands at the start of Header 1", () => {
    const { window } = freshApp();
    const cm = fakeCm("text");
    cm.setCursor({ line: 0, ch: 4 });
    window.insertTable(cm);
    assert.equal(
      cm.getValue(),
      "text\n\n| Header 1 | Header 2 |\n| --- | --- |\n| Cell 1 | Cell 2 |\n\n"
    );
    assert.equal(cm.getRange(cm.getCursor("from"), { line: cm.getCursor("from").line, ch: cm.getCursor("from").ch + 8 }), "Header 1");
  });
});

test("insertFootnote", async (t) => {
  await t.test("the first footnote in a document is [^1]", () => {
    const { window } = freshApp();
    const cm = fakeCm("A claim.");
    cm.setCursor({ line: 0, ch: 8 });
    window.insertFootnote(cm);
    assert.equal(cm.getValue(), "A claim.[^1]\n\n[^1]: ");
  });

  await t.test("numbers one past the highest existing [^n]: definition", () => {
    const { window } = freshApp();
    const cm = fakeCm("Text.\n\n[^1]: one\n[^5]: five");
    cm.setCursor({ line: 0, ch: 5 });
    window.insertFootnote(cm);
    assert.match(cm.getValue(), /Text\.\[\^6\]\n/);
    assert.match(cm.getValue(), /\[\^6\]: $/);
  });

  await t.test("a non-numeric footnote label is ignored when computing the next number", () => {
    const { window } = freshApp();
    const cm = fakeCm("Text.\n\n[^note]: not a number");
    cm.setCursor({ line: 0, ch: 5 });
    window.insertFootnote(cm);
    assert.match(cm.getValue(), /Text\.\[\^1\]\n/);
  });

  await t.test("a reference with no matching definition doesn't affect numbering", () => {
    const { window } = freshApp();
    const cm = fakeCm("Text.[^3]\n\n[^1]: one");
    cm.setCursor({ line: 0, ch: 5 });
    window.insertFootnote(cm);
    // Only [^1]: is a *definition* line — [^3] is a bare reference, so the
    // next number is 2, not 4.
    assert.match(cm.getValue(), /Text\.\[\^2\]\[\^3\]\n/);
  });
});
