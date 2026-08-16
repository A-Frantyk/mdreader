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
  openFileBtnMain: document.getElementById("open-file-btn-main"),
  themeBtn: document.getElementById("theme-btn"),
  editToggleBtn: document.getElementById("edit-toggle-btn"),
  saveBtn: document.getElementById("save-btn"),
  newTabBtn: document.getElementById("new-tab-btn"),
  newBtnMain: document.getElementById("new-btn-main"),
  welcomeTemplate: document.getElementById("welcome-pane-template"),
  codeThemeLink: document.getElementById("code-theme"),
  modalBackdrop: document.getElementById("modal-backdrop"),
  modalMessage: document.getElementById("modal-message"),
  modalSave: document.getElementById("modal-save"),
  modalDontSave: document.getElementById("modal-dont-save"),
  modalCancel: document.getElementById("modal-cancel"),
};

const state = {
  // { kind, path, title, headings, hasMermaid, hasMath, rendered, paneEl,
  //   previewEl, contentEl, mode, source, savedSource, dirty, editor,
  //   editorEl, splitterEl, previewTimer, saving }
  // See createTabShell (the shared shape) and enterSplitMode (edit-mode
  // fields). `path` is null for a brand-new, never-saved document — see
  // newDocument. `kind` is "document" for every ordinary tab, or
  // "welcome" for a browser-style "New Tab" page — see newWelcomeTab and
  // buildWelcomePane.
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
// Split-pane ratio: one persisted preference shared by every tab, same
// pattern as THEME_KEY above (a bare-string localStorage key, a
// `*Preference()` getter that seeds+persists a default on first read).
// Global rather than per-tab deliberately — dragging the divider is a
// statement about how you want to work, not about one document, so a
// newly split tab already matches the last ratio you set instead of
// jumping back to 50/50. See attachSplitterDrag for where this is read
// and written.
// ---------------------------------------------------------------------
const SPLIT_RATIO_KEY = "mdreader.splitRatio";
const SPLIT_RATIO_DEFAULT = 50;
const SPLIT_MIN_PANE_PX = 160; // neither pane collapses to unusably narrow

function splitRatio() {
  const stored = Number(localStorage.getItem(SPLIT_RATIO_KEY));
  return Number.isFinite(stored) && stored > 0 ? stored : SPLIT_RATIO_DEFAULT;
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
    // "document" (an ordinary file or Untitled-document tab) unless a
    // caller overrides it — see newWelcomeTab for the other value.
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

/// Load `path` into a new tab. Its pane is created but not shown —
/// `activateTab` toggles visibility and does the (lazy, one-time)
/// mermaid/KaTeX render once the element actually has layout.
async function loadTab(path) {
  const tab = createTabShell({ path, title: basename(path) });
  const { contentEl } = tab;

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

/// Untitled document titles: "Untitled", then "Untitled 2", "Untitled 3", …
/// — scans current tab titles rather than keeping a running counter, so a
/// closed "Untitled 2" frees that number back up for the next Create,
/// matching how most editors number untitled documents.
function untitledTitle() {
  const taken = new Set(state.tabs.map((t) => t.title));
  if (!taken.has("Untitled")) return "Untitled";
  let n = 2;
  while (taken.has(`Untitled ${n}`)) n++;
  return `Untitled ${n}`;
}

let newDocInFlight = false;

/// Creates a brand-new, empty, never-saved document and drops it straight
/// into edit mode — the "Create" action. No template text: a document
/// nobody typed anything into is what makes the "closes with no unsaved-
/// changes prompt" rule (see confirmClosable) apply for free, since
/// `source: ""` / `savedSource: ""` means markDirty never flips to dirty
/// until the user actually types something.
///
/// Must activate the tab *before* entering split mode: enterSplitMode
/// constructs CodeMirror against the pane's real layout, which only
/// exists once activateTab has added the "visible" class — the same
/// ordering enterSplitMode's own comment documents for every other path
/// into edit mode.
async function newDocument() {
  if (newDocInFlight) return;
  newDocInFlight = true;
  try {
    const tab = createTabShell({ title: untitledTitle(), source: "", savedSource: "" });
    state.tabs.push(tab);
    await activateTab(state.tabs.length - 1);
    await enterSplitMode(tab);
    tab.editor?.focus();
  } catch (err) {
    console.error("failed to create a new document", err);
  } finally {
    newDocInFlight = false;
  }
}

/// Clones the shared welcome-pane template (see index.html's
/// #welcome-pane-template — the same Open File…/Create screen as the
/// zero-tabs #empty-state, but with data-action attributes instead of
/// ids, since several welcome tabs can be open at once and ids can't
/// repeat) into `tab`'s contentEl, and wires its two buttons. Open File…
/// goes straight to the same global dialog every other "open" path uses —
/// it doesn't touch this tab, exactly like opening a file from a
/// browser's New Tab page doesn't make that page disappear. Create is the
/// one welcome-tab-specific action: it converts *this* tab into the
/// Untitled document in place — see convertWelcomeTab.
function buildWelcomePane(tab) {
  tab.contentEl.classList.add("welcome");
  tab.contentEl.replaceChildren(els.welcomeTemplate.content.cloneNode(true));
  tab.contentEl
    .querySelector('[data-action="open-file"]')
    .addEventListener("click", openFileDialog);
  tab.contentEl
    .querySelector('[data-action="create"]')
    .addEventListener("click", () => convertWelcomeTab(tab));
}

/// Turns a welcome tab into an ordinary Untitled document, in place — no
/// second tab appears, matching a browser's New Tab page navigating to
/// content rather than spawning another tab. Removing the "welcome" class
/// is load-bearing, not tidiness: it's what gives .content its normal
/// prose padding/reading-column width back before enterSplitMode's
/// preview ever writes real rendered HTML into this same contentEl (see
/// the .content.welcome rule in styles.css) — left in place it would
/// silently break that document's layout.
async function convertWelcomeTab(tab) {
  tab.kind = "document";
  tab.title = untitledTitle();
  tab.source = "";
  tab.savedSource = "";
  tab.contentEl.classList.remove("welcome");
  tab.contentEl.replaceChildren();
  renderTabBar();
  try {
    await enterSplitMode(tab);
    tab.editor?.focus();
  } catch (err) {
    console.error("failed to enter edit mode for a new document", err);
  }
}

/// The "+" button, Cmd/Ctrl+N, and File ▸ New all land here now (not
/// newDocument directly) — like a browser's tab-strip "+", this opens a
/// closable "New Tab" page rather than jumping straight into an untitled
/// document; Create on that page is what actually does the latter (see
/// convertWelcomeTab). Several welcome tabs can coexist (repeated clicks
/// just add more, same as a browser) — they all carry `path: null` and
/// never collide with openPaths' path-based dedupe.
async function newWelcomeTab() {
  try {
    const tab = createTabShell({ kind: "welcome", title: "New Tab" });
    state.tabs.push(tab);
    await activateTab(state.tabs.length - 1);
    buildWelcomePane(tab);
  } catch (err) {
    console.error("failed to open a new tab", err);
  }
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

/// Shared "is it OK to make this tab go away" check, used by both
/// closeTab and the quit sequence (requestQuit). A clean tab always says
/// yes immediately — this is what makes an untouched untitled document
/// close with no prompt at all (requirement: an empty new document never
/// asks). A dirty tab is switched to (so the user can see what they're
/// about to decide about) and then run through the three-way modal;
/// "cancel" refuses, "dont-save" allows, and "save" defers to `saveTab`'s
/// own success/failure so a failed or cancelled save aborts the close
/// too, same as cancel.
async function confirmClosable(tab) {
  if (!tab.dirty) return true;
  if (tab.closeConfirmPending) return false; // already asking about this tab
  tab.closeConfirmPending = true;
  try {
    const i = state.tabs.indexOf(tab);
    if (i !== -1 && i !== state.activeIndex) await activateTab(i);
    const choice = await confirmUnsaved(tab);
    if (choice === "cancel") return false;
    if (choice === "save") return await saveTab(tab);
    return true; // "dont-save"
  } finally {
    tab.closeConfirmPending = false;
  }
}

/// Both existing call sites (the tab's × button, Cmd/Ctrl+W) fire this
/// without awaiting it, which is fine — but confirmClosable can await a
/// modal and, for an untitled tab choosing Save, a native save dialog on
/// top of that. That await is why `index` gets re-resolved below before
/// acting on it, rather than trusting the value this function was called
/// with.
async function closeTab(index) {
  const tab = state.tabs[index];
  if (!tab) return;

  if (!(await confirmClosable(tab))) return;

  // renderTabBar's per-tab click handlers (which capture a tab's position
  // by closure, not identity) could have closed a different tab while the
  // above was awaiting, shifting every index after it — or the user could
  // have triggered a second close of this same tab. Re-resolve by
  // identity rather than trusting the stale `index`.
  index = state.tabs.indexOf(tab);
  if (index === -1) return; // already gone

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
    el.title = tab.path ?? tab.title; // null for an untitled, never-saved tab

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
  // "+" is redundant chrome with nothing to sit next to at zero tabs —
  // the empty-state screen already offers Create/Open File… itself.
  els.newTabBtn.classList.toggle("is-hidden", !tab);
  state.tabs.forEach((t, i) => t.paneEl.classList.toggle("visible", i === index));
  // Visible only for a real, saved-to-disk file — not a welcome tab, and
  // not a brand-new Untitled document (already created straight into
  // edit mode; toggling it back to the read-only preview is still
  // reachable via Cmd/Ctrl+E, just with no visible button for it, same as
  // any other keyboard shortcut this app exposes without a matching
  // toolbar control while its target is unavailable).
  const canEditTab = tab && tab.kind === "document" && tab.path !== null;
  els.editToggleBtn.disabled = !canEditTab;
  els.editToggleBtn.classList.toggle("is-hidden", !canEditTab);
  updateSaveButton();

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

/// Sole owner of the 💾 button's visibility: hidden (not merely disabled)
/// unless the active tab is dirty — a brand-new untitled tab or a freshly
/// opened file both start clean, so there's nothing to save yet. Uses
/// `visibility`, not `display` (see the .icon-btn.is-hidden rule in
/// styles.css), so the buttons after it don't shift horizontally every
/// time a document's dirty state flips.
function updateSaveButton() {
  const tab = state.tabs[state.activeIndex];
  const show = !!(tab && tab.dirty);
  els.saveBtn.classList.toggle("is-hidden", !show);
  els.saveBtn.disabled = !show;
}

/// Mark `tab` dirty/clean and, only when the value actually changes,
/// reflect it in the tab bar and the save button — a full renderTabBar()
/// rebuild on every keystroke (dirty is recomputed on every CodeMirror
/// `change` event) would be wasteful once it's already showing the dot.
function markDirty(tab, dirty) {
  if (tab.dirty === dirty) return;
  tab.dirty = dirty;
  renderTabBar();
  if (state.tabs[state.activeIndex] === tab) {
    updateSaveButton();
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
///
/// Returns whether `tab` is clean once this settles — the tab-close and
/// quit flows (confirmClosable, requestQuit) need to know whether a
/// user-chosen "Save" actually succeeded before they proceed with closing
/// anything, since a failed save or a cancelled save-as picker must abort
/// the close, not silently discard the edit.
async function saveTab(tab) {
  if (!tab || !tab.editor || !tab.dirty || tab.saving) return !tab?.dirty;
  if (!tab.path) return saveTabAs(tab);

  tab.saving = true;
  if (state.tabs[state.activeIndex] === tab) els.saveBtn.disabled = true;
  try {
    const contents = tab.editor.getValue();
    await tauri.core.invoke("save_markdown_file", { path: tab.path, contents });
    tab.savedSource = contents;
    markDirty(tab, false);
    return true;
  } catch (err) {
    console.error("save failed", err);
    tauri.dialog
      .message(`Couldn't save ${tab.title}:\n${err}`, { title: "Save failed", kind: "error" })
      .catch((dialogErr) => console.error("failed to show save-error dialog", dialogErr));
    return false;
  } finally {
    tab.saving = false;
    if (state.tabs[state.activeIndex] === tab) updateSaveButton();
  }
}

/// The save path for a tab that's never been saved before (`tab.path ===
/// null`): asks the OS for a filename and location via the native save
/// dialog, then hands the result to `save_markdown_file_as`, which is what
/// actually appends a `.md` extension if the user typed a bare name (path
/// resolution stays in Rust — see CLAUDE.md). On success the tab becomes
/// an ordinary path-backed tab, same as one opened from disk.
async function saveTabAs(tab) {
  if (tab.saving) return false;
  tab.saving = true;
  if (state.tabs[state.activeIndex] === tab) els.saveBtn.disabled = true;
  try {
    const picked = await tauri.dialog.save({
      defaultPath: `${tab.title}.md`,
      filters: [{ name: "Markdown", extensions: [...markdownExtensions] }],
    });
    if (!picked) return false; // user cancelled the picker

    // Refuse rather than silently shadowing or closing the other tab —
    // there's no data-loss-free way to resolve two tabs claiming the same
    // path.
    if (state.tabs.some((t) => t !== tab && t.path === picked)) {
      await tauri.dialog
        .message(`"${basename(picked)}" is already open in another tab.`, {
          title: "Can't save here",
          kind: "error",
        })
        .catch((dialogErr) => console.error("failed to show save-as-collision dialog", dialogErr));
      return false;
    }

    const contents = tab.editor.getValue();
    const finalPath = await tauri.core.invoke("save_markdown_file_as", { path: picked, contents });
    tab.path = finalPath;
    tab.title = basename(finalPath);
    tab.savedSource = contents;
    markDirty(tab, false);
    // Relative image/link resolution just moved from the cwd fallback
    // (see render_markdown's base_path doc comment in lib.rs) to this
    // tab's real directory — the preview must re-render to pick that up.
    schedulePreview(tab);
    return true;
  } catch (err) {
    console.error("save failed", err);
    tauri.dialog
      .message(`Couldn't save ${tab.title}:\n${err}`, { title: "Save failed", kind: "error" })
      .catch((dialogErr) => console.error("failed to show save-error dialog", dialogErr));
    return false;
  } finally {
    tab.saving = false;
    if (state.tabs[state.activeIndex] === tab) updateSaveButton();
  }
}

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

/// Toggles a per-line prefix (blockquote `>`, the three list types) across
/// every line the selection touches — the "wrap" family only applies to a
/// character span, this applies to whole lines. If every touched line
/// already matches `testRe`, strips it from all of them; otherwise adds
/// `makePrefix(n)` (1-based position within the selection, for numbered
/// lists' sequential renumbering) to every line that doesn't already have
/// it — a mixed-state selection resolves to "add," matching how most
/// editors treat an inconsistent selection. Wrapped in `cm.operation` so a
/// multi-line toggle is one undo step, not one per line (verified real API
/// — lib/codemirror.js:8678).
///
/// `stripOtherListMarkers`: bullet/numbered/task are mutually exclusive as
/// a line's list-marker type — clicking Numbered List on an existing
/// bullet-list line must convert it (`1. text`), not stack
/// (`1. - text`). Blockquote doesn't pass this — `> - item` is valid,
/// a blockquote can legitimately contain a list.
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
        }
        n++;
      }
    }
  });
  cm.focus();
}

/// Sets the current line's ATX heading level (0 = plain paragraph).
/// Selection's first line only — a heading is inherently single-line
/// (CommonMark's ATX syntax is one #-prefixed line), so a multi-line
/// selection heading-ifying every line isn't the expected behavior.
/// Shared by the toolbar's cycling H button (cycleHeading, below) and the
/// Cmd/Ctrl+1..6 / +0 shortcuts (EDITOR_SHORTCUTS), which need to jump
/// straight to a level rather than step through it.
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

/// Cycles the current line through ATX heading levels: # -> ## -> ... ->
/// ###### -> (none) -> # -> ...
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
/// `posAfterText` (not flat `ch + length`) is what makes the resulting
/// selection correct even though these templates are always single-line
/// today — same helper `wrapSelection` already relies on.
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
    // Selection present -> it becomes the link text, next thing to fill
    // in is the URL. No selection -> insert a full placeholder template,
    // but select "text" first (you'd name the link before its target).
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
/// table. No guided tab-between-cells editing; that's a materially bigger
/// feature. Cursor lands at the start of "Header 1" to type over it.
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
/// definition `[^n]: ` appended at the document's end, as one atomic
/// `cm.operation` — the only control here that touches two different
/// positions in the document in a single click. `n` is chosen by scanning
/// existing `[^n]:` *definition* lines (not references, which could
/// legitimately reuse a number) and taking max + 1. Cursor ends up at the
/// new definition, ready to type its text — matches how other markdown
/// editors' footnote buttons behave. `lastLine()`/`getLine()` are read
/// *after* the reference insert, inside the same operation, so they
/// reflect the document's current state rather than a stale snapshot —
/// correct even if the cursor was already on the document's last line.
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

/// Cmd/Ctrl shortcuts available while the editor has focus (extraKeys —
/// a view-only tab never sees these). Every entry reuses an action
/// function the toolbar already calls below, which is what keeps the
/// constraint "only real Markdown syntax render.rs renders" automatic —
/// nothing here can produce output the toolbar couldn't already produce.
/// Deliberately no underline binding, same reason as the toolbar: no
/// Markdown syntax for it (see CLAUDE.md).
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

/// Three groups, rendered with a divider between them (see
/// createEditorToolbar): inline styles, line-level block markers, and
/// template insertions. Every control here is real syntax this app's own
/// render.rs enables — nothing aspirational. Deliberately excluded:
/// Underline (Markdown has no native syntax for it — see CLAUDE.md).
/// Glyphs follow this app's existing icon convention (plain Unicode/short
/// text, no icon font or SVG dependency, matching the ✎/💾/☀/☾ buttons
/// elsewhere in the chrome).
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
  TOOLBAR_GROUPS.forEach((group, i) => {
    if (i > 0) {
      const sep = document.createElement("div");
      sep.className = "editor-toolbar-sep";
      bar.appendChild(sep);
    }
    group.forEach(({ label, title, style, action }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "icon-btn";
      btn.title = title;
      btn.textContent = label;
      if (style) btn.style.cssText = style;
      btn.addEventListener("click", () => action(tab.editor));
      bar.appendChild(btn);
    });
  });
  return bar;
}

