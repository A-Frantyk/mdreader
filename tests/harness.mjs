// Loads the real src/app.js into a jsdom window without changing a byte of
// it, so the test suites exercise the actual production file rather than a
// copy or a refactored/exported variant. app.js is a classic script with no
// exports (see CLAUDE.md's module-structure note) — every top-level
// `function` declaration lands on `window` for free, but top-level
// `const`/`let` bindings (state, els, EDITOR_SHORTCUTS, ...) do not, so an
// epilogue appended to the *same* script text exposes exactly the ones the
// suites need, by reference, onto `window.__testExports`.
//
// The only thing ever removed from the source is the trailing bare
// `init();` call — everything else, including every function body, runs
// unmodified. Removing it is what keeps a fresh jsdom window from firing
// the whole Tauri IPC bootstrap (markdown_extensions, drainAndOpen, three
// event.listen calls, mark_frontend_ready, wireDragDrop) on every test.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

const RAW_INDEX_HTML = readFileSync(path.join(REPO_ROOT, "src/index.html"), "utf8");
// The real <script src="app.js"> tag would make jsdom try to fetch a local
// file over its resource loader; instead we inject the (lightly modified)
// source ourselves as an inline <script> below.
const INDEX_HTML = RAW_INDEX_HTML.replace(/<script src="app\.js"><\/script>\s*/, "");

const APP_JS_SOURCE = readFileSync(path.join(REPO_ROOT, "src/app.js"), "utf8");

const TRAILING_INIT_CALL = /\ninit\(\);\s*$/;
if (!TRAILING_INIT_CALL.test(APP_JS_SOURCE)) {
  throw new Error(
    "harness.mjs: src/app.js no longer ends with a bare `init();` call on its own line — " +
      "update TRAILING_INIT_CALL (and re-check that stripping it still prevents the IPC " +
      "bootstrap from running) before trusting this harness again."
  );
}
const APP_JS_BODY = APP_JS_SOURCE.replace(TRAILING_INIT_CALL, "\n");

// Everything app.js declares with `const`/`let` at the top level that a
// suite needs to read or seed. Exposed as live getters/setters (not a
// one-time copy) for the primitive `let`s that app.js's own functions
// reassign during a test (markdownExtensions, modalOpen, quitting,
// newDocInFlight) — a plain property copy here would go stale the moment
// internal code did `markdownExtensions = new Set(...)`.
const EPILOGUE = `
window.__testExports = {
  els, state, inFlight, find, darkQuery,
  get markdownExtensions() { return markdownExtensions; },
  set markdownExtensions(v) { markdownExtensions = v; },
  THEME_KEY, THEME_ICON, SPLIT_RATIO_KEY, SPLIT_RATIO_DEFAULT, SPLIT_MIN_PANE_PX, PREVIEW_DEBOUNCE_MS,
  BLOCKED_OPEN_EXTENSIONS, LIST_PREFIX_RE, EDITOR_SHORTCUTS, TOOLBAR_GROUPS,
  get modalOpen() { return modalOpen; },
  set modalOpen(v) { modalOpen = v; },
  get quitting() { return quitting; },
  get newDocInFlight() { return newDocInFlight; },
};
`;

