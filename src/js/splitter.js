// The split-pane ratio preference and its drag-to-resize handle.

// Split-pane ratio is a single preference shared by every tab, not
// per-tab — a newly split tab starts at the last ratio you dragged to,
// rather than jumping back to 50/50. See attachSplitterDrag.
const SPLIT_RATIO_KEY = "mdreader.splitRatio";
const SPLIT_RATIO_DEFAULT = 50;
const SPLIT_MIN_PANE_PX = 160;

function splitRatio() {
  const stored = Number(localStorage.getItem(SPLIT_RATIO_KEY));
  if (!Number.isFinite(stored) || stored <= 0) return SPLIT_RATIO_DEFAULT;
  // Sanity clamp on a value read straight from localStorage (hand-edited
  // or corrupted) before any real layout exists to pixel-clamp it —
  // attachSplitterDrag's applyFromX is the actual SPLIT_MIN_PANE_PX-based
  // clamp once a drag or the pane's real width is available.
  return Math.min(Math.max(stored, 10), 90);
}

/// Drag-to-resize for the editor/preview divider. Pointer events (not
/// mouse events): setPointerCapture routes every subsequent move/up
/// straight to the splitter itself, so there's no document-level
/// listener to add/remove and no "button released outside the window"
/// state to clean up, and one code path covers mouse, trackpad, touch,
/// and pen.
function attachSplitterDrag(tab, splitter) {
  let rafId = 0;

  const applyFromX = (clientX) => {
    const rect = tab.paneEl.getBoundingClientRect();
    if (rect.width <= 0) return;
    // Clamp in pixels, not percent: a percentage floor would still let
    // both sides collapse to an uselessly narrow column on a small
    // window, and the editor toolbar (14 buttons, .editor-toolbar's
    // overflow-x) needs a real minimum to stay usable.
    const min = SPLIT_MIN_PANE_PX;
    const max = rect.width - SPLIT_MIN_PANE_PX;
    if (max <= min) return;
    const x = Math.min(Math.max(clientX - rect.left, min), max);
    setSplitRatio((x / rect.width) * 100);
  };

  // Applies `pct` to every split tab, not just this one — the ratio is a
  // shared preference (see splitRatio's comment), so a tab that's already
  // in split mode elsewhere must not keep showing the old value.
  const setSplitRatio = (pct) => {
    for (const t of state.tabs) {
      if (t.mode === "split") t.paneEl.style.setProperty("--split-ratio", `${pct}%`);
    }
  };

  const persist = () => {
    const pct = parseFloat(tab.paneEl.style.getPropertyValue("--split-ratio"));
    if (Number.isFinite(pct)) localStorage.setItem(SPLIT_RATIO_KEY, String(pct));
  };

  splitter.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add("dragging");
    document.body.classList.add("is-splitting");
  });

  splitter.addEventListener("pointermove", (e) => {
    if (!splitter.hasPointerCapture(e.pointerId)) return;
    // Coalesce to one layout write per frame. CodeMirror re-measures on
    // every refresh(), and lineWrapping means it has to re-wrap each
    // visible line — an unthrottled refresh per pointermove is the one
    // way this drag could feel heavy on a large document.
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      applyFromX(e.clientX);
      tab.editor?.refresh();
    });
  });

  const endDrag = (e) => {
    if (!splitter.hasPointerCapture(e.pointerId)) return;
    splitter.releasePointerCapture(e.pointerId);
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    splitter.classList.remove("dragging");
    document.body.classList.remove("is-splitting");
    applyFromX(e.clientX);
    tab.editor?.refresh();
    persist();
  };
  splitter.addEventListener("pointerup", endDrag);
  splitter.addEventListener("pointercancel", endDrag);

  splitter.addEventListener("dblclick", () => {
    setSplitRatio(SPLIT_RATIO_DEFAULT);
    localStorage.setItem(SPLIT_RATIO_KEY, String(SPLIT_RATIO_DEFAULT));
    tab.editor?.refresh();
  });
}
