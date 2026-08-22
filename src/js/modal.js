// The three-button unsaved-changes modal and the quit sequence that drives
// it, plus the About dialog (a second, simpler modal reusing the same
// .modal-backdrop/.modal CSS).

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

// ---------------------------------------------------------------------
// About dialog. Opened via the native menu's ABOUT id (menu.rs) — see
// handleMenuAction in js/main.js. `aboutOpen` is checked by the same
// global keydown handler and menu-action dispatcher as `modalOpen`, for
// the same reason: a native menu press isn't blocked by any DOM backdrop.
// ---------------------------------------------------------------------
let aboutOpen = false;
let aboutPreviouslyFocused = null;

async function openAbout() {
  aboutPreviouslyFocused = document.activeElement;
  aboutOpen = true;
  els.aboutVersion.textContent = `Version ${await tauri.app.getVersion()}`;
  els.aboutBackdrop.classList.add("visible");
  els.aboutClose.focus();
}

function closeAbout() {
  aboutOpen = false;
  els.aboutBackdrop.classList.remove("visible");
  if (aboutPreviouslyFocused instanceof HTMLElement) aboutPreviouslyFocused.focus();
  aboutPreviouslyFocused = null;
}
