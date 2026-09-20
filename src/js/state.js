// App-wide mutable state: open tabs, in-flight loads, and the tab-object shape.

const state = {
  tabs: [],
  activeIndex: -1,
};

const inFlight = new Set(); // paths currently being opened, for openPaths' dedupe
const find = { currentIndex: -1 };

// Fetched once from tauri.conf.json via the `markdown_extensions` command.
let markdownExtensions = new Set();

// The one place a tab's full field shape is declared. Deliberately does NOT push
// onto state.tabs — callers differ on timing (loadTab waits for its invoke to settle
// so a failed open never leaves a half-built tab; newDocument pushes immediately).
function createTabShell(overrides) {
  const paneEl = document.createElement("div");
  paneEl.className = "tab-pane";

  const previewEl = document.createElement("div");
  previewEl.className = "preview-scroll";

  const contentEl = document.createElement("article");
  contentEl.className = "content";
  previewEl.appendChild(contentEl);
  paneEl.appendChild(previewEl);
  els.contentWrap.appendChild(paneEl);

  return {
    kind: "document",
    path: null,
    title: "",
    headings: [],
    hasMermaid: false,
    hasMath: false,
    rendered: false,
    paneEl,
    previewEl,
    contentEl,
    mode: "view",
    source: null,
    savedSource: null,
    dirty: false,
    editor: null,
    editorEl: null,
    splitterEl: null,
    previewTimer: null,
    previewSeq: 0,
    previewInFlight: false,
    previewStale: false,
    // Set when a mermaid/KaTeX pass is skipped because the tab was backgrounded — see runPreview.
    previewNeedsEnrich: false,
    closeConfirmPending: false,
    // Guards saveTab against a second concurrent save (menu Save + Cmd/Ctrl+S same tick).
    saving: false,
    ...overrides,
  };
}
