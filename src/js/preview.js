// Debounced live-preview re-rendering while editing.

const PREVIEW_DEBOUNCE_MS = 200;

function schedulePreview(tab) {
  clearTimeout(tab.previewTimer);
  tab.previewTimer = setTimeout(() => runPreview(tab), PREVIEW_DEBOUNCE_MS);
}

/// Re-renders `tab`'s preview from the editor's current value. At most
/// one `render_markdown` call in flight per tab — a change that lands
/// mid-render doesn't queue a second invoke, it sets `previewStale` and
/// this re-fires itself once the in-flight one resolves. A `previewSeq`
/// counter guards against applying a response that's been superseded by
/// a newer one that happened to resolve first (async commands can
/// complete out of order).
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

    // Mermaid/KaTeX must not run against a hidden subtree — if the tab
    // isn't visible, skip and let activateTab's previewNeedsEnrich check
    // catch it on the next activation instead.
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
