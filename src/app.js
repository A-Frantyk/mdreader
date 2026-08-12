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
  codeThemeLink: document.getElementById("code-theme"),
};

const state = {
  tabs: [], // { path, title, headings, hasMermaid, hasMath, rendered, contentEl }
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
// Theme: System (default, follows the OS) / Light / Dark. System is
// exactly the app's original behavior; Light/Dark are explicit overrides
// stored in localStorage so they persist across launches. See the
// [data-theme] blocks in styles.css and the two code-theme-*.css files
// build.rs generates.
// ---------------------------------------------------------------------
const THEME_KEY = "mdreader.theme";
const THEME_ICON = { system: "◐", light: "☀", dark: "☾" };

function themePreference() {
  return localStorage.getItem(THEME_KEY) || "system";
}

function resolvedTheme() {
  const pref = themePreference();
  return pref === "system" ? (darkQuery.matches ? "dark" : "light") : pref;
}

function setCodeThemeLink(theme) {
  els.codeThemeLink.href = theme === "dark" ? "code-theme-dark.css" : "code-theme-light.css";
}

async function applyTheme() {
  const pref = themePreference();
  document.documentElement.dataset.theme = pref === "system" ? "" : pref;
  setCodeThemeLink(resolvedTheme());
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
  const order = ["system", "light", "dark"];
  const next = order[(order.indexOf(themePreference()) + 1) % order.length];
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

/// Load `path` into a new tab. Its content element is created but not
/// shown — `activateTab` toggles visibility and does the (lazy, one-time)
/// mermaid/KaTeX render once the element actually has layout.
async function loadTab(path) {
  const contentEl = document.createElement("article");
  contentEl.className = "content";
  els.contentWrap.appendChild(contentEl);

  const tab = {
    path,
    title: basename(path),
    headings: [],
    hasMermaid: false,
    hasMath: false,
    rendered: false,
    contentEl,
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

function closeTab(index) {
  const [tab] = state.tabs.splice(index, 1);
  tab?.contentEl.remove();
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

  const tab = state.tabs[index];
  els.emptyState.style.display = tab ? "none" : "flex";
  state.tabs.forEach((t, i) => t.contentEl.classList.toggle("visible", i === index));

  if (!tab) {
    tocObserver?.disconnect();
    els.toc.innerHTML = "";
    els.sidebar.classList.add("hidden");
    return;
  }

  updateToc(tab);

  // First view of this tab: now that its content element is visible (and
  // therefore has real layout), it's safe to run mermaid/KaTeX, which
  // both need to measure text. Subsequent activations are free.
  if (!tab.rendered) {
    tab.rendered = true;
    await Promise.all([
      tab.hasMermaid ? renderMermaidFor(tab) : null,
      tab.hasMath ? renderMathFor(tab.contentEl) : null,
    ]);
  }
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
    { root: els.contentWrap, rootMargin: "0px 0px -70% 0px", threshold: 0 }
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
  return { startOnLoad: false, securityLevel: "strict", theme: resolvedTheme() === "dark" ? "dark" : "default" };
}

function ensureMermaid() {
  if (!mermaidLoadPromise) mermaidLoadPromise = loadScript("vendor/mermaid/mermaid.min.js");
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
    katexLoadPromise = loadScript("vendor/katex/katex.min.js").then(() =>
      loadScript("vendor/katex/auto-render.min.js")
    );
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

// An OS theme flip only matters while the user hasn't overridden it —
// applyTheme() re-resolves the effective theme, swaps the code-theme
// stylesheet, and re-renders already-viewed tabs' diagrams (see
// refreshMermaidTheme). Tabs never yet activated need nothing special —
// they'll render fresh, and already theme-correct, on first activation.
darkQuery.addEventListener("change", () => {
  if (themePreference() === "system") applyTheme();
});

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
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "f") {
      e.preventDefault();
      openFind();
    } else if (mod && e.key.toLowerCase() === "w" && state.activeIndex !== -1) {
      e.preventDefault();
      closeTab(state.activeIndex);
    }
  });
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
