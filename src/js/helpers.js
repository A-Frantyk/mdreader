// Small pure string/path helpers shared across the app.

function basename(path) {
  return path.split(/[\\/]/).pop() || path;
}

function extOf(path) {
  // Bug fix: "notes.md?v=2" used to extract "md?v=2", matching neither extension list.
  const name = basename(path).split(/[?#]/)[0];
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function isExternal(href) {
  return href.includes("://") || href.startsWith("mailto:") || href.startsWith("tel:");
}

// Where a position ends up after `text` is typed at `start` — handles multi-line
// `text` correctly, unlike adding `text.length` to `start.ch` directly.
function posAfterText(start, text) {
  const lines = text.split("\n");
  if (lines.length === 1) return { line: start.line, ch: start.ch + text.length };
  return { line: start.line + lines.length - 1, ch: lines[lines.length - 1].length };
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
