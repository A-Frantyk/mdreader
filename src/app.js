// mdreader frontend. No framework, no bundler — this file plus index.html
// and styles.css is the entire UI. Markdown -> HTML, and all path
// resolution for relative images/links, happens in Rust (see
// src-tauri/src/render.rs); this file wires up tabs, TOC, find, and
// lazy-loads mermaid/KaTeX only for documents that need them.
//
// `withGlobalTauri` injects window.__TAURI__ as an initialization script
// that runs before any document script, so it's read synchronously below
// — there is nothing to poll or wait for.
const tauri = window.__TAURI__;

const els = {
  tabbar: document.getElementById("tabbar"),
  sidebar: document.getElementById("sidebar"),
  toc: document.getElementById("toc"),
  contentWrap: document.getElementById("content-wrap"),
  emptyState: document.getElementById("empty-state"),
  findbar: document.getElementById("findbar"),
  findInput: document.getElementById("find-input"),
  findCount: document.getElementById("find-count"),
  findPrev: document.getElementById("find-prev"),
  findNext: document.getElementById("find-next"),
  findClose: document.getElementById("find-close"),
  dropOverlay: document.getElementById("drop-overlay"),
  openFileBtn: document.getElementById("open-file-btn"),
  openFileBtnMain: document.getElementById("open-file-btn-main"),
  themeBtn: document.getElementById("theme-btn"),
  editToggleBtn: document.getElementById("edit-toggle-btn"),
  saveBtn: document.getElementById("save-btn"),
  codeThemeLink: document.getElementById("code-theme"),
};

const state = {
  // { path, title, headings, hasMermaid, hasMath, rendered, paneEl,
  //   previewEl, contentEl, mode, source, savedSource, dirty, editor,
  //   editorEl, previewTimer }
  // See loadTab (view-mode fields) and enterEditMode (edit-mode fields).
  tabs: [],
  activeIndex: -1,
};

const inFlight = new Set(); // paths currently being opened, for openPaths' dedupe
const find = { currentIndex: -1 };
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

/// Extensions this app is registered to handle (from tauri.conf.json's
/// bundle.fileAssociations via the `markdown_extensions` command) — the
/// one thing a link click needs to decide "open as a document" vs "hand
/// to the OS", fetched once rather than hand-duplicated here.
let markdownExtensions = new Set();

function basename(path) {
  return path.split(/[\\/]/).pop() || path;
}

