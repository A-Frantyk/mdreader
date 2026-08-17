// Save/dirty-state tracking and the two save commands (in place, save-as).

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
