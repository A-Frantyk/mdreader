// Debounced live-preview re-rendering while editing.

const PREVIEW_DEBOUNCE_MS = 200;

function schedulePreview(tab) {
  clearTimeout(tab.previewTimer);
  tab.previewTimer = setTimeout(() => runPreview(tab), PREVIEW_DEBOUNCE_MS);
}

// At most one render_markdown call in flight per tab — a change mid-render sets
// previewStale and re-fires once the in-flight one resolves. previewSeq guards
// against applying a response superseded by one that resolved first out of order.
async function runPreview(tab) {
  if (tab.previewInFlight) {
    tab.previewStale = true;
    return;
  }
  tab.previewInFlight = true;
  tab.previewStale = false;
  const seq = ++tab.previewSeq;

  try {
    const source = tab.editor.getValue();
    const doc = await tauri.core.invoke("render_markdown", { source, basePath: tab.path });
    if (seq !== tab.previewSeq) return;

    tab.headings = doc.headings;
    tab.hasMermaid = doc.has_mermaid;
    tab.hasMath = doc.has_math;
    tab.contentEl.innerHTML = doc.html;
    rewriteImageSources(tab.contentEl);

    const isActive = state.tabs[state.activeIndex] === tab;
    if (isActive) updateToc(tab);

    // Must not run against a hidden subtree — activateTab's previewNeedsEnrich picks it
    // up on the next activation instead.
    if (isActive) {
      if (tab.hasMermaid) await renderMermaidFor(tab);
      if (tab.hasMath) await renderMathFor(tab.contentEl);
      tab.previewNeedsEnrich = false;
    } else {
      tab.previewNeedsEnrich = tab.hasMermaid || tab.hasMath;
    }
  } catch (err) {
    console.error("preview render failed", err);
  } finally {
    tab.previewInFlight = false;
    if (tab.previewStale) schedulePreview(tab);
  }
}
