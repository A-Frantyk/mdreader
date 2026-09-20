// The split-pane ratio preference and its drag-to-resize handle.

// One global preference, not per-tab — see CLAUDE.md.
const SPLIT_RATIO_KEY = "mdreader.splitRatio";
const SPLIT_RATIO_DEFAULT = 50;
const SPLIT_MIN_PANE_PX = 160;

function splitRatio() {
  const stored = Number(localStorage.getItem(SPLIT_RATIO_KEY));
  if (!Number.isFinite(stored) || stored <= 0) return SPLIT_RATIO_DEFAULT;
  // Sanity clamp for hand-edited/corrupted localStorage — applyFromX pixel-clamps for real.
  return Math.min(Math.max(stored, 10), 90);
}

// Pointer events, not mouse events: setPointerCapture routes every move/up straight to
// the splitter, so there's no document-level listener and one path covers all input types.
function attachSplitterDrag(tab, splitter) {
  let rafId = 0;

  const applyFromX = (clientX) => {
    const rect = tab.paneEl.getBoundingClientRect();
    if (rect.width <= 0) return;
    // Pixels, not percent — a percentage floor would still let both sides collapse
    // uselessly narrow on a small window.
    const min = SPLIT_MIN_PANE_PX;
    const max = rect.width - SPLIT_MIN_PANE_PX;
    if (max <= min) return;
    const x = Math.min(Math.max(clientX - rect.left, min), max);
    setSplitRatio((x / rect.width) * 100);
  };

  // Applies to every split tab, not just this one — the ratio is a shared preference.
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
    // Coalesce to one layout write per frame — an unthrottled refresh() per
    // pointermove is the one way this drag could feel heavy on a large document.
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
