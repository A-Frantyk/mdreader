// Table-of-contents rendering and scroll-spying for the active tab.

let stopTocTracking = null;

function disconnectToc() {
  stopTocTracking?.();
  stopTocTracking = null;
}

function tocScrollTop(link) {
  const sidebar = els.sidebar;
  const height = sidebar.clientHeight;
  if (height <= 0) return sidebar.scrollTop;
  const top = sidebar.getBoundingClientRect().top + sidebar.clientTop;
  const rect = link.getBoundingClientRect();
  let delta = 0;
  if (rect.height > height || rect.top < top) {
    delta = rect.top - top;
  } else if (rect.bottom > top + height) {
    delta = rect.bottom - (top + height);
  }
  return Math.max(0, Math.min(sidebar.scrollHeight - height, sidebar.scrollTop + delta));
}

function updateToc(tab) {
  disconnectToc();
  els.toc.innerHTML = "";
  if (!tab.headings.length) {
    els.sidebar.classList.add("hidden");
    return;
  }
  els.sidebar.classList.remove("hidden");

  const headings = [];
  tab.headings.forEach((h) => {
    const a = document.createElement("a");
    a.href = `#${h.id}`;
    a.className = `level-${h.level}`;
    a.textContent = h.text;
    els.toc.appendChild(a);
    const heading = tab.contentEl.querySelector(`#${CSS.escape(h.id)}`);
    if (heading) headings.push({ heading, link: a });
  });
  if (!headings.length) return;

  let activeLink = null;
  let frame = 0;
  let reveal = false;
  let stopped = false;
  const preview = tab.previewEl;

  const update = () => {
    frame = 0;
    if (stopped || state.tabs[state.activeIndex] !== tab || preview.clientHeight <= 0) return;
    const readingLine = preview.getBoundingClientRect().top
      + preview.clientTop + preview.clientHeight * 0.3;
    const maxScroll = preview.scrollHeight - preview.clientHeight;
    let current = headings[0];
    if (maxScroll > 0 && preview.scrollTop >= maxScroll - 1) {
      current = headings[headings.length - 1];
    } else {
      for (const item of headings) {
        if (item.heading.getBoundingClientRect().top <= readingLine) current = item;
      }
    }

    const changed = current.link !== activeLink;
    const scrollTop = reveal || changed ? tocScrollTop(current.link) : els.sidebar.scrollTop;
    reveal = false;
    if (changed) {
      activeLink?.classList.remove("active");
      activeLink?.removeAttribute("aria-current");
      activeLink = current.link;
      activeLink.classList.add("active");
      activeLink.setAttribute("aria-current", "location");
    }
    if (els.sidebar.scrollTop !== scrollTop) els.sidebar.scrollTop = scrollTop;
  };

  const schedule = (shouldReveal) => {
    if (stopped) return;
    reveal ||= shouldReveal;
    if (!frame) frame = requestAnimationFrame(update);
  };
  const onScroll = () => schedule(true);
  const observer = new ResizeObserver(() => schedule(false));
  preview.addEventListener("scroll", onScroll, { passive: true });
  observer.observe(preview);
  observer.observe(tab.contentEl);
  stopTocTracking = () => {
    stopped = true;
    preview.removeEventListener("scroll", onScroll);
    observer.disconnect();
    cancelAnimationFrame(frame);
  };
  schedule(true);
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
