// CodeMirror editing commands behind the formatting toolbar and its keyboard shortcuts.

// Wrap or, on a second call, unwrap the selection in `marker` (must be symmetric,
// e.g. "**"). Toggle-aware: checks both "selection includes the markers" and
// "markers sit just outside the selection" before falling through to wrap.
function wrapSelection(cm, marker) {
  const from = cm.getCursor("from");
  const to = cm.getCursor("to");
  const selected = cm.getRange(from, to);
  const mlen = marker.length;

  if (selected.length >= mlen * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
    const inner = selected.slice(mlen, selected.length - mlen);
    cm.replaceRange(inner, from, to);
    // replaceRange collapses to a cursor on its own — reselect so a second click toggles back.
    cm.setSelection(from, posAfterText(from, inner));
    cm.focus();
    return;
  }

  // Math.max(0, ...) keeps the "before" probe in range near a line boundary; getRange
  // clamps an out-of-bounds "after" ch, so a short line fails to match rather than throwing.
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

  // posAfterText, not a flat `to.ch + mlen` — correct even when `selected` spans lines.
  cm.replaceRange(marker + selected + marker, from, to);
  const innerStart = posAfterText(from, marker);
  if (selected.length === 0) {
    cm.setCursor(innerStart);
  } else {
    cm.setSelection(innerStart, posAfterText(innerStart, selected));
  }
  cm.focus();
}

// Wrapped in cm.operation so a multi-line toggle is one undo step, not one per line.
// stripOtherListMarkers: bullet/numbered/task are mutually exclusive per line — Blockquote
// doesn't pass this, since "> - item" is a valid list inside a blockquote.
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
          // Bug fix: n used to advance for every touched line, skewing numbers on a
          // partially-numbered selection (two lines both ending up "2.").
          n++;
        }
      }
    }
  });
  cm.focus();
}

// Selection's first line only — a heading is inherently single-line.
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

// withSelection/withoutSelection return { text, selStart, selEnd } — offsets into
// `text` for the sub-range to select after insertion.
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

// Blank lines around `---` are load-bearing: CommonMark's setext-heading syntax turns
// an unpadded `---` into an H2 underline for the preceding paragraph, not a rule.
function insertHorizontalRule(cm) {
  const from = cm.getCursor("from");
  const to = cm.getCursor("to");
  cm.replaceRange("\n\n---\n\n", from, to);
  cm.focus();
}

// Same blank-line reasoning as insertHorizontalRule. Cursor lands at "Header 1" to type over it.
function insertTable(cm) {
  const from = cm.getCursor("from");
  const to = cm.getCursor("to");
  const prefix = "\n\n| ";
  const table = `${prefix}Header 1 | Header 2 |\n| --- | --- |\n| Cell 1 | Cell 2 |\n\n`;
  cm.replaceRange(table, from, to);
  cm.setCursor(posAfterText(from, prefix));
  cm.focus();
}

// `n` is scanned from [^n]: *definition* lines only, not references (which can reuse
// a number). lastLine()/getLine() are read after the reference insert, inside the
// same operation, so they reflect current state, not a stale snapshot.
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

// No "Mod-" alias exists for extraKeys — see CLAUDE.md's extraKeys invariant (shipped bug).
function editorKeyName(key, shift = false) {
  const CM = window.CodeMirror;
  const mac = CM.keyMap.default === CM.keyMap.macDefault;
  return `${shift ? "Shift-" : ""}${mac ? "Cmd-" : "Ctrl-"}${key}`;
}

// No underline binding — see CLAUDE.md's toolbar invariant.
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
