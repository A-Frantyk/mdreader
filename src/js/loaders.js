// Lazy-loaded heavy bundles: mermaid, KaTeX, and CodeMirror — see CLAUDE.md's lazy-load-gating invariant.

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