function extOf(path) {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

// ---------------------------------------------------------------------
// Theme: Light / Dark only — a plain, persisted 2-state toggle. On first
// launch (nothing in localStorage yet), the OS's current preference is
// read once as a starting point and immediately persisted as an explicit
// choice; from then on the app never re-consults the OS, so an OS theme
// flip mid-session doesn't silently relabel anything. See the
// [data-theme] blocks in styles.css and the two code-theme-*.css files
// build.rs generates.
// ---------------------------------------------------------------------
const THEME_KEY = "mdreader.theme";
const THEME_ICON = { light: "☀", dark: "☾" };

function themePreference() {
  let pref = localStorage.getItem(THEME_KEY);
  if (!pref) {
    pref = darkQuery.matches ? "dark" : "light";
    localStorage.setItem(THEME_KEY, pref); // one-time OS-based default, persisted immediately
  }
  return pref;
}

function setCodeThemeLink(theme) {
  els.codeThemeLink.href = theme === "dark" ? "code-theme-dark.css" : "code-theme-light.css";
}

async function applyTheme() {
  const pref = themePreference();
  document.documentElement.dataset.theme = pref;
  setCodeThemeLink(pref);
  // Only exists once edit mode has been entered at least once (see
  // ensureCodeMirror) — a session that never opens the editor never
  // creates this link, so there's nothing to flip.
  if (cmSyntaxThemeLink) {
    cmSyntaxThemeLink.href = pref === "dark" ? "codemirror-theme-dark.css" : "codemirror-theme-light.css";
  }
  els.themeBtn.textContent = THEME_ICON[pref];
  els.themeBtn.title = `Theme: ${pref[0].toUpperCase()}${pref.slice(1)}`;
  await refreshMermaidTheme();
}

async function refreshMermaidTheme() {
  for (const tab of state.tabs) {
    if (tab.rendered && tab.hasMermaid) await renderMermaidFor(tab, { restore: true });
  }
}

function cycleTheme() {
  const next = themePreference() === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme();
}

// ---------------------------------------------------------------------
// Open-file dialog, filtered to the extensions this app is registered
// for (see markdownExtensions below) — feeds the same openPaths() that
// every other way of opening a file goes through.
// ---------------------------------------------------------------------
async function openFileDialog() {
  const selection = await tauri.dialog.open({
    multiple: true,
    filters: [{ name: "Markdown", extensions: [...markdownExtensions] }],
  });
  if (selection) await openPaths(Array.isArray(selection) ? selection : [selection]);
}

// ---------------------------------------------------------------------
// Opening documents
// ---------------------------------------------------------------------

/// Load `path` into a new tab. Its pane is created but not shown —
/// `activateTab` toggles visibility and does the (lazy, one-time)
/// mermaid/KaTeX render once the element actually has layout.
///
/// Structure: paneEl > previewEl(.preview-scroll) > contentEl(article).
/// The editor side (editorEl) is created lazily, only when the tab first
/// enters edit mode — see enterEditMode — so a pure viewing session never
/// touches CodeMirror at all.
async function loadTab(path) {
  const paneEl = document.createElement("div");
  paneEl.className = "tab-pane";

  const previewEl = document.createElement("div");
  previewEl.className = "preview-scroll";

  const contentEl = document.createElement("article");
  contentEl.className = "content";
  previewEl.appendChild(contentEl);
  paneEl.appendChild(previewEl);
  els.contentWrap.appendChild(paneEl);

  const tab = {
    path,
    title: basename(path),
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
  };

  try {
    const res = await tauri.core.invoke("open_markdown_file", { path });
    tab.path = res.path;
    tab.title = basename(res.path); // always the file name, not the doc's H1
    tab.headings = res.doc.headings;
    tab.hasMermaid = res.doc.has_mermaid;
    tab.hasMath = res.doc.has_math;
    contentEl.innerHTML = res.doc.html;
    rewriteImageSources(contentEl);
  } catch (err) {
    const div = document.createElement("div");
    div.className = "render-error";
    div.textContent = `Couldn't open ${path}:\n${err}`;
    contentEl.replaceChildren(div);
  }

  state.tabs.push(tab);
}

/// Single entry point for every way a document can be opened — cold-start
/// argv/RunEvent::Opened (via the pending queue), an already-running
/// instance receiving a forwarded path, a file drop, and a same-document
/// link click. Sequences loads (no torn state from concurrent opens of
/// the same path) and dedupes against both open tabs and in-flight loads,
/// then activates once at the end.
async function openPaths(paths) {
  let lastTouched = -1;
  for (const path of paths) {
    const existing = state.tabs.findIndex((t) => t.path === path);
    if (existing !== -1) {
      lastTouched = existing;
      continue;
    }
    if (inFlight.has(path)) continue;
    inFlight.add(path);
    try {
      await loadTab(path);
      lastTouched = state.tabs.length - 1;
    } finally {
      inFlight.delete(path);
    }
  }
  if (lastTouched !== -1) await activateTab(lastTouched);
}

async function drainAndOpen() {
  const pending = await tauri.core.invoke("drain_pending_files");
  if (pending.length) await openPaths(pending);
}

/// Both existing call sites (the tab's × button, Cmd/Ctrl+W) fire this
/// without awaiting it, which is fine — but this function itself now
/// awaits a confirmation dialog when the tab is dirty, which the
/// synchronous version never did. That await is why `index` gets
/// re-resolved below before acting on it.
async function closeTab(index) {
  const tab = state.tabs[index];
  if (!tab) return;

  if (tab.dirty) {
    if (tab.closeConfirmPending) return; // already asking about this tab
    tab.closeConfirmPending = true;
    let discard;
    try {
      discard = await tauri.dialog.confirm(`"${tab.title}" has unsaved changes. Discard them?`, {
        title: "Unsaved changes",
        kind: "warning",
      });
    } finally {
      tab.closeConfirmPending = false;
    }
    if (!discard) return;

    // While the dialog was open, renderTabBar's per-tab click handlers
    // (which capture a tab's position by closure, not identity) could
    // have closed a different tab, shifting every index after it — or
    // the user could have triggered a second close of this same tab.
    // Re-resolve by identity rather than trusting the stale `index`.
    index = state.tabs.indexOf(tab);
    if (index === -1) return; // already gone
  }

  const [closed] = state.tabs.splice(index, 1);
  if (closed.previewTimer) clearTimeout(closed.previewTimer);
  closed.paneEl.remove();
  // Math.min(index, len - 1) is -1 once the last tab closes, which
  // activateTab treats as "show the empty state" — no separate branch.
  activateTab(Math.min(index, state.tabs.length - 1));
}

// ---------------------------------------------------------------------
// Tab bar / activation
// ---------------------------------------------------------------------
function renderTabBar() {
  els.tabbar.innerHTML = "";
  state.tabs.forEach((tab, i) => {
    const el = document.createElement("div");
    el.className = "tab" + (i === state.activeIndex ? " active" : "");
    el.setAttribute("role", "tab");
    el.title = tab.path;

    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = tab.title;
    el.appendChild(title);

    if (tab.dirty) {
      const dot = document.createElement("span");
      dot.className = "tab-dirty";
      dot.setAttribute("aria-label", "Unsaved changes");
      el.appendChild(dot);
    }

    const close = document.createElement("button");
    close.className = "tab-close";
    close.textContent = "×";
    close.setAttribute("aria-label", `Close ${tab.title}`);
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(i);
    });
    el.appendChild(close);

    el.addEventListener("click", () => activateTab(i));
    els.tabbar.appendChild(el);
  });
}

let tocObserver = null;

