// Save/dirty-state tracking and the two save commands (in place, save-as).

// Sole owner of the save button's visibility — shown only when the active tab is dirty.
function updateSaveButton() {
  const tab = state.tabs[state.activeIndex];
  const show = !!(tab && tab.dirty);
  els.saveBtn.classList.toggle("is-hidden", !show);
  els.saveBtn.disabled = !show;
}

// Only reflects a change when the value actually flips — renderTabBar() on every
// CodeMirror `change` event would be wasteful once the dot is already showing.
function markDirty(tab, dirty) {
  if (tab.dirty === dirty) return;
  tab.dirty = dirty;
  renderTabBar();
  if (state.tabs[state.activeIndex] === tab) {
    updateSaveButton();
    updateDocumentTitle();
  }
}

// Tauri doesn't sync document.title to the native title bar on its own.
function updateDocumentTitle() {
  const tab = state.tabs[state.activeIndex];
  document.title = tab ? `${tab.dirty ? "● " : ""}${tab.title} — mdreader` : "mdreader";
}

// On failure the buffer, dirty flag, and undo history are left untouched. Returns
// whether `tab` ends up clean — confirmClosable/requestQuit need that to know
// whether to abort a close on a failed or cancelled save.
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

// The save path for a tab never saved before (tab.path === null).
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

    // Refuse rather than shadowing or closing the other tab — no data-loss-free
    // way to resolve two tabs claiming the same path.
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
    // Relative image/link resolution just moved from the cwd fallback to this
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
