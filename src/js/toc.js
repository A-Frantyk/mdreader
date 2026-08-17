// Table-of-contents rendering and scroll-spying for the active tab.

let tocObserver = null;

function updateToc(tab) {
  tocObserver?.disconnect();
  els.toc.innerHTML = "";
  if (!tab.headings.length) {
    els.sidebar.classList.add("hidden");
    return;
  }
  els.sidebar.classList.remove("hidden");

  const linkById = new Map();
  tab.headings.forEach((h) => {
    const a = document.createElement("a");
    a.href = `#${h.id}`;
    a.className = `level-${h.level}`;
    a.textContent = h.text;
    els.toc.appendChild(a);
    linkById.set(h.id, a);
  });

  // One observer, re-pointed at the active tab's headings on every
  // switch, rather than a fresh one per render — tabs' content elements
  // persist for the app's lifetime, so a per-render observer would never
  // get disconnected and would accumulate one per switch.
  tocObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const link = linkById.get(entry.target.id);
        if (link && entry.isIntersecting) {
          els.toc.querySelectorAll("a.active").forEach((el) => el.classList.remove("active"));
          link.classList.add("active");
        }
      });
    },
    // Root is this tab's own scroll container, not the shared
    // #content-wrap — each tab scrolls independently now that a split
    // pane can exist (see the .preview-scroll comment in styles.css).
    { root: tab.previewEl, rootMargin: "0px 0px -70% 0px", threshold: 0 }
  );
  tab.headings.forEach((h) => {
    const heading = tab.contentEl.querySelector(`#${CSS.escape(h.id)}`);
    if (heading) tocObserver.observe(heading);
  });
}

els.toc.addEventListener("click", (e) => {
  const a = e.target.closest("a[href^='#']");
  if (!a) return;
  e.preventDefault();
  const tab = state.tabs[state.activeIndex];
  tab?.contentEl.querySelector(`#${CSS.escape(a.getAttribute("href").slice(1))}`)?.scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
});
