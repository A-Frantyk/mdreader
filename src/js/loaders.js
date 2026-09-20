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
    // Null the memo on failure so a transient error doesn't wedge the rest of the session.
    mermaidLoadPromise = loadScript("vendor/mermaid/mermaid.min.js").catch((err) => {
      mermaidLoadPromise = null;
      throw err;
    });
  }
  return mermaidLoadPromise;
}

// Must only be called while tab.contentEl is visible — mermaid measures text via the
// DOM, which returns nothing useful for a display:none subtree.
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

let codeMirrorLoadPromise = null;
let cmSyntaxThemeLink = null; // set inside ensureCodeMirror, so applyTheme can flip its href

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
      // gfm.js needs CodeMirror.overlayMode (this addon, not core) — without it, its mode
      // factory throws only once a "gfm" editor is constructed, so the symptom is a blank
      // editor pane at that later point, not a load error here.
      .then(() => loadScript("vendor/codemirror/addon/mode/overlay.js"))
      // Fence highlighting needs CodeMirror.findModeByName (meta.js) plus the per-language
      // modes below, in each file's own declared dependency order (checked against each
      // UMD header): rust.js needs simple.js first; htmlmixed.js needs xml/javascript/css first.
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