/// Create (once) the CodeMirror instance and editor-pane/splitter DOM for
/// `tab`, fetch its source lazily if this is the first time it's been
/// edited, and switch the tab into split mode. Safe to call on a tab
/// already in split mode. The splitter is drag-resizable — see
/// attachSplitterDrag — with the pane widths driven by the --split-ratio
/// custom property (styles.css) so this function only ever has to set
/// one number.
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
  tab.paneEl.style.setProperty("--split-ratio", `${splitRatio()}%`);

  if (!tab.editorEl) {
    const editorPane = document.createElement("div");
    editorPane.className = "editor-pane";
    // Toolbar first — see createEditorToolbar's comment on why DOM order
    // here matters (CodeMirror appends, it doesn't replace).
    const toolbar = createEditorToolbar(tab);
    editorPane.appendChild(toolbar);
    const splitter = document.createElement("div");
    splitter.className = "pane-splitter";
    // Semantics for assistive tech; there is deliberately no tabindex or
    // keyboard resize here — arrow-key resize would need its own keydown
    // handler and tab-order slot, a bigger decision than "make the drag
    // work."
    splitter.setAttribute("role", "separator");
    splitter.setAttribute("aria-orientation", "vertical");
    tab.paneEl.insertBefore(editorPane, tab.previewEl);
    tab.paneEl.insertBefore(splitter, tab.previewEl);
    tab.splitterEl = splitter;
    attachSplitterDrag(tab, splitter);

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
        // See EDITOR_SHORTCUTS/editorKeyName above for why this can't be
        // a hand-written "Mod-B"-style literal. These only fire while the
        // editor itself has focus, unlike the app's global keydown
        // handler, so they can't collide with Cmd/Ctrl+F or +W firing
        // from the find input or elsewhere.
        extraKeys: editorExtraKeys(),
      });
    } catch (err) {
      toolbar.remove();
      editorPane.remove();
      splitter.remove();
      tab.splitterEl = null;
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

/// Drag-to-resize for the editor/preview divider. Pointer events (not
/// mouse events) for two concrete reasons: setPointerCapture routes every
/// subsequent move/up straight to the splitter itself, so there's no
/// document-level listener to add and remove and no "button released
/// outside the window, drag never ended" state to clean up; and one code
/// path covers mouse, trackpad, touch and pen across all three OSes
/// instead of a mouse-only one. The visible affordance is the OS's own
/// col-resize cursor (styles.css) — no handle graphic, no button.
///
/// Attached once, when the splitter is first created (enterSplitMode),
/// and never torn down — same "create once, keep alive" lifetime as the
/// splitter element itself and tab.editorEl.
function attachSplitterDrag(tab, splitter) {
  let rafId = 0;

  const applyFromX = (clientX) => {
    const rect = tab.paneEl.getBoundingClientRect();
    if (rect.width <= 0) return;
    // Clamp in pixels, not percent: a percentage floor would still let
    // both sides collapse to an uselessly narrow column on a small
    // window, and the editor toolbar (14 buttons, .editor-toolbar's
    // overflow-x) needs a real minimum to stay usable.
    const min = SPLIT_MIN_PANE_PX;
    const max = rect.width - SPLIT_MIN_PANE_PX;
    if (max <= min) return; // window too narrow to split at all right now
    const x = Math.min(Math.max(clientX - rect.left, min), max);
    setSplitRatio((x / rect.width) * 100);
  };

  // Applies `pct` to every split tab, not just this one — the ratio is a
  // shared preference (see splitRatio's comment), so a tab that's already
  // in split mode elsewhere must not keep showing the old value.
  const setSplitRatio = (pct) => {
    for (const t of state.tabs) {
      if (t.mode === "split") t.paneEl.style.setProperty("--split-ratio", `${pct}%`);
    }
  };

  const persist = () => {
    const pct = parseFloat(tab.paneEl.style.getPropertyValue("--split-ratio"));
    if (Number.isFinite(pct)) localStorage.setItem(SPLIT_RATIO_KEY, String(pct));
  };

  splitter.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return; // ignore right/middle click
    e.preventDefault(); // no text-selection drag
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add("dragging"); // rule already exists, styles.css
    document.body.classList.add("is-splitting");
  });

  splitter.addEventListener("pointermove", (e) => {
    if (!splitter.hasPointerCapture(e.pointerId)) return;
    // Coalesce to one layout write per frame. CodeMirror re-measures on
    // every refresh(), and lineWrapping means it has to re-wrap each
    // visible line — an unthrottled refresh per pointermove is the one
    // way this drag could feel heavy on a large document.
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      applyFromX(e.clientX);
      tab.editor?.refresh();
    });
  });

  const endDrag = (e) => {
    if (!splitter.hasPointerCapture(e.pointerId)) return;
    splitter.releasePointerCapture(e.pointerId);
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    splitter.classList.remove("dragging");
    document.body.classList.remove("is-splitting");
    applyFromX(e.clientX);
    tab.editor?.refresh();
    persist();
  };
  splitter.addEventListener("pointerup", endDrag);
  splitter.addEventListener("pointercancel", endDrag);

  // Double-click resets to an even split — the standard convention for a
  // split sash, and the reason this needs no separate reset button.
  splitter.addEventListener("dblclick", () => {
    setSplitRatio(SPLIT_RATIO_DEFAULT);
    localStorage.setItem(SPLIT_RATIO_KEY, String(SPLIT_RATIO_DEFAULT));
    tab.editor?.refresh();
  });
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
// Unsaved-changes modal + quit sequence. This is the app's first custom
// modal — native tauri.dialog.confirm only offers two buttons, and "ask
// the user whether to save" needs three (Save / Don't Save / Cancel).
// ---------------------------------------------------------------------
let modalOpen = false;
let modalResolve = null;

