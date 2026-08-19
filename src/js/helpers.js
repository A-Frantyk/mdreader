// Small pure string/path helpers shared across the app.

function basename(path) {
  return path.split(/[\\/]/).pop() || path;
}

function extOf(path) {
  // Strip a query string or fragment before looking for the extension —
  // without this, a link like "notes.md?v=2" extracts "md?v=2" as its
  // extension, matches nothing in markdownExtensions/BLOCKED_OPEN_EXTENSIONS,
  // and falls through to the wrong click-routing branch.
  const name = basename(path).split(/[?#]/)[0];
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function isExternal(href) {
  return href.includes("://") || href.startsWith("mailto:") || href.startsWith("tel:");
}

/// Where a position ends up after `text` (which may itself contain
/// newlines — a multi-line selection stays multi-line when re-inserted)
/// is typed starting at `start`. Threading every reselection through this
/// — rather than adding `text.length` to `start.ch` directly — is what
/// keeps the post-wrap/unwrap selection correct for a selection spanning
/// more than one line, not just the common single-line case.
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