async function activateTab(index) {
  state.activeIndex = index;
  renderTabBar();
  closeFind();
  updateDocumentTitle();

  const tab = state.tabs[index];
  els.emptyState.style.display = tab ? "none" : "flex";
  state.tabs.forEach((t, i) => t.paneEl.classList.toggle("visible", i === index));
  els.editToggleBtn.disabled = !tab;
  els.saveBtn.disabled = !tab || !tab.dirty;

  if (!tab) {
    tocObserver?.disconnect();
    els.toc.innerHTML = "";
    els.sidebar.classList.add("hidden");
    return;
  }

  updateToc(tab);

  // First view of this tab, or a debounced live-preview render landed
  // while it was backgrounded and skipped mermaid/KaTeX for the same
  // reason (both need to measure text, which needs real layout — see
  // runPreview): either way it's now safe and due.
  if (!tab.rendered || tab.previewNeedsEnrich) {
    tab.rendered = true;
    tab.previewNeedsEnrich = false;
    await Promise.all([
      tab.hasMermaid ? renderMermaidFor(tab) : null,
      tab.hasMath ? renderMathFor(tab.contentEl) : null,
    ]);
  }

  // CodeMirror lays out against the DOM at creation time; if that
  // happened while this pane was display:none (e.g. edit mode was
  // entered on a background tab — not currently reachable, but cheap
  // to guard), it renders blank until told to re-measure.
  tab.editor?.refresh();
  els.editToggleBtn.classList.toggle("active", tab.mode === "split");
}

function updateToc(tab) {
  tocObserver?.disconnect();
  els.toc.innerHTML = "";
  if (!tab.headings.length) {
    els.sidebar.classList.add("hidden");
    return;
  }
  els.sidebar.classList.remove("hidden");

  const linkById = new Map();
  tab.headings.forEach((h) => {
    const a = document.createElement("a");
    a.href = `#${h.id}`;
    a.className = `level-${h.level}`;
    a.textContent = h.text;
    els.toc.appendChild(a);
    linkById.set(h.id, a);
  });

  // One observer, re-pointed at the active tab's headings on every
  // switch, rather than a fresh one per render — tabs' content elements
  // persist for the app's lifetime, so a per-render observer would never
  // get disconnected and would accumulate one per switch.
  tocObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const link = linkById.get(entry.target.id);
        if (link && entry.isIntersecting) {
          els.toc.querySelectorAll("a.active").forEach((el) => el.classList.remove("active"));
          link.classList.add("active");
        }
      });
    },
    // Root is this tab's own scroll container, not the shared
    // #content-wrap — each tab scrolls independently now that a split
    // pane can exist (see the .preview-scroll comment in styles.css).
    { root: tab.previewEl, rootMargin: "0px 0px -70% 0px", threshold: 0 }
  );
  tab.headings.forEach((h) => {
    const heading = tab.contentEl.querySelector(`#${CSS.escape(h.id)}`);
    if (heading) tocObserver.observe(heading);
  });
}

// ---------------------------------------------------------------------
// Images and links. render.rs already resolved every relative
// image/link destination to an absolute filesystem path and left every
// external URL (scheme, mailto:, tel:) untouched — so classification
// here is just "does this look like an absolute path or a URL", not path
// arithmetic.
// ---------------------------------------------------------------------
function rewriteImageSources(root) {
  root.querySelectorAll("img[src]").forEach((img) => {
    const src = img.getAttribute("src");
    if (!src || src.startsWith("data:") || src.includes("://")) return;
    img.src = tauri.core.convertFileSrc(src);
  });
}

function isExternal(href) {
  return href.includes("://") || href.startsWith("mailto:") || href.startsWith("tel:");
}

// Delegated once on the shared container rather than per-link per-render:
// tabs' content persists, so this fires for every tab without rebinding.
// In-page `#anchor` clicks are handled here too (not left to the browser)
// because every open tab's headings live in the same document at once —
// default fragment navigation can't tell which tab's heading you meant.
els.contentWrap.addEventListener("click", (e) => {
  const a = e.target.closest("a[href]");
  if (!a) return;
  const href = a.getAttribute("href");
  if (!href) return;
  e.preventDefault();

  if (href.startsWith("#")) {
    const tab = state.tabs[state.activeIndex];
    tab?.contentEl.querySelector(`#${CSS.escape(href.slice(1))}`)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
    return;
  }
  if (isExternal(href)) {
    tauri.opener.openUrl(href).catch((err) => console.error("failed to open url", err));
    return;
  }
  if (markdownExtensions.has(extOf(href))) {
    openPaths([href]);
  } else {
    tauri.opener.openPath(href).catch((err) => console.error("failed to open path", err));
  }
});

els.toc.addEventListener("click", (e) => {
  const a = e.target.closest("a[href^='#']");
  if (!a) return;
  e.preventDefault();
  const tab = state.tabs[state.activeIndex];
  tab?.contentEl.querySelector(`#${CSS.escape(a.getAttribute("href").slice(1))}`)?.scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
});