/// Shows the shared unsaved-changes modal for `tab` and resolves once the
/// user picks "save" | "dont-save" | "cancel" — via a button, Enter
/// (save), Escape (cancel), or a backdrop click (cancel). `modalOpen` is
/// checked by the global keydown handler and the menu-action dispatcher
/// so neither keyboard shortcuts nor menu items reach through the
/// backdrop while this is up.
function confirmUnsaved(tab) {
  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement;
    modalOpen = true;
    modalResolve = (choice) => {
      modalOpen = false;
      modalResolve = null;
      els.modalBackdrop.classList.remove("visible");
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
      resolve(choice);
    };
    els.modalMessage.textContent = `Save changes to "${tab.title}"?`;
    els.modalBackdrop.classList.add("visible");
    els.modalSave.focus();
  });
}

let quitting = false;

/// Quitting is closing every tab at once, with the twist that a Cancel
/// anywhere must abort the *whole* quit rather than leaving some tabs
/// closed and others not — so, unlike closeTab, nothing is actually
/// spliced out of state.tabs until every dirty tab has been resolved; the
/// process just exits once they have been (quit_app == AppHandle::exit,
/// which never re-enters the CloseRequested handler that led here — see
/// lib.rs). Snapshotting state.tabs and re-resolving each tab's index by
/// identity on every iteration (never carrying an index across an await)
/// guards against the same "the tab bar changed while we were awaiting a
/// dialog" hazard closeTab already documents — here the await window is a
/// whole loop of modals and native save dialogs, not just one.
async function requestQuit() {
  if (quitting || modalOpen) return;
  quitting = true;
  const restoreIndex = state.activeIndex;
  try {
    for (const tab of state.tabs.slice()) {
      const i = state.tabs.indexOf(tab);
      if (i === -1 || !tab.dirty) continue;
      await activateTab(i);
      const choice = await confirmUnsaved(tab);
      if (choice === "cancel") {
        await activateTab(restoreIndex);
        return;
      }
      if (choice === "save" && !(await saveTab(tab))) {
        return; // failed write or a cancelled save-as picker — abort the quit
      }
    }
    await tauri.core.invoke("quit_app");
  } catch (err) {
    console.error("quit sequence failed", err);
  } finally {
    quitting = false;
  }
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

  // Wired once here rather than per-call in confirmUnsaved — the modal's
  // three buttons never change identity, only whether modalResolve is
  // currently set (i.e. a modal is actually open).
  els.modalSave.addEventListener("click", () => modalResolve?.("save"));
  els.modalDontSave.addEventListener("click", () => modalResolve?.("dont-save"));
  els.modalCancel.addEventListener("click", () => modalResolve?.("cancel"));
  els.modalBackdrop.addEventListener("click", (e) => {
    if (e.target === els.modalBackdrop) modalResolve?.("cancel");
  });

  document.addEventListener("keydown", (e) => {
    if (e.isComposing) return; // IME composition — not a real shortcut keystroke

    // The modal has no native focus trap (it's plain DOM, not <dialog>),
    // and a native menu press isn't blocked by a DOM backdrop at all (see
    // the "menu-action" listener in init) — so every other shortcut below
    // must be unreachable while it's open, not just visually obscured.
    if (modalOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        modalResolve?.("cancel");
      } else if (e.key === "Enter") {
        e.preventDefault();
        modalResolve?.("save");
      } else if (e.key === "Tab") {
        e.preventDefault();
        const order = [els.modalSave, els.modalDontSave, els.modalCancel];
        const from = order.indexOf(document.activeElement);
        order[(from + (e.shiftKey ? -1 : 1) + order.length) % order.length].focus();
      }
      return;
    }

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
    // No branches for New/Open/Quit here, deliberately — those are
    // menu-only (see the "menu-action" listener in init). A double-fired
    // New would create two tabs, the one non-idempotent action in this
    // app, so it gets exactly one trigger path instead of two racing
    // ones.
  });

  els.editToggleBtn.addEventListener("click", toggleEditMode);
  els.saveBtn.addEventListener("click", () => saveTab(state.tabs[state.activeIndex]));
  els.newTabBtn.addEventListener("click", newWelcomeTab);
  els.newBtnMain.addEventListener("click", newDocument);
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

