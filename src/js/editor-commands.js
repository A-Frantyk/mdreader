// CodeMirror editing commands behind the formatting toolbar and its keyboard shortcuts.

/// Wrap (or, on a second call, unwrap) the editor's current selection in
/// `marker` — the logic behind the Bold/Italic/Strikethrough toolbar
/// buttons and their keyboard shortcuts. `marker` must be symmetric (same
/// string on both sides, e.g. "**"/"*"/"~~").
///
/// Toggle-aware like a word processor's Bold button: clicking it again on
/// already-bold text un-bolds rather than double-wrapping. Two ways a
/// selection can "already be bold" — the selection itself includes the
/// markers, or the markers sit just outside the selection — both are
/// checked before falling through to wrap.
function wrapSelection(cm, marker) {
  const from = cm.getCursor("from");
  const to = cm.getCursor("to");
  const selected = cm.getRange(from, to);
  const mlen = marker.length;

  if (selected.length >= mlen * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
    const inner = selected.slice(mlen, selected.length - mlen);
    cm.replaceRange(inner, from, to);
    // replaceRange doesn't keep the new text selected on its own (it
    // collapses to a cursor) — set it explicitly so this matches case
    // 2's behavior below, and a second click toggles it back on again.
    cm.setSelection(from, posAfterText(from, inner));
    cm.focus();
    return;
  }

  // Case 2: the markers sit just outside the selection. Peeking past the
  // selection's own start/end is safe even near a line boundary —
  // Math.max(0, ...) keeps the "before" probe in range, and CodeMirror's
  // getRange clamps an out-of-bounds "after" ch to the line's actual
  // length, so a short line just fails to match rather than throwing.
  const before = cm.getRange({ line: from.line, ch: Math.max(0, from.ch - mlen) }, from);
  const after = cm.getRange(to, { line: to.line, ch: to.ch + mlen });
  if (before === marker && after === marker) {
    const newFrom = { line: from.line, ch: from.ch - mlen };
    const newTo = { line: to.line, ch: to.ch + mlen };
    cm.replaceRange(selected, newFrom, newTo);
    cm.setSelection(newFrom, posAfterText(newFrom, selected));
    cm.focus();
    return;
  }

  // Each new position is computed via posAfterText, not by adding
  // lengths to `from`/`to` directly — correct even when `selected` spans
  // multiple lines, where a flat `to.ch + mlen` would land on the wrong
  // line entirely.
  cm.replaceRange(marker + selected + marker, from, to);
  const innerStart = posAfterText(from, marker);
  if (selected.length === 0) {
    cm.setCursor(innerStart);
  } else {
    cm.setSelection(innerStart, posAfterText(innerStart, selected));
  }
  cm.focus();
}