// ---------------------------------------------------------------------
// Lazy-loaded Mermaid + KaTeX. A tab that never opens either never pays
// for them; a plain document never triggers the loaders at all.
// ---------------------------------------------------------------------
let mermaidLoadPromise = null;
let katexLoadPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(script);
  });
}

function mermaidConfig() {
  return { startOnLoad: false, securityLevel: "strict", theme: themePreference() === "dark" ? "dark" : "default" };
}

function ensureMermaid() {
  if (!mermaidLoadPromise) {
    // Null the memo out on failure so a transient error (e.g. the app
    // briefly offline from a network drive) doesn't permanently wedge
    // mermaid rendering for the rest of the session — the next call
    // gets a fresh attempt instead of the same rejected promise forever.
    mermaidLoadPromise = loadScript("vendor/mermaid/mermaid.min.js").catch((err) => {
      mermaidLoadPromise = null;
      throw err;
    });
  }
  return mermaidLoadPromise;
}

/// Renders (or, with `restore: true`, re-renders from pristine source —
/// used on an OS theme flip) every mermaid fence in `tab`. Must only be
/// called while `tab.contentEl` is visible: mermaid measures text via the
/// DOM, which returns nothing useful for a `display: none` subtree.
async function renderMermaidFor(tab, { restore = false } = {}) {
  await ensureMermaid();
  window.mermaid.initialize(mermaidConfig());

  const nodes = Array.from(tab.contentEl.querySelectorAll("pre.mermaid"));
  nodes.forEach((node) => {
    if (restore && node.dataset.source) {
      node.textContent = node.dataset.source;
      node.removeAttribute("data-processed"); // mermaid skips nodes carrying this
    } else if (!node.dataset.source) {
      node.dataset.source = node.textContent;
    }
  });
  if (!nodes.length) return;
  try {
    await window.mermaid.run({ nodes });
  } catch (err) {
    console.error("mermaid render failed", err);
  }
}

function ensureKatex() {
  if (!katexLoadPromise) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "vendor/katex/katex.min.css";
    document.head.appendChild(link);
    katexLoadPromise = loadScript("vendor/katex/katex.min.js")
      .then(() => loadScript("vendor/katex/auto-render.min.js"))
      .catch((err) => {
        katexLoadPromise = null; // see ensureMermaid — don't wedge on a transient failure
        throw err;
      });
  }
  return katexLoadPromise;
}

async function renderMathFor(root) {
  await ensureKatex();
  try {
    window.renderMathInElement(root, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\(", right: "\\)", display: false },
        { left: "\\[", right: "\\]", display: true },
      ],
      throwOnError: false,
    });
  } catch (err) {
    console.error("katex render failed", err);
  }
}

// ---------------------------------------------------------------------
// Edit mode. A tab starts in read-only "view" mode (just the rendered
// article, as before); Cmd/Ctrl+E — or the toolbar button — switches it
// to "split" mode: a CodeMirror source pane alongside the same preview
// article, kept in sync by a debounced re-render through the
// `render_markdown` command. CodeMirror is vendored
// (src/vendor/codemirror/) and loaded lazily via the same
// memoized-promise pattern as Mermaid/KaTeX above, so a pure viewing
// session never fetches it — see ensureCodeMirror.
// ---------------------------------------------------------------------
let codeMirrorLoadPromise = null;

// The generated fence-highlighting theme (build.rs's
// generate_codemirror_theme_css, class `cm-s-mdreader-syntax`) is a
// separate stylesheet from the hand-written `cm-s-mdreader` one in
// styles.css — CodeMirror supports multiple space-separated theme names
// applied simultaneously (see enterSplitMode's `theme:` value), so the
// two own disjoint sets of CSS selectors rather than fighting over one.
// Created lazily inside ensureCodeMirror, not linked statically in
// index.html like code-theme-*.css — a session that never enters edit
// mode shouldn't fetch it. Kept as a module-level reference (like
// els.codeThemeLink) so applyTheme can flip its href on a theme change
// after edit mode has already been entered once.
let cmSyntaxThemeLink = null;