/// Dispatches a native menu click (see src-tauri/src/menu.rs) to the same
/// actions their toolbar-button/keyboard equivalents use. Guarded the same
/// way as the global keydown handler: a native menu press isn't blocked
/// by the modal's DOM backdrop at all, so it needs its own check.
function handleMenuAction(id) {
  if (modalOpen) return;
  switch (id) {
    case "new":
      newWelcomeTab();
      break;
    case "open":
      openFileDialog();
      break;
    case "save":
      saveTab(state.tabs[state.activeIndex]);
      break;
    case "quit":
      requestQuit();
      break;
  }
}

async function init() {
  await applyTheme(); // as early as possible, before anything else paints
  wireStaticUI();

  els.openFileBtnMain.addEventListener("click", openFileDialog);
  els.themeBtn.addEventListener("click", cycleTheme);

  markdownExtensions = new Set(await tauri.core.invoke("markdown_extensions"));

  // Entry paths 1 & 2 (Windows/Linux argv, macOS RunEvent::Opened) may
  // have queued files before this ran. Entry path 3 (already-running
  // instance) arrives as a later "files-pending" hint — the queue is the
  // payload, the event is just a nudge to go drain it again.
  await drainAndOpen();
  await tauri.event.listen("files-pending", () => drainAndOpen());
  await tauri.event.listen("menu-action", ({ payload }) => handleMenuAction(payload));
  // Rust's CloseRequested handler prevents the close and emits this
  // instead of letting the window close outright — see lib.rs's
  // on_window_event. requestQuit runs the same per-tab unsaved-changes
  // sequence as the quit menu item, then calls quit_app itself.
  await tauri.event.listen("close-requested", () => requestQuit());

  // Only after both listeners above are registered: emitting
  // "close-requested" any earlier would have nothing listening for it and
  // the event would simply be lost (Tauri doesn't replay events) — the
  // same failure mode as the files-pending queue this mirrors. See
  // AppState::frontend_ready's doc comment in lib.rs.
  await tauri.core.invoke("mark_frontend_ready");

  try {
    await wireDragDrop();
  } catch (err) {
    console.error("drag-drop wiring failed", err);
  }
}

init();
