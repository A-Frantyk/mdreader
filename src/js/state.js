// App-wide mutable state: open tabs, in-flight loads, and the tab-object shape.

const state = {
  tabs: [],
  activeIndex: -1,
};

const inFlight = new Set(); // paths currently being opened, for openPaths' dedupe
const find = { currentIndex: -1 };

/// Extensions this app is registered to handle, fetched once from
/// tauri.conf.json via the `markdown_extensions` command rather than
/// hand-duplicated here.
let markdownExtensions = new Set();

/// Builds a tab's persistent DOM (paneEl > previewEl(.preview-scroll) >
/// contentEl(article)), appends it to #content-wrap, and returns the
/// fully-enumerated tab object — the one place this shape is declared, so
/// every field a tab can ever carry is listed here even though most start
/// empty/null. The editor side (editorEl) is created lazily, only when the
/// tab first enters edit mode — see enterSplitMode — so a pure viewing
/// session never touches CodeMirror at all.
///
/// Deliberately does NOT push onto state.tabs — callers differ on when
/// that should happen. `loadTab` pushes only after its `open_markdown_file`
/// invoke settles, so a failed open still leaves a tab (showing the error)
/// but never a *half*-built one sitting in state.tabs mid-invoke.
/// `newDocument` has no invoke to wait on, so it pushes immediately.
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
    // Set when a debounced preview render's mermaid/KaTeX pass is
    // skipped because the tab was backgrounded mid-edit (see
    // runPreview) — activateTab checks this alongside `rendered` so a
    // diagram doesn't come back stale raw-source when the tab is
    // revisited.
    previewNeedsEnrich: false,
    closeConfirmPending: false,
    // Guards saveTab against a second concurrent save (e.g. a menu Save
    // and a Cmd/Ctrl+S landing in the same tick) — see saveTab.
    saving: false,
    ...overrides,
  };
}