function ensureCodeMirror() {
  if (!codeMirrorLoadPromise) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "vendor/codemirror/lib/codemirror.css";
    document.head.appendChild(link);

    cmSyntaxThemeLink = document.createElement("link");
    cmSyntaxThemeLink.rel = "stylesheet";
    cmSyntaxThemeLink.href =
      themePreference() === "dark" ? "codemirror-theme-dark.css" : "codemirror-theme-light.css";
    document.head.appendChild(cmSyntaxThemeLink);

    codeMirrorLoadPromise = loadScript("vendor/codemirror/lib/codemirror.js")
      .then(() => loadScript("vendor/codemirror/mode/markdown/markdown.js"))
      .then(() => loadScript("vendor/codemirror/mode/gfm/gfm.js"))
      // "gfm" is markdown with a small overlay mode layered on top —
      // CodeMirror.overlayMode is not part of core codemirror.js, it's
      // this addon. Without it, gfm.js's mode factory throws
      // "CodeMirror.overlayMode is not a function" the moment a "gfm"
      // editor is actually constructed (mode resolution happens lazily,
      // at `new CodeMirror(...)` time, not when gfm.js itself loads) —
      // which built the editor's empty DOM shell first, so the visible
      // symptom was a blank editor pane, not an obvious load error.
      .then(() => loadScript("vendor/codemirror/addon/mode/overlay.js"))
      // Fence-language highlighting: markdown.js's fencedCodeBlockHighlighting
      // defaults to true already, but it resolves a fence's language via
      // CodeMirror.findModeByName — defined by meta.js, not core — so
      // without meta.js and the actual per-language modes, fences stay
      // plain monospace no matter what the mode config says. Order below
      // respects each file's own declared dependencies (checked directly
      // against each file's UMD header, not assumed): rust.js needs
      // addon/mode/simple.js loaded first; htmlmixed.js needs xml.js,
      // javascript.js, and css.js loaded first — both satisfied by this
      // sequence.
      .then(() => loadScript("vendor/codemirror/mode/meta.js"))
      .then(() => loadScript("vendor/codemirror/addon/mode/simple.js"))
      .then(() => loadScript("vendor/codemirror/mode/javascript/javascript.js"))
      .then(() => loadScript("vendor/codemirror/mode/python/python.js"))
      .then(() => loadScript("vendor/codemirror/mode/shell/shell.js"))
      .then(() => loadScript("vendor/codemirror/mode/yaml/yaml.js"))
      .then(() => loadScript("vendor/codemirror/mode/xml/xml.js"))
      .then(() => loadScript("vendor/codemirror/mode/css/css.js"))
      .then(() => loadScript("vendor/codemirror/mode/clike/clike.js"))
      .then(() => loadScript("vendor/codemirror/mode/go/go.js"))
      .then(() => loadScript("vendor/codemirror/mode/sql/sql.js"))
      .then(() => loadScript("vendor/codemirror/mode/rust/rust.js"))
      .then(() => loadScript("vendor/codemirror/mode/htmlmixed/htmlmixed.js"))
      .catch((err) => {
        codeMirrorLoadPromise = null; // see ensureMermaid — don't wedge on a transient failure
        throw err;
      });
  }
  return codeMirrorLoadPromise;
}

const PREVIEW_DEBOUNCE_MS = 200;

/// Mark `tab` dirty/clean and, only when the value actually changes,
/// reflect it in the tab bar and the save button — a full renderTabBar()
/// rebuild on every keystroke (dirty is recomputed on every CodeMirror
/// `change` event) would be wasteful once it's already showing the dot.
function markDirty(tab, dirty) {
  if (tab.dirty === dirty) return;
  tab.dirty = dirty;
  renderTabBar();
  if (state.tabs[state.activeIndex] === tab) {
    els.saveBtn.disabled = !dirty;
    updateDocumentTitle();
  }
}

/// document.title is otherwise never touched — Tauri doesn't sync it to
/// the native window title bar on its own — so this is the one place
/// that keeps it in sync with the active tab and its dirty state.
function updateDocumentTitle() {
  const tab = state.tabs[state.activeIndex];
  document.title = tab ? `${tab.dirty ? "● " : ""}${tab.title} — mdreader` : "mdreader";
}

/// Writes the active editor buffer back to disk via the narrow
/// `save_markdown_file` command (see its doc comment in lib.rs for why
/// it's a dedicated command rather than tauri-plugin-fs). On failure the
/// buffer, the dirty flag, and CodeMirror's undo history are all left
/// untouched — a failed save must never look like a successful one.
async function saveTab(tab) {
  if (!tab || !tab.editor || !tab.dirty) return;
  els.saveBtn.disabled = true;
  try {
    const contents = tab.editor.getValue();
    await tauri.core.invoke("save_markdown_file", { path: tab.path, contents });
    tab.savedSource = contents;
    markDirty(tab, false);
  } catch (err) {
    console.error("save failed", err);
    tauri.dialog
      .message(`Couldn't save ${tab.title}:\n${err}`, { title: "Save failed", kind: "error" })
      .catch((dialogErr) => console.error("failed to show save-error dialog", dialogErr));
  } finally {
    if (state.tabs[state.activeIndex] === tab) els.saveBtn.disabled = !tab.dirty;
  }
}

/// Create (once) the CodeMirror instance and editor-pane/splitter DOM for
/// `tab`, fetch its source lazily if this is the first time it's been
/// edited, and switch the tab into split mode. Safe to call on a tab
/// already in split mode.
/// Wrap (or, on a second call, unwrap) the editor's current selection in
/// `marker` — the logic behind the Bold/Italic/Strikethrough toolbar
/// buttons and their keyboard shortcuts. `marker` must be symmetric (same
/// string on both sides, e.g. "**"/"*"/"~~") — every markdown inline
/// style this app exposes is symmetric, so there's no need for a
/// separate open/close-marker code path.
///
/// Toggle-aware like a word processor's Bold button: clicking it again on
/// already-bold text un-bolds rather than double-wrapping. Two ways a
/// selection can "already be bold" — the selection itself includes the
/// markers (user dragged across "**bold**"), or the markers sit just
/// outside the selection (user selected only "bold", markers untouched)
/// — both are checked before falling through to wrap.
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

