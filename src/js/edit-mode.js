// Entering/exiting split (view+editor) mode for a tab.

// Renames markdown.js's own token types to an md-prefixed namespace — see CLAUDE.md's
// two-theme-layer invariant. pure-helpers.test.mjs asserts this stays in sync with the
// vendored mode if it's ever upgraded.
const MARKDOWN_TOKEN_TYPES = {
  header: "md-header",
  code: "md-code",
  quote: "md-quote",
  list1: "md-list",
  list2: "md-list",
  list3: "md-list",
  hr: "md-hr",
  image: "md-image",
  imageAltText: "md-image-alt",
  imageMarker: "md-image-marker",
  formatting: "md-punct",
  linkInline: "md-link",
  linkEmail: "md-link",
  linkText: "md-link",
  linkHref: "md-href",
  em: "md-em",
  strong: "md-strong",
  strikethrough: "md-strike",
  emoji: "md-emoji",
};

// Must be appended before `new CodeMirror(...)` — CodeMirror appends its own wrapper
// rather than replacing container contents.
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
    // Not part of open_markdown_file's payload — a lazily-fetched separate call instead
    // of doubling every view-only open's IPC payload with source nobody reads.
    tab.source = await tauri.core.invoke("read_markdown_source", { path: tab.path });
    tab.savedSource = tab.source;
  }

  // Before creating CodeMirror, not after: constructing it inside a still-hidden
  // container (.editor-pane defaults to display:none) makes it cache a zero-size
  // measurement that refresh() doesn't reliably recover from.
  tab.mode = "split";
  tab.paneEl.classList.add("split");
  tab.paneEl.style.setProperty("--split-ratio", `${splitRatio()}%`);

  if (!tab.editorEl) {
    const editorPane = document.createElement("div");
    editorPane.className = "editor-pane";
    const toolbar = createEditorToolbar(tab); // must precede CodeMirror construction below
    editorPane.appendChild(toolbar);
    const splitter = document.createElement("div");
    splitter.className = "pane-splitter";
    // No tabindex/keyboard resize — a bigger decision than "make the drag work."
    splitter.setAttribute("role", "separator");
    splitter.setAttribute("aria-orientation", "vertical");
    tab.paneEl.insertBefore(editorPane, tab.previewEl);
    tab.paneEl.insertBefore(splitter, tab.previewEl);
    tab.splitterEl = splitter;
    attachSplitterDrag(tab, splitter);

    // If construction throws, undo the DOM and mode flip before rethrowing — otherwise
    // the pane claims split mode with a half-built, empty editor.
    try {
      tab.editor = new window.CodeMirror(editorPane, {
        value: tab.source,
        // highlightFormatting: true is load-bearing — see CLAUDE.md's two-theme-layer invariant.
        mode: { name: "gfm", highlightFormatting: true, tokenTypeOverrides: MARKDOWN_TOKEN_TYPES },
        theme: "mdreader mdreader-syntax",
        lineWrapping: true,
        lineNumbers: true,
        extraKeys: editorExtraKeys(), // only fire while the editor has focus
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
