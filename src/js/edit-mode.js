// Entering/exiting split (view+editor) mode for a tab.

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