function wrapSelection(cm, marker) {
  const from = cm.getCursor("from");
  const to = cm.getCursor("to");
  const selected = cm.getRange(from, to);
  const mlen = marker.length;

  // Case 1: the selection itself already includes the markers.
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

  // Case 3: wrap. An empty selection (bare cursor) ends up with the
  // cursor placed between the two markers, ready to type; a real
  // selection is re-selected (not the markers) so a second click on the
  // same text hits case 1 and toggles it back off. Each new position is
  // computed from the previous one via posAfterText, not by adding
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

/// Bold/Italic/Strikethrough — the only inline styles exposed here,
/// deliberately: real CommonMark/GFM syntax this renderer supports.
/// Underline was asked about and dropped — Markdown has no native
/// underline syntax, and the only way to get one (raw `<u>` HTML) isn't
/// "MD syntax," which was the explicit constraint. See CLAUDE.md.
const TOOLBAR_BUTTONS = [
  { marker: "**", label: "B", title: "Bold (Cmd/Ctrl+B)", style: "font-weight:700" },
  { marker: "*", label: "I", title: "Italic (Cmd/Ctrl+I)", style: "font-style:italic" },
  { marker: "~~", label: "S", title: "Strikethrough (Cmd/Ctrl+Shift+X)", style: "text-decoration:line-through" },
];

/// Builds the formatting toolbar for `tab`'s editor pane. Must be called
/// (and its result appended into editorPane) *before* `new CodeMirror(...)`
/// — CodeMirror's constructor appends its own wrapper to whatever's
/// already in the container rather than replacing it (verified against
/// lib/codemirror.js's Display constructor), so toolbar-first in the DOM
/// plus a flex-column .editor-pane is what puts it visually on top.
/// No separate show/hide wiring needed: as a child of editorPane, it's
/// already gated by the same `.tab-pane.split .editor-pane` display rule
/// CodeMirror itself is.
function createEditorToolbar(tab) {
  const bar = document.createElement("div");
  bar.className = "editor-toolbar";
  TOOLBAR_BUTTONS.forEach(({ marker, label, title, style }) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "icon-btn";
    btn.title = title;
    btn.textContent = label;
    btn.style.cssText = style;
    btn.addEventListener("click", () => wrapSelection(tab.editor, marker));
    bar.appendChild(btn);
  });
  return bar;
}

async function enterSplitMode(tab) {
  if (tab.mode === "split") return;

  await ensureCodeMirror();

  if (tab.source === null) {
    // Not part of open_markdown_file's payload — see read_markdown_source
    // in lib.rs for why that's a separate, lazily-fetched call rather
    // than doubling every view-only open's IPC payload with source text
    // nobody reads in view mode.
    tab.source = await tauri.core.invoke("read_markdown_source", { path: tab.path });
    tab.savedSource = tab.source;
  }

  // Flip the pane into split mode *before* creating CodeMirror, not
  // after: .editor-pane defaults to display:none and only becomes
  // display:block once .tab-pane carries the "split" class (see
  // styles.css). Constructing CodeMirror inside a still-hidden container
  // makes it measure a zero-width/zero-height element and cache that —
  // refresh() afterward doesn't reliably recover from it in practice.
  // Doing this first means the editor's very first layout pass sees a
  // real, visible container, with the trailing refresh() below kept only
  // as a defensive re-measure for the "already exists, pane was hidden
  // in between" path.
  tab.mode = "split";
  tab.paneEl.classList.add("split");

  if (!tab.editorEl) {
    const editorPane = document.createElement("div");
    editorPane.className = "editor-pane";
    // Toolbar first — see createEditorToolbar's comment on why DOM order
    // here matters (CodeMirror appends, it doesn't replace).
    const toolbar = createEditorToolbar(tab);
    editorPane.appendChild(toolbar);
    const splitter = document.createElement("div");
    splitter.className = "pane-splitter";
    tab.paneEl.insertBefore(editorPane, tab.previewEl);
    tab.paneEl.insertBefore(splitter, tab.previewEl);

    // If construction throws (e.g. a missing mode dependency — see the
    // overlay.js comment in ensureCodeMirror), don't leave the pane
    // claiming to be in split mode with a half-built, empty editor: undo
    // the DOM and the mode flip before rethrowing, so a failed edit-mode
    // entry visibly fails (toggleEditMode's catch just console.errors —
    // it doesn't know to check DOM state) rather than looking like it
    // succeeded with nothing in it.
    try {
      tab.editor = new window.CodeMirror(editorPane, {
        value: tab.source,
        mode: "gfm",
        // Two theme names, space-separated — CodeMirror applies both
        // simultaneously as separate cm-s-* classes (verified against
        // lib/codemirror.js's theme option handler). "mdreader" (in
        // styles.css) owns chrome: background, base text, gutters,
        // cursor. "mdreader-syntax" (generated by build.rs from the same
        // syntect theme the preview pane uses) owns only code-token
        // colors. Disjoint selector sets, no precedence fights.
        theme: "mdreader mdreader-syntax",
        lineWrapping: true,
        lineNumbers: true,
        // "Mod-" is CodeMirror's own cross-platform modifier alias
        // (verified against lib/codemirror.js's keymap normalization —
        // Cmd on macOS, Ctrl on Windows/Linux from one binding). These
        // only fire while the editor itself has focus, unlike the app's
        // global keydown handler, so they can't collide with Cmd/Ctrl+F
        // or +W firing from the find input or elsewhere.
        extraKeys: {
          "Mod-B": (instance) => wrapSelection(instance, "**"),
          "Mod-I": (instance) => wrapSelection(instance, "*"),
          "Mod-Shift-X": (instance) => wrapSelection(instance, "~~"),
        },
      });
    } catch (err) {
      toolbar.remove();
      editorPane.remove();
      splitter.remove();
      tab.mode = "view";
      tab.paneEl.classList.remove("split");
      throw err;
    }
    tab.editorEl = editorPane;

    tab.editor.on("change", () => {
      markDirty(tab, tab.editor.getValue() !== tab.savedSource);
      schedulePreview(tab);
    });
  }

  tab.editor.refresh();
  if (state.tabs[state.activeIndex] === tab) els.editToggleBtn.classList.add("active");
}

