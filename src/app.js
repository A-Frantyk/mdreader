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
  tabs: [],
  activeIndex: -1,
};

const inFlight = new Set(); // paths currently being opened, for openPaths' dedupe
const find = { currentIndex: -1 };
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

/// Extensions this app is registered to handle, fetched once from
/// tauri.conf.json via the `markdown_extensions` command rather than
/// hand-duplicated here.
let markdownExtensions = new Set();

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

// On first launch the OS's current theme preference is read once and
// persisted as an explicit choice; the app never re-consults the OS
// after that, so a later OS theme flip doesn't silently relabel anything.
const THEME_KEY = "mdreader.theme";
const THEME_ICON = { light: "☀", dark: "☾" };

function themePreference() {
  let pref = localStorage.getItem(THEME_KEY);
  if (!pref) {
    pref = darkQuery.matches ? "dark" : "light";
    localStorage.setItem(THEME_KEY, pref);
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

// Split-pane ratio is a single preference shared by every tab, not
// per-tab — a newly split tab starts at the last ratio you dragged to,
// rather than jumping back to 50/50. See attachSplitterDrag.
const SPLIT_RATIO_KEY = "mdreader.splitRatio";
const SPLIT_RATIO_DEFAULT = 50;
const SPLIT_MIN_PANE_PX = 160;

function splitRatio() {
  const stored = Number(localStorage.getItem(SPLIT_RATIO_KEY));
  if (!Number.isFinite(stored) || stored <= 0) return SPLIT_RATIO_DEFAULT;
  // Sanity clamp on a value read straight from localStorage (hand-edited
  // or corrupted) before any real layout exists to pixel-clamp it —
  // attachSplitterDrag's applyFromX is the actual SPLIT_MIN_PANE_PX-based
  // clamp once a drag or the pane's real width is available.
  return Math.min(Math.max(stored, 10), 90);
}

async function openFileDialog() {
  const selection = await tauri.dialog.open({
    multiple: true,
    filters: [{ name: "Markdown", extensions: [...markdownExtensions] }],
  });
  if (selection) await openPaths(Array.isArray(selection) ? selection : [selection]);
}

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

/// Clones the shared welcome-pane template (index.html's
/// #welcome-pane-template) into `tab`'s contentEl — data-action
/// attributes instead of ids, since several welcome tabs can be open at
/// once and ids can't repeat in a cloned template.
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

/// Several welcome tabs can coexist — they all carry `path: null` and
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

/// Single entry point for every way a document can be opened. Dedupes
/// against both open tabs and in-flight loads, then activates once at
/// the end.
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
/// closeTab and requestQuit. A dirty tab is switched to first (so the
/// user sees what they're deciding about), then run through the
/// three-way modal — "save" defers to saveTab's own success/failure, so
/// a failed or cancelled save aborts the close too, same as "cancel".
async function confirmClosable(tab) {
  if (!tab.dirty) return true;
  if (tab.closeConfirmPending) return false;
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
  if (index === -1) return;

  const [closed] = state.tabs.splice(index, 1);
  if (closed.previewTimer) clearTimeout(closed.previewTimer);
  closed.paneEl.remove();
  // Math.min(index, len - 1) is -1 once the last tab closes, which
  // activateTab treats as "show the empty state" — no separate branch.
  activateTab(Math.min(index, state.tabs.length - 1));
}

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
  // Visible only for a real, saved-to-disk file — a brand-new Untitled
  // document is already in edit mode, and toggling back is still
  // reachable via Cmd/Ctrl+E even with no visible button for it.
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

  // Re-measure in case CodeMirror last laid out while this pane was
  // display:none, which leaves it rendering blank until refreshed.
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

// render.rs already resolved every local image destination to an absolute
// filesystem path and put it in data-path, never src — see the
// path-resolution invariant in CLAUDE.md for why (ammonia applies URL rules
// to src=, and a Windows path like C:\... parses as URL scheme "c" and gets
// silently dropped). A remote or data-URI <img> never gets a data-path, so
// this is a pure attribute-presence check, not path arithmetic.
function rewriteImageSources(root) {
  root.querySelectorAll("img[data-path]").forEach((img) => {
    img.src = tauri.core.convertFileSrc(img.dataset.path);
  });
}

function isExternal(href) {
  return href.includes("://") || href.startsWith("mailto:") || href.startsWith("tel:");
}

// ---------------------------------------------------------------------
// Handing a non-markdown link to the OS (`opener.openPath`) is the one
// place this app turns untrusted document content into "run something
// outside the webview". By the time a link reaches the click handler,
// render.rs has already resolved it to an absolute filesystem path (see
// the path-resolution invariant in CLAUDE.md), so a document shipped
// alongside `install.command` / `Setup.exe` / `x.desktop` could name it
// with any link text it likes. Two layers, deliberately both:
//   1. a denylist of extensions the OS would *execute* rather than
//      *display* — refused outright, with a message;
//   2. a native yes/no dialog showing the resolved absolute path (not the
//      link text) for everything else, so a click is never silent.
// The denylist is a convenience, not the guarantee — the confirmation is.
// Never call `tauri.opener.openPath` anywhere except through
// openWithSystem.
// ---------------------------------------------------------------------
const BLOCKED_OPEN_EXTENSIONS = new Set([
  // macOS
  "app", "command", "terminal", "workflow", "scpt", "action", "pkg", "dmg",
  // Windows
  "exe", "bat", "cmd", "com", "scr", "ps1", "hta", "lnk", "msi", "pif", "vbs", "vbe", "wsf", "wsh", "reg",
  // Linux / cross-platform
  "desktop", "sh", "run", "appimage", "js", "jar",
]);

async function openWithSystem(href) {
  if (BLOCKED_OPEN_EXTENSIONS.has(extOf(href))) {
    await tauri.dialog.message(`Refusing to open this file — it looks like an executable.\n\n${href}`, {
      title: "Blocked",
      kind: "warning",
    });
    return;
  }
  const ok = await tauri.dialog.ask(`Open this file with its default application?\n\n${href}`, {
    title: "Open file",
    kind: "warning",
    okLabel: "Open",
    cancelLabel: "Cancel",
  });
  if (!ok) return;
  await tauri.opener.openPath(href).catch((err) => console.error("failed to open path", err));
}

// A resolved local link carries data-path, not href (see rewriteImageSources'
// comment above), but everything downstream of "we have a local filesystem
// path" is one decision regardless of which attribute it came from — this is
// also the click handler's own href fallback for a raw <a href> the document
// wrote itself in literal HTML (never touched by render.rs's resolution,
// since it isn't markdown link syntax).
function activateLocalPath(path) {
  if (markdownExtensions.has(extOf(path))) {
    openPaths([path]);
  } else {
    openWithSystem(path);
  }
}

// Delegated once on the shared container rather than per-link per-render:
// tabs' content persists, so this fires for every tab without rebinding.
// In-page `#anchor` clicks are handled here too (not left to the browser)
// because every open tab's headings live in the same document at once —
// default fragment navigation can't tell which tab's heading you meant.
els.contentWrap.addEventListener("click", (e) => {
  const a = e.target.closest("a[href], a[data-path]");
  if (!a) return;
  e.preventDefault();

  if (a.dataset.path) {
    activateLocalPath(a.dataset.path);
    return;
  }

  const href = a.getAttribute("href");
  if (!href) return;

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
  activateLocalPath(href);
});

// role="link" tabindex="0" (render.rs) makes a data-path <a> focusable, same
// as a real href would — but an <a> with no href fires no native "click"
// activation on Enter/Space, so that has to be replicated here explicitly.
els.contentWrap.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const a = e.target.closest("a[data-path]");
  if (!a) return;
  e.preventDefault();
  activateLocalPath(a.dataset.path);
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
/// used when the user toggles the theme) every mermaid fence in `tab`.
/// Must only be called while `tab.contentEl` is visible: mermaid measures
/// text via the DOM, which returns nothing useful for a `display: none`
/// subtree.
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

// CodeMirror is vendored (src/vendor/codemirror/) and loaded lazily via
// the same memoized-promise pattern as Mermaid/KaTeX above, so a pure
// viewing session never fetches it — see ensureCodeMirror.
let codeMirrorLoadPromise = null;

// Kept as a module-level reference (like els.codeThemeLink), created
// lazily inside ensureCodeMirror, so applyTheme can flip its href on a
// theme change once edit mode has been entered — see enterSplitMode's
// `theme:` value for the two-stylesheet split this points at.
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

/// Sole owner of the 💾 button's visibility: hidden via `display: none`
/// (see .icon-btn.is-hidden in styles.css) unless the active tab is
/// dirty — a brand-new untitled tab or a freshly opened file both start
/// clean, so there's nothing to save yet.
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

/// Writes the active editor buffer to disk via `save_markdown_file`. On
/// failure the buffer, dirty flag, and undo history are all left
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
/// null`). `save_markdown_file_as` appends a `.md` extension if the user
/// typed a bare name — path resolution stays in Rust, see CLAUDE.md.
async function saveTabAs(tab) {
  if (tab.saving) return false;
  tab.saving = true;
  if (state.tabs[state.activeIndex] === tab) els.saveBtn.disabled = true;
  try {
    const picked = await tauri.dialog.save({
      defaultPath: `${tab.title}.md`,
      filters: [{ name: "Markdown", extensions: [...markdownExtensions] }],
    });
    if (!picked) return false;

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

/// Builds the formatting toolbar for `tab`'s editor pane. Must be
/// appended into editorPane *before* `new CodeMirror(...)` — CodeMirror's
/// constructor appends its own wrapper rather than replacing container
/// contents, so toolbar-first in the DOM is what puts it visually on top.
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
    // Deliberately no tabindex or keyboard resize here — a bigger
    // decision than "make the drag work."
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
        theme: "mdreader mdreader-syntax",
        lineWrapping: true,
        lineNumbers: true,
        // These only fire while the editor has focus, so they can't
        // collide with the global keydown handler's own Cmd/Ctrl+F, +W.
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
/// mouse events): setPointerCapture routes every subsequent move/up
/// straight to the splitter itself, so there's no document-level
/// listener to add/remove and no "button released outside the window"
/// state to clean up, and one code path covers mouse, trackpad, touch,
/// and pen.
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
    if (max <= min) return;
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
    if (e.button !== 0) return;
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add("dragging");
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
    if (seq !== tab.previewSeq) return;

    tab.headings = doc.headings;
    tab.hasMermaid = doc.has_mermaid;
    tab.hasMath = doc.has_math;
    tab.contentEl.innerHTML = doc.html;
    rewriteImageSources(tab.contentEl);

    const isActive = state.tabs[state.activeIndex] === tab;
    if (isActive) updateToc(tab);

    // Mermaid/KaTeX must not run against a hidden subtree — if the tab
    // isn't visible, skip and let activateTab's previewNeedsEnrich check
    // catch it on the next activation instead.
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

// The webview exposes no scriptable native find, so this walks the
// active tab's text nodes and wraps matches in <mark>.
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

/// Shows the shared unsaved-changes modal for `tab`, resolving once the
/// user picks "save" | "dont-save" | "cancel". `modalOpen` is checked by
/// the global keydown handler and the menu-action dispatcher so neither
/// reaches through the backdrop while this is up.
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

/// Quitting closes every tab at once; a Cancel anywhere aborts the
/// *whole* quit, so — unlike closeTab — nothing is spliced out of
/// state.tabs until every dirty tab has been resolved. Re-resolving each
/// tab's index by identity on every iteration guards against the same
/// "the tab bar changed while awaiting a dialog" hazard closeTab
/// documents, here across a whole loop of modals and save dialogs.
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
        return;
      }
    }
    await tauri.core.invoke("quit_app");
  } catch (err) {
    console.error("quit sequence failed", err);
  } finally {
    quitting = false;
  }
}

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
      openPaths((event.payload.paths || []).filter((p) => markdownExtensions.has(extOf(p))));
    }
  });
}

/// Dispatches a native menu click (src-tauri/src/menu.rs) to the same
/// actions their toolbar/keyboard equivalents use. Guarded like the
/// global keydown handler: a native menu press isn't blocked by the
/// modal's DOM backdrop at all.
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
  // instead — see lib.rs's on_window_event.
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