/// Toggles a per-line prefix (blockquote `>`, the three list types) across
/// every line the selection touches. If every touched line already
/// matches `testRe`, strips it from all of them; otherwise adds
/// `makePrefix(n)` (1-based, for numbered lists' sequential renumbering)
/// to every line that doesn't already have it — a mixed-state selection
/// resolves to "add." Wrapped in `cm.operation` so a multi-line toggle is
/// one undo step, not one per line.
///
/// `stripOtherListMarkers`: bullet/numbered/task are mutually exclusive as
/// a line's list-marker type — clicking Numbered List on an existing
/// bullet-list line must convert it, not stack. Blockquote doesn't pass
/// this — `> - item` is valid, a blockquote can legitimately contain a
/// list.
const LIST_PREFIX_RE = /^([-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/;

function toggleLinePrefix(cm, testRe, makePrefix, { stripOtherListMarkers = false } = {}) {
  const from = cm.getCursor("from");
  const to = cm.getCursor("to");
  let allHave = true;
  for (let l = from.line; l <= to.line; l++) {
    if (!testRe.test(cm.getLine(l))) { allHave = false; break; }
  }
  cm.operation(() => {
    let n = 1;
    for (let l = from.line; l <= to.line; l++) {
      const text = cm.getLine(l);
      if (allHave) {
        cm.replaceRange(text.replace(testRe, ""), { line: l, ch: 0 }, { line: l, ch: text.length });
      } else {
        if (!testRe.test(text)) {
          const base = stripOtherListMarkers ? text.replace(LIST_PREFIX_RE, "") : text;
          cm.replaceRange(makePrefix(n) + base, { line: l, ch: 0 }, { line: l, ch: text.length });
          // Only lines that actually get a fresh prefix consume the next
          // number — n used to advance for every touched line, including
          // ones skipped because they already had a prefix, which skewed
          // the newly-added numbers on a partially-numbered selection
          // (e.g. two lines both ending up "2.").
          n++;
        }
      }
    }
  });
  cm.focus();
}

/// Sets the current line's ATX heading level (0 = plain paragraph).
/// Selection's first line only — a heading is inherently single-line, so
/// heading-ifying every line of a multi-line selection isn't expected.
function setHeading(cm, level) {
  const line = cm.getCursor("from").line;
  const text = cm.getLine(line);
  const match = text.match(/^(#{1,6})\s+/);
  const stripped = match ? text.slice(match[0].length) : text;
  const newText = level === 0 ? stripped : "#".repeat(level) + " " + stripped;
  cm.replaceRange(newText, { line, ch: 0 }, { line, ch: text.length });
  cm.setCursor({ line, ch: newText.length });
  cm.focus();
}

function cycleHeading(cm) {
  const match = cm.getLine(cm.getCursor("from").line).match(/^(#{1,6})\s+/);
  const level = match ? match[1].length : 0;
  setHeading(cm, level >= 6 ? 0 : level + 1);
}

/// Shared shape for Link/Image: build a template from the current
/// selection (or a placeholder if there's none), insert it, then select
/// the part of the template most likely to be edited next.
/// `withSelection`/`withoutSelection` return `{ text, selStart, selEnd }`
/// — offsets into `text` for the sub-range to select afterward.
function insertTemplate(cm, { withSelection, withoutSelection }) {
  const from = cm.getCursor("from");
  const to = cm.getCursor("to");
  const selected = cm.getRange(from, to);
  const template = selected ? withSelection(selected) : withoutSelection();
  cm.replaceRange(template.text, from, to);
  cm.setSelection(
    posAfterText(from, template.text.slice(0, template.selStart)),
    posAfterText(from, template.text.slice(0, template.selEnd))
  );
  cm.focus();
}

function insertLink(cm) {
  insertTemplate(cm, {
    withSelection: (sel) => {
      const text = `[${sel}](url)`;
      return { text, selStart: text.length - 4, selEnd: text.length - 1 };
    },
    withoutSelection: () => ({ text: "[text](url)", selStart: 1, selEnd: 5 }),
  });
}

function insertImage(cm) {
  insertTemplate(cm, {
    withSelection: (sel) => {
      const text = `![${sel}](url)`;
      return { text, selStart: text.length - 4, selEnd: text.length - 1 };
    },
    withoutSelection: () => ({ text: "![alt](url)", selStart: 2, selEnd: 5 }),
  });
}

/// The blank lines around `---` are load-bearing, not cosmetic:
/// CommonMark's setext-heading syntax turns a `---` line with no blank
/// line before it into an H2 underline for the preceding paragraph
/// instead of a thematic break. Without this padding, the button would
/// silently retitle whatever paragraph the cursor happens to be in.
function insertHorizontalRule(cm) {
  const from = cm.getCursor("from");
  const to = cm.getCursor("to");
  cm.replaceRange("\n\n---\n\n", from, to);
  cm.focus();
}

/// Same blank-line reasoning as insertHorizontalRule — an un-padded table
/// can get absorbed as paragraph continuation text instead of parsed as a
/// table. Cursor lands at the start of "Header 1" to type over it.
function insertTable(cm) {
  const from = cm.getCursor("from");
  const to = cm.getCursor("to");
  const prefix = "\n\n| ";
  const table = `${prefix}Header 1 | Header 2 |\n| --- | --- |\n| Cell 1 | Cell 2 |\n\n`;
  cm.replaceRange(table, from, to);
  cm.setCursor(posAfterText(from, prefix));
  cm.focus();
}

/// Inserts a footnote reference `[^n]` at the cursor and its matching
/// definition `[^n]: ` at the document's end, as one atomic `cm.operation`.
/// `n` is scanned from existing `[^n]:` *definition* lines (not
/// references, which could legitimately reuse a number), taking max + 1.
/// `lastLine()`/`getLine()` are read *after* the reference insert, inside
/// the same operation, so they reflect the document's current state
/// rather than a stale snapshot.
function insertFootnote(cm) {
  const doc = cm.getValue();
  const nums = [...doc.matchAll(/^\[\^(\d+)\]:/gm)].map((m) => parseInt(m[1], 10));
  const n = nums.length ? Math.max(...nums) + 1 : 1;
  cm.operation(() => {
    const cursor = cm.getCursor("from");
    cm.replaceRange(`[^${n}]`, cursor, cursor);
    const lastLine = cm.lastLine();
    const endOfDoc = { line: lastLine, ch: cm.getLine(lastLine).length };
    cm.replaceRange(`\n\n[^${n}]: `, endOfDoc, endOfDoc);
    const newLastLine = cm.lastLine();
    cm.setCursor({ line: newLastLine, ch: cm.getLine(newLastLine).length });
  });
  cm.focus();
}

/// CodeMirror 5 looks `extraKeys` up as a raw object property against the
/// name it builds in addModifierNames — "Cmd-B" on macOS, "Ctrl-B"
/// elsewhere, with Shift outermost ("Shift-Cmd-X", not "Cmd-Shift-X").
/// There is deliberately no "Mod-" alias to lean on: extraKeys is never
/// run through normalizeKeyMap (which the library defines and exports but
/// never calls itself, confirmed by grepping lib/codemirror.js — only
/// those two references exist), and normalizeKeyName would throw on
/// "Mod" if it somehow were. This was a real, shipped bug — this app's
/// Cmd/Ctrl+B/I/Shift+X bindings were written as "Mod-B" etc. and matched
/// nothing for the entire life of the split-mode feature, silently
/// falling through to CodeMirror's own (unrelated or absent) bindings.
/// Ask CodeMirror which platform keymap it actually resolved to, rather
/// than re-sniffing navigator.platform ourselves, so this can't drift
/// from the map extraKeys will really be looked up against.
function editorKeyName(key, shift = false) {
  const CM = window.CodeMirror;
  const mac = CM.keyMap.default === CM.keyMap.macDefault;
  return `${shift ? "Shift-" : ""}${mac ? "Cmd-" : "Ctrl-"}${key}`;
}

/// Cmd/Ctrl shortcuts available while the editor has focus. Deliberately
/// no underline binding, same reason as the toolbar: no Markdown syntax
/// for it (see CLAUDE.md).
const EDITOR_SHORTCUTS = [
  { key: "B", action: (cm) => wrapSelection(cm, "**") },
  { key: "I", action: (cm) => wrapSelection(cm, "*") },
  { key: "X", shift: true, action: (cm) => wrapSelection(cm, "~~") },
  { key: "K", action: insertLink },
  { key: "C", shift: true, action: (cm) => wrapSelection(cm, "`") },
  { key: ".", shift: true, action: (cm) => toggleLinePrefix(cm, /^>\s?/, () => "> ") },
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ key: String(n), action: (cm) => setHeading(cm, n) })),
  { key: "0", action: (cm) => setHeading(cm, 0) },
];

function editorExtraKeys() {
  const map = {};
  for (const { key, shift, action } of EDITOR_SHORTCUTS) {
    map[editorKeyName(key, shift)] = action;
  }
  return map;
}

const TOOLBAR_GROUPS = [
  [
    { label: "B", title: "Bold (Cmd/Ctrl+B)", style: "font-weight:700", action: (cm) => wrapSelection(cm, "**") },
    { label: "I", title: "Italic (Cmd/Ctrl+I)", style: "font-style:italic", action: (cm) => wrapSelection(cm, "*") },
    {
      label: "S",
      title: "Strikethrough (Cmd/Ctrl+Shift+X)",
      style: "text-decoration:line-through",
      action: (cm) => wrapSelection(cm, "~~"),
    },
    { label: "</>", title: "Inline code (Cmd/Ctrl+Shift+C)", action: (cm) => wrapSelection(cm, "`") },
  ],
  [
    { label: "H", title: "Heading (cycles H1–H6; Cmd/Ctrl+1–6 sets a level, +0 clears)", action: cycleHeading },
    {
      label: "❝",
      title: "Blockquote (Cmd/Ctrl+Shift+.)",
      action: (cm) => toggleLinePrefix(cm, /^>\s?/, () => "> "),
    },
    {
      label: "•",
      title: "Bullet list",
      action: (cm) => toggleLinePrefix(cm, /^[-*+]\s+/, () => "- ", { stripOtherListMarkers: true }),
    },
    {
      label: "1.",
      title: "Numbered list",
      action: (cm) => toggleLinePrefix(cm, /^\d+[.)]\s+/, (n) => `${n}. `, { stripOtherListMarkers: true }),
    },
    {
      label: "☑",
      title: "Task list",
      action: (cm) =>
        toggleLinePrefix(cm, /^[-*+]\s+\[[ xX]\]\s+/, () => "- [ ] ", { stripOtherListMarkers: true }),
    },
  ],
  [
    { label: "🔗", title: "Link (Cmd/Ctrl+K)", action: insertLink },
    { label: "🖼", title: "Image", action: insertImage },
    { label: "―", title: "Horizontal rule", action: insertHorizontalRule },
    { label: "▦", title: "Table", action: insertTable },
    { label: "[^]", title: "Footnote", action: insertFootnote },
  ],
];