function exitSplitMode(tab) {
  if (tab.mode !== "split") return;
  tab.mode = "view";
  tab.paneEl.classList.remove("split");
  if (state.tabs[state.activeIndex] === tab) els.editToggleBtn.classList.remove("active");
}

async function toggleEditMode() {
  const tab = state.tabs[state.activeIndex];
  if (!tab) return;
  if (tab.mode === "split") {
    exitSplitMode(tab);
    return;
  }
  els.editToggleBtn.disabled = true;
  try {
    await enterSplitMode(tab);
  } catch (err) {
    console.error("failed to enter edit mode", err);
  } finally {
    els.editToggleBtn.disabled = false;
  }
}

/// Debounced re-render of `tab`'s preview from its live editor buffer.
function schedulePreview(tab) {
  clearTimeout(tab.previewTimer);
  tab.previewTimer = setTimeout(() => runPreview(tab), PREVIEW_DEBOUNCE_MS);
}

/// Re-renders `tab`'s preview from the editor's current value. At most
/// one `render_markdown` call in flight per tab — a change that lands
/// mid-render doesn't queue a second invoke, it sets `previewStale` and
/// this re-fires itself once the in-flight one resolves. A `previewSeq`
/// counter guards against applying a response that's been superseded by
/// a newer one that happened to resolve first (async commands can
/// complete out of order).
async function runPreview(tab) {
  if (tab.previewInFlight) {
    tab.previewStale = true;
    return;
  }
  tab.previewInFlight = true;
  tab.previewStale = false;
  const seq = ++tab.previewSeq;

  try {
    const source = tab.editor.getValue();
    const doc = await tauri.core.invoke("render_markdown", { source, basePath: tab.path });
    if (seq !== tab.previewSeq) return; // superseded by a later edit

    tab.headings = doc.headings;
    tab.hasMermaid = doc.has_mermaid;
    tab.hasMath = doc.has_math;
    tab.contentEl.innerHTML = doc.html;
    rewriteImageSources(tab.contentEl);

    const isActive = state.tabs[state.activeIndex] === tab;
    if (isActive) updateToc(tab);

    // Mermaid/KaTeX measure text via the DOM and must not run against a
    // hidden subtree — the same rule the original "render exactly once,
    // on first visibility" invariant exists for, just re-checked on
    // every settle instead of once. If the tab isn't visible right now,
    // skip and let activateTab's previewNeedsEnrich check catch it on
    // the next activation instead of running against display:none.
    if (isActive) {
      if (tab.hasMermaid) await renderMermaidFor(tab);
      if (tab.hasMath) await renderMathFor(tab.contentEl);
      tab.previewNeedsEnrich = false;
    } else {
      tab.previewNeedsEnrich = tab.hasMermaid || tab.hasMath;
    }
  } catch (err) {
    console.error("preview render failed", err);
  } finally {
    tab.previewInFlight = false;
    if (tab.previewStale) schedulePreview(tab);
  }
}

// ---------------------------------------------------------------------
// In-page find (Ctrl/Cmd+F). The webview doesn't expose a scriptable
// native find, so this walks the active tab's text nodes and wraps
// matches in <mark>.
// ---------------------------------------------------------------------
function activeRoot() {
  return state.tabs[state.activeIndex]?.contentEl ?? null;
}

function openFind() {
  const root = activeRoot();
  if (!root) return;
  els.findbar.classList.add("visible");
  els.findInput.focus();
  els.findInput.select();
  if (els.findInput.value) runFind(els.findInput.value);
}

function closeFind() {
  els.findbar.classList.remove("visible");
  const root = activeRoot();
  if (root) clearMarks(root);
  find.currentIndex = -1;
  els.findCount.textContent = "";
}

