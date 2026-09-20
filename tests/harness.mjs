// Loads the real src/js/*.js scripts into a jsdom window unmodified, so tests exercise
// the actual production files. Top-level `function`s land on `window` for free (classic
// scripts, one global scope — see CLAUDE.md); top-level `const`/`let` don't, so an
// epilogue exposes the ones tests need onto `window.__testExports`. Script list and
// order come from src/index.html's own <script> tags, not a hardcoded list. The only
// thing ever stripped from the concatenated source is the trailing `init();` call —
// removing it is what keeps a fresh jsdom window from firing the Tauri IPC bootstrap.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

const RAW_INDEX_HTML = readFileSync(path.join(REPO_ROOT, "src/index.html"), "utf8");

// jsdom's resource loader would try to fetch these as local files — stripped and
// concatenated in as one inline <script> below instead.
const SCRIPT_TAG_RE = /<script src="([^"]+)"><\/script>\s*/g;
const scriptSrcs = [...RAW_INDEX_HTML.matchAll(SCRIPT_TAG_RE)].map((m) => m[1]);
const INDEX_HTML = RAW_INDEX_HTML.replace(SCRIPT_TAG_RE, "");

const APP_JS_SOURCE = scriptSrcs
  .map((src) => readFileSync(path.join(REPO_ROOT, "src", src), "utf8"))
  .join("\n");

const TRAILING_INIT_CALL = /\ninit\(\);\s*$/;
if (!TRAILING_INIT_CALL.test(APP_JS_SOURCE)) {
  throw new Error(
    "harness.mjs: the last <script> in src/index.html no longer ends with a bare `init();` " +
      "call on its own line — update TRAILING_INIT_CALL (and re-check that stripping it still " +
      "prevents the IPC bootstrap from running) before trusting this harness again."
  );
}
const APP_JS_BODY = APP_JS_SOURCE.replace(TRAILING_INIT_CALL, "\n");

// Top-level const/let a suite needs to read or seed. Exposed as getters (setters where
// a test also needs to seed the value) for the primitive `let`s the frontend reassigns
// during a test — a plain property copy would go stale the moment internal code did
// `markdownExtensions = new Set(...)`.
const EPILOGUE = `
window.__testExports = {
  els, state, inFlight, find, darkQuery,
  get markdownExtensions() { return markdownExtensions; },
  set markdownExtensions(v) { markdownExtensions = v; },
  THEME_KEY, THEME_ICON, SPLIT_RATIO_KEY, SPLIT_RATIO_DEFAULT, SPLIT_MIN_PANE_PX, PREVIEW_DEBOUNCE_MS,
  BLOCKED_OPEN_EXTENSIONS, LIST_PREFIX_RE, EDITOR_SHORTCUTS, TOOLBAR_GROUPS, MARKDOWN_TOKEN_TYPES,
  ZOOM_KEY, ZOOM_DEFAULT, ZOOM_STEPS,
  get modalOpen() { return modalOpen; },
  set modalOpen(v) { modalOpen = v; },
  get aboutOpen() { return aboutOpen; },
  set aboutOpen(v) { aboutOpen = v; },
  get quitting() { return quitting; },
  get newDocInFlight() { return newDocInFlight; },
};
`;

// jsdom doesn't implement CSS.escape (CSSOM spec algorithm) itself.
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
    app: {
      getVersion: async () => "0.0.0-test",
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

// Every test touching module-level state must call this itself rather than share a
// window — nothing in the frontend resets that state on its own.
export function freshApp() {
  const dom = new JSDOM(INDEX_HTML, { url: "http://localhost/", runScripts: "dangerously" });
  const { window } = dom;

  // Stubs for browser APIs jsdom doesn't implement, installed BEFORE the frontend's
  // scripts evaluate — top-level code reads some of these synchronously at eval time.
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

  // jsdom does no layout — stubbed only so callers (find, TOC, anchor clicks) don't throw.
  window.Element.prototype.scrollIntoView = function () {};

  // Minimal enough for editorKeyName's mac-detection check — tests flip
  // window.CodeMirror.keyMap.default to one sentinel or the other.
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

// A minimal but real line-buffer CodeMirror 5 stand-in — replicates getRange's
// clamping of an out-of-bounds `ch` rather than throwing, since wrapSelection's
// "markers sit just outside the selection" branch depends on exactly that.

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
