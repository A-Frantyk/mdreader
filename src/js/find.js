// In-page find, implemented by walking and marking text nodes (no native find API in the webview).

// The webview exposes no scriptable native find, so this walks the
// active tab's text nodes and wraps matches in <mark>.
function activeRoot() {
  return state.tabs[state.activeIndex]?.contentEl ?? null;
}

function openFind() {
  const root = activeRoot();
  if (!root) return;
  els.findbar.classList.add("visible");
  els.findInput.focus();
  els.findInput.select();
  if (els.findInput.value) runFind(els.findInput.value);
}

function closeFind() {
  els.findbar.classList.remove("visible");
  const root = activeRoot();
  if (root) clearMarks(root);
  find.currentIndex = -1;
  els.findCount.textContent = "";
}

function clearMarks(root) {
  const marks = root.querySelectorAll("mark.find-hit");
  const parents = new Set();
  marks.forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parents.add(parent);
  });
  // normalize() walks its whole subtree — once per unique parent instead
  // of once per mark, so clearing 500 hits under one container is O(1)
  // subtree walks, not O(500).
  parents.forEach((p) => p.normalize());
}

function runFind(query) {
  const root = activeRoot();
  if (!root) return;
  clearMarks(root);
  find.currentIndex = -1;
  if (!query) {
    els.findCount.textContent = "";
    return;
  }

  const needle = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(needle)) {
        return NodeFilter.FILTER_SKIP;
      }
      const tag = node.parentElement?.tagName;
      return tag === "SCRIPT" || tag === "STYLE" ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNodes = [];
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);

  textNodes.forEach((node) => {
    const text = node.nodeValue;
    const lower = text.toLowerCase();
    let start = 0;
    let idx;
    const frag = document.createDocumentFragment();
    while ((idx = lower.indexOf(needle, start)) !== -1) {
      if (idx > start) frag.appendChild(document.createTextNode(text.slice(start, idx)));
      const mark = document.createElement("mark");
      mark.className = "find-hit";
      mark.textContent = text.slice(idx, idx + needle.length);
      frag.appendChild(mark);
      start = idx + needle.length;
    }
    if (start < text.length) frag.appendChild(document.createTextNode(text.slice(start)));
    node.parentNode.replaceChild(frag, node);
  });

  if (root.querySelector("mark.find-hit")) {
    find.currentIndex = 0;
    highlightCurrentMark(root, { smooth: false });
  } else {
    els.findCount.textContent = "0/0";
  }
}

function highlightCurrentMark(root, { smooth = true } = {}) {
  const marks = root.querySelectorAll("mark.find-hit");
  marks.forEach((m) => m.classList.remove("current"));
  const mark = marks[find.currentIndex];
  if (!mark) return;
  mark.classList.add("current");
  mark.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
  els.findCount.textContent = `${find.currentIndex + 1}/${marks.length}`;
}

function stepMatch(delta) {
  const root = activeRoot();
  if (!root) return;
  const count = root.querySelectorAll("mark.find-hit").length;
  if (!count) return;
  find.currentIndex = (find.currentIndex + delta + count) % count;
  highlightCurrentMark(root);
}