// A condensed CSS.escape polyfill (CSSOM spec algorithm) — jsdom doesn't
// implement CSS.escape itself, and app.js's TOC/click-routing/find code
// uses it to build an #id selector from a (possibly non-CSS-safe) heading
// slug or find-in-page anchor.
function cssEscape(value) {
  const string = String(value);
  const length = string.length;
  const firstCodeUnit = string.charCodeAt(0);
  let result = "";
  for (let index = 0; index < length; index++) {
    const codeUnit = string.charCodeAt(index);
    if (codeUnit === 0) {
      result += "�";
      continue;
    }
    if (
      (codeUnit >= 0x0001 && codeUnit <= 0x001f) ||
      codeUnit === 0x007f ||
      (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (index === 1 && codeUnit >= 0x0030 && codeUnit <= 0x0039 && firstCodeUnit === 0x002d)
    ) {
      result += `\\${codeUnit.toString(16)} `;
      continue;
    }
    if (index === 0 && length === 1 && codeUnit === 0x002d) {
      result += `\\${string.charAt(index)}`;
      continue;
    }
    if (
      codeUnit >= 0x0080 ||
      codeUnit === 0x002d ||
      codeUnit === 0x005f ||
      (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (codeUnit >= 0x0041 && codeUnit <= 0x005a) ||
      (codeUnit >= 0x0061 && codeUnit <= 0x007a)
    ) {
      result += string.charAt(index);
      continue;
    }
    result += `\\${string.charAt(index)}`;
  }
  return result;
}

function defaultTauriStub() {
  return {
    core: {
      invoke: async () => undefined,
      convertFileSrc: (p) => `asset://localhost/${p}`,
    },
    dialog: {
      open: async () => null,
      ask: async () => false,
      save: async () => null,
      message: async () => undefined,
    },
    event: {
      listen: async () => () => {},
    },
    opener: {
      openUrl: async () => undefined,
      openPath: async () => undefined,
    },
    webview: {
      getCurrentWebview: () => ({
        onDragDropEvent: async () => () => {},
      }),
    },
  };
}

/// Builds one fresh window + evaluates app.js into it. Every test that
/// touches module-level state (state.tabs, find.currentIndex, the loader
/// memos, localStorage, ...) must call this itself rather than share a
/// window with another test — nothing in app.js resets that state on its
/// own, by design (see CLAUDE.md's tab-lifetime notes).
export function freshApp() {
  const dom = new JSDOM(INDEX_HTML, { url: "http://localhost/", runScripts: "dangerously" });
  const { window } = dom;

  // --- stubs for browser APIs jsdom doesn't implement, installed BEFORE
  // app.js evaluates (its top-level code reads matchMedia and builds
  // `els` synchronously at eval time). ---
  window.CSS = window.CSS || {};
  window.CSS.escape = cssEscape;

  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  });

  window.IntersectionObserver = class {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);

  // jsdom does no layout, so this is never meaningfully exercised (see
  // attachSplitterDrag's early-return on a zero-width rect) — stubbed only
  // so code paths that *call* it (find, TOC, anchor clicks) don't throw.
  window.Element.prototype.scrollIntoView = function () {};

  // Minimal enough for editorKeyName's mac-detection check
  // (`CM.keyMap.default === CM.keyMap.macDefault`) — tests flip
  // `window.CodeMirror.keyMap.default` to one or the other sentinel.
  window.CodeMirror = {
    keyMap: { default: {}, macDefault: {} },
  };

  const tauri = defaultTauriStub();
  window.__TAURI__ = tauri;

  const script = window.document.createElement("script");
  script.textContent = `${APP_JS_BODY}\n${EPILOGUE}`;
  window.document.body.appendChild(script);

  return { window, document: window.document, tauri, app: window.__testExports };
}

// --- fakeCm: a minimal but real line-buffer CodeMirror 5 stand-in -------
//
// Implements exactly the methods the editor-command functions call
// (getCursor/getRange/getLine/getValue/lastLine/replaceRange/setSelection/
// setCursor/operation/focus), including CodeMirror's own clamping
// behavior: getRange silently clamps an out-of-bounds `ch` to the line's
// actual length rather than throwing. wrapSelection's "markers sit just
// outside the selection" branch depends on exactly that (see its comment
// in app.js) — a fake that throws on an out-of-range probe would make
// that branch untestable, not just untested.

function clampPos(lines, pos) {
  const line = Math.min(Math.max(pos.line, 0), lines.length - 1);
  const ch = Math.min(Math.max(pos.ch, 0), lines[line].length);
  return { line, ch };
}

function comparePos(a, b) {
  return a.line !== b.line ? a.line - b.line : a.ch - b.ch;
}

export function fakeCm(initialText = "") {
  let lines = initialText.split("\n");
  let sel = { from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } };
  let operationCalls = 0;
  let focusCalls = 0;

  return {
    getValue() {
      return lines.join("\n");
    },
    setValue(text) {
      lines = text.split("\n");
      sel = { from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } };
    },
    getCursor(which) {
      if (which === "from") return { ...sel.from };
      return { ...sel.to }; // "to", or no argument (head) — this fake has no separate anchor/head
    },
    getLine(n) {
      return lines[n] ?? "";
    },
    lastLine() {
      return lines.length - 1;
    },
    getRange(start, end) {
      const a = clampPos(lines, start);
      const b = clampPos(lines, end);
      const [from, to] = comparePos(a, b) <= 0 ? [a, b] : [b, a];
      if (from.line === to.line) return lines[from.line].slice(from.ch, to.ch);
      const parts = [lines[from.line].slice(from.ch)];
      for (let l = from.line + 1; l < to.line; l++) parts.push(lines[l]);
      parts.push(lines[to.line].slice(0, to.ch));
      return parts.join("\n");
    },
    replaceRange(text, from, to = from) {
      const a = clampPos(lines, from);
      const b = clampPos(lines, to);
      const before = lines[a.line].slice(0, a.ch);
      const after = lines[b.line].slice(b.ch);
      const inserted = text.split("\n");
      inserted[0] = before + inserted[0];
      inserted[inserted.length - 1] += after;
      lines.splice(a.line, b.line - a.line + 1, ...inserted);
    },
    setSelection(anchor, head = anchor) {
      const [from, to] = comparePos(anchor, head) <= 0 ? [anchor, head] : [head, anchor];
      sel = { from: { ...from }, to: { ...to } };
    },
    setCursor(pos) {
      sel = { from: { ...pos }, to: { ...pos } };
    },
    operation(fn) {
      operationCalls++;
      fn();
    },
    focus() {
      focusCalls++;
    },
    get operationCalls() {
      return operationCalls;
    },
    get focusCalls() {
      return focusCalls;
    },
  };
}
