// Tab lifecycle: opening, closing, activating, and the tab bar.

// Pane is created but not shown — activateTab toggles visibility and does the
// lazy, one-time mermaid/KaTeX render once the element has real layout.
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

// Scans current titles rather than a running counter, so a closed "Untitled 2"
// frees that number back up for the next Create.
function untitledTitle() {
  const taken = new Set(state.tabs.map((t) => t.title));
  if (!taken.has("Untitled")) return "Untitled";
  let n = 2;
  while (taken.has(`Untitled ${n}`)) n++;
  return `Untitled ${n}`;
}

let newDocInFlight = false;

// No template text: source === savedSource === "" is what keeps markDirty from
// flipping until the user actually types something (see confirmClosable).
// Must activate before entering split mode — enterSplitMode needs the pane's
// real layout, which only exists once activateTab adds the "visible" class.
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

// data-action attributes, not ids — several welcome tabs can be open at once
// and ids can't repeat in a cloned template.
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

// In place, no second tab — matching a browser's New Tab page navigating to content.
// Removing the "welcome" class is load-bearing: it restores .content's normal prose
// width before real rendered HTML lands in this same contentEl.
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

// Several welcome tabs can coexist — path: null never collides with openPaths' dedupe.
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

// Single entry point for every way a document can be opened.
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

// Shared by closeTab and requestQuit. "save" defers to saveTab's own success/failure,
// so a failed or cancelled save aborts the close too, same as "cancel".
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

  // Another tab could have closed (or this one closed twice) while the above awaited,
  // shifting indices — re-resolve by identity rather than trusting the stale `index`.
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