function clearMarks(root) {
  const marks = root.querySelectorAll("mark.find-hit");
  const parents = new Set();
  marks.forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parents.add(parent);
  });
  // normalize() walks its whole subtree — once per unique parent instead
  // of once per mark, so clearing 500 hits under one container is O(1)
  // subtree walks, not O(500).
  parents.forEach((p) => p.normalize());
}

function runFind(query) {
  const root = activeRoot();
  if (!root) return;
  clearMarks(root);
  find.currentIndex = -1;
  if (!query) {
    els.findCount.textContent = "";
    return;
  }

  const needle = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(needle)) {
        return NodeFilter.FILTER_SKIP;
      }
      const tag = node.parentElement?.tagName;
      return tag === "SCRIPT" || tag === "STYLE" ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNodes = [];
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);

  textNodes.forEach((node) => {
    const text = node.nodeValue;
    const lower = text.toLowerCase();
    let start = 0;
    let idx;
    const frag = document.createDocumentFragment();
    while ((idx = lower.indexOf(needle, start)) !== -1) {
      if (idx > start) frag.appendChild(document.createTextNode(text.slice(start, idx)));
      const mark = document.createElement("mark");
      mark.className = "find-hit";
      mark.textContent = text.slice(idx, idx + needle.length);
      frag.appendChild(mark);
      start = idx + needle.length;
    }
    if (start < text.length) frag.appendChild(document.createTextNode(text.slice(start)));
    node.parentNode.replaceChild(frag, node);
  });

  if (root.querySelector("mark.find-hit")) {
    find.currentIndex = 0;
    highlightCurrentMark(root, { smooth: false });
  } else {
    els.findCount.textContent = "0/0";
  }
}

function highlightCurrentMark(root, { smooth = true } = {}) {
  const marks = root.querySelectorAll("mark.find-hit");
  marks.forEach((m) => m.classList.remove("current"));
  const mark = marks[find.currentIndex];
  if (!mark) return;
  mark.classList.add("current");
  mark.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
  els.findCount.textContent = `${find.currentIndex + 1}/${marks.length}`;
}

function stepMatch(delta) {
  const root = activeRoot();
  if (!root) return;
  const count = root.querySelectorAll("mark.find-hit").length;
  if (!count) return;
  find.currentIndex = (find.currentIndex + delta + count) % count;
  highlightCurrentMark(root);
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ---------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------
function wireStaticUI() {
  els.findInput.addEventListener("input", debounce((e) => runFind(e.target.value), 120));
  els.findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      stepMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFind();
    }
  });
  els.findPrev.addEventListener("click", () => stepMatch(-1));
  els.findNext.addEventListener("click", () => stepMatch(1));
  els.findClose.addEventListener("click", closeFind);

  document.addEventListener("keydown", (e) => {
    if (e.isComposing) return; // IME composition — not a real shortcut keystroke
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "f") {
      e.preventDefault();
      openFind();
    } else if (mod && e.key.toLowerCase() === "w" && state.activeIndex !== -1) {
      e.preventDefault();
      closeTab(state.activeIndex);
    } else if (mod && e.key.toLowerCase() === "e" && state.activeIndex !== -1) {
      e.preventDefault();
      toggleEditMode();
    } else if (mod && e.key.toLowerCase() === "s" && state.activeIndex !== -1) {
      e.preventDefault();
      saveTab(state.tabs[state.activeIndex]);
    }
  });

  els.editToggleBtn.addEventListener("click", toggleEditMode);
  els.saveBtn.addEventListener("click", () => saveTab(state.tabs[state.activeIndex]));
}

async function wireDragDrop() {
  const webview = tauri.webview.getCurrentWebview();
  await webview.onDragDropEvent((event) => {
    const type = event.payload.type;
    if (type === "over" || type === "enter") {
      els.dropOverlay.classList.add("visible");
    } else if (type === "leave") {
      els.dropOverlay.classList.remove("visible");
    } else if (type === "drop") {
      els.dropOverlay.classList.remove("visible");
      openPaths(event.payload.paths || []);
    }
  });
}

async function init() {
  await applyTheme(); // as early as possible, before anything else paints
  wireStaticUI();

  els.openFileBtn.addEventListener("click", openFileDialog);
  els.openFileBtnMain.addEventListener("click", openFileDialog);
  els.themeBtn.addEventListener("click", cycleTheme);

  markdownExtensions = new Set(await tauri.core.invoke("markdown_extensions"));

  // Entry paths 1 & 2 (Windows/Linux argv, macOS RunEvent::Opened) may
  // have queued files before this ran. Entry path 3 (already-running
  // instance) arrives as a later "files-pending" hint — the queue is the
  // payload, the event is just a nudge to go drain it again.
  await drainAndOpen();
  await tauri.event.listen("files-pending", () => drainAndOpen());

  try {
    await wireDragDrop();
  } catch (err) {
    console.error("drag-drop wiring failed", err);
  }
}

init();
