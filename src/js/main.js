// Wiring: static UI listeners, drag-drop, native menu dispatch, and app bootstrap.

async function openFileDialog() {
  const selection = await tauri.dialog.open({
    multiple: true,
    filters: [{ name: "Markdown", extensions: [...markdownExtensions] }],
  });
  if (selection) await openPaths(Array.isArray(selection) ? selection : [selection]);
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

  els.aboutClose.addEventListener("click", closeAbout);
  els.aboutBackdrop.addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (a) {
      e.preventDefault();
      tauri.opener.openUrl(a.getAttribute("href")).catch((err) =>
        console.error("failed to open url", err)
      );
      return;
    }
    if (e.target === els.aboutBackdrop) closeAbout();
  });

  document.addEventListener("keydown", (e) => {
    if (e.isComposing) return; // IME composition — not a real shortcut keystroke

    // Same reasoning as the modalOpen block below: no native focus trap,
    // and a native menu press isn't blocked by a DOM backdrop at all.
    // About only has one button, so just Escape.
    if (aboutOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeAbout();
      }
      return;
    }

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
    } else if (mod && e.key === "+") {
      // Cmd/Ctrl+Equal and Cmd/Ctrl+Minus are native menu accelerators
      // (menu.rs's ZOOM_IN/ZOOM_OUT), not handled here — this branch only
      // covers the *shifted* "+" (Cmd+Shift+Equal on most layouts) and a
      // numpad Add key, neither of which the menu accelerator's exact
      // modifier match fires for. Disjoint by construction: nothing here
      // can double-fire against a menu press.
      e.preventDefault();
      stepZoom(1);
    } else if (mod && e.code === "NumpadSubtract") {
      // NumpadSubtract's e.key is "-", identical to the main-row Minus key
      // the menu accelerator already owns — checked by e.code, not e.key,
      // so the two can't collide.
      e.preventDefault();
      stepZoom(-1);
    }
    // No branches for New/Open/Quit here, deliberately — those are
    // menu-only (see the "menu-action" listener in init). A double-fired
    // New would create two tabs, the one non-idempotent action in this
    // app, so it gets exactly one trigger path instead of two racing
    // ones.
  });

  // Ctrl+wheel is also how a macOS trackpad pinch arrives (as a wheel
  // event with ctrlKey set, not a gesture event) — metaKey is deliberately
  // ignored, since Cmd+scroll isn't a zoom convention anywhere. Accumulates
  // deltas rather than stepping per-event: a trackpad fires many small
  // events per gesture, and deltaMode 1 ("lines") is normalized to pixels
  // first so the threshold means the same thing on either input device.
  let wheelZoomAccum = 0;
  window.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey || modalOpen || aboutOpen) return;
      e.preventDefault();
      wheelZoomAccum += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      if (Math.abs(wheelZoomAccum) < 40) return;
      stepZoom(wheelZoomAccum < 0 ? 1 : -1);
      wheelZoomAccum = 0;
    },
    { passive: false }
  );

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
  if (modalOpen || aboutOpen) return;
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
    case "zoom-in":
      stepZoom(1);
      break;
    case "zoom-out":
      stepZoom(-1);
      break;
    case "zoom-reset":
      resetZoom();
      break;
    case "about":
      openAbout();
      break;
  }
}

async function init() {
  await applyTheme(); // as early as possible, before anything else paints
  // Unconditional, including at the default factor: the webview keeps its
  // zoom level across a dev reload, so skipping this at factor 1 would
  // leave a stale zoom from a previous session's reload stuck in place.
  await applyZoom();
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
