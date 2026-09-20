// App-wide zoom: native webview page zoom, not CSS — see CLAUDE.md's zoom invariant.

const ZOOM_KEY = "mdreader.zoom";
const ZOOM_DEFAULT = 1;
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

// Stores the factor, not a step index — a future ZOOM_STEPS edit degrades gracefully
// via snap-to-nearest rather than an index pointing at a different value.
function zoomFactor() {
  const stored = Number(localStorage.getItem(ZOOM_KEY));
  if (!Number.isFinite(stored) || stored <= 0) return ZOOM_DEFAULT;
  const clamped = Math.min(Math.max(stored, ZOOM_STEPS[0]), ZOOM_STEPS[ZOOM_STEPS.length - 1]);
  return ZOOM_STEPS.reduce((closest, step) =>
    Math.abs(step - clamped) < Math.abs(closest - clamped) ? step : closest
  );
}

function nearestZoomIndex(factor) {
  let index = 0;
  for (let i = 1; i < ZOOM_STEPS.length; i++) {
    if (Math.abs(ZOOM_STEPS[i] - factor) < Math.abs(ZOOM_STEPS[index] - factor)) index = i;
  }
  return index;
}

// Re-measures every tab's CodeMirror instance — page zoom changes cached character metrics.
async function applyZoom() {
  await tauri.core.invoke("set_zoom", { factor: zoomFactor() });
  for (const tab of state.tabs) tab.editor?.refresh();
}

function setZoomFactor(factor) {
  localStorage.setItem(ZOOM_KEY, String(factor));
  return applyZoom();
}

function stepZoom(direction) {
  const index = nearestZoomIndex(zoomFactor());
  const next = ZOOM_STEPS[Math.min(Math.max(index + direction, 0), ZOOM_STEPS.length - 1)];
  return setZoomFactor(next);
}

function resetZoom() {
  return setZoomFactor(ZOOM_DEFAULT);
}
