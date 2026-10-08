// Outline section tracking, sidebar geometry, and active-preview lifecycle.
import test from "node:test";
import assert from "node:assert/strict";
import { freshApp, fakeCm } from "./harness.mjs";

function dimensions(element, values) {
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(element, key, { configurable: true, writable: true, value });
  }
}

function rect(top, height) {
  return { top, bottom: top + height, height };
}

function setup(t) {
  const env = freshApp();
  const { window, document, app } = env;
  const frames = new Map();
  const observers = [];
  let nextFrame = 0;
  window.requestAnimationFrame = (callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  window.cancelAnimationFrame = (id) => frames.delete(id);
  window.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      observers.push(this);
    }
    observe(target) { this.targets.add(target); }
    disconnect() { this.targets.clear(); }
  };
  t.after(() => {
    window.disconnectToc();
    window.close();
  });

  const sidebar = app.els.sidebar;
  dimensions(sidebar, { clientTop: 2, clientHeight: 100, scrollHeight: 2000 });
  sidebar.getBoundingClientRect = () => rect(100, sidebar.clientHeight + 4);
  const rowHeights = [];

  function measureHeadings(tab, positions) {
    [...tab.contentEl.querySelectorAll("h1,h2,h3,h4,h5,h6")].forEach((heading, i) => {
      heading.getBoundingClientRect = () => rect(82 + positions[i] - tab.previewEl.scrollTop, 30);
    });
  }

  function addTab({ positions = [200, 800, 1600, 3000], ids, mode = "view" } = {}) {
    const headings = positions.map((_, i) => ({
      id: ids?.[i] ?? `section-${i}`,
      text: `Section ${i}`,
      level: i % 6 + 1,
    }));
    const tab = window.createTabShell({ headings, mode, rendered: true });
    for (const heading of headings) {
      const element = document.createElement(`h${heading.level}`);
      element.id = heading.id;
      element.textContent = heading.text;
      tab.contentEl.appendChild(element);
    }
    dimensions(tab.previewEl, { clientTop: 2, clientHeight: 500, scrollHeight: 5000 });
    tab.previewEl.getBoundingClientRect = () => rect(80, tab.previewEl.clientHeight + 4);
    measureHeadings(tab, positions);
    app.state.tabs.push(tab);
    return tab;
  }

  function flush() {
    let offset = 24;
    [...app.els.toc.children].forEach((link, i) => {
      const top = offset;
      const height = rowHeights[i] ?? 25;
      link.getBoundingClientRect = () => rect(102 + top - sidebar.scrollTop, height);
      offset += height;
    });
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback());
  }

  function show(tab) {
    app.state.activeIndex = app.state.tabs.indexOf(tab);
    window.updateToc(tab);
    flush();
  }

  function scroll(tab, top) {
    tab.previewEl.scrollTop = top;
    tab.previewEl.dispatchEvent(new window.Event("scroll"));
    flush();
  }

  function active(id) {
    assert.equal(app.els.toc.querySelectorAll("a.active").length, 1);
    assert.equal(app.els.toc.querySelectorAll('[aria-current="location"]').length, 1);
    assert.equal(app.els.toc.querySelector("a.active").getAttribute("href"), `#${id}`);
    assert.equal(app.els.toc.querySelector("a.active").getAttribute("aria-current"), "location");
  }

  function resize() {
    for (const observer of observers) {
      if (observer.targets.size) observer.callback([]);
    }
    flush();
  }

  return {
    ...env, frames, observers, sidebar, rowHeights,
    addTab, measureHeadings, flush, show, scroll, active, resize,
  };
}

test("tracks the 30% reading line through forward, reverse, and large scroll jumps", (t) => {
  const r = setup(t);
  const tab = r.addTab();
  r.show(tab);
  r.active("section-0");
  for (const [top, id] of [
    [649, 0], [650, 1], [1200, 1], [2900, 3], [1500, 2], [500, 0],
  ]) {
    r.scroll(tab, top);
    r.active(`section-${id}`);
  }
});

test("selects the last of nearby headings in document order", (t) => {
  const r = setup(t);
  const tab = r.addTab({ positions: [0, 50, 100, 150, 151] });
  r.show(tab);
  r.active("section-3");
  r.scroll(tab, 1);
  r.active("section-4");
});

test("handles the bottom tolerance without misclassifying a non-scrollable document", (t) => {
  const r = setup(t);
  const tab = r.addTab({ positions: [0, 4800] });
  r.show(tab);
  r.scroll(tab, 4498);
  r.active("section-0");
  r.scroll(tab, 4499.5);
  r.active("section-1");
  tab.previewEl.scrollHeight = tab.previewEl.clientHeight;
  r.scroll(tab, 0);
  r.active("section-0");
});

test("supports escaped IDs, nested heading levels, and missing targets", (t) => {
  const r = setup(t);
  const tab = r.addTab({ positions: [0, 100, 800], ids: ["1:a.b", "missing", "last"] });
  tab.contentEl.children[1].remove();
  r.show(tab);
  r.active("1:a.b");
  assert.equal(r.app.els.toc.children[2].className, "level-3");
  r.scroll(tab, 650);
  r.active("last");
  tab.contentEl.replaceChildren();
  r.window.updateToc(tab);
  r.flush();
  assert.equal(r.app.els.toc.querySelector("a.active"), null);
  assert.equal(r.observers.filter((o) => o.targets.size).length, 0);
});

test("reveals clipped entries by the minimum distance without moving other panes or focus", (t) => {
  const r = setup(t);
  const tab = r.addTab();
  r.show(tab);
  const focused = r.document.getElementById("open-file-btn-main");
  focused.focus();
  r.sidebar.scrollLeft = 7;
  tab.previewEl.scrollLeft = 9;
  r.app.els.contentWrap.scrollTop = 11;
  r.scroll(tab, 1500);
  assert.equal(r.sidebar.scrollTop, 0, "row ends at 99 and is already visible");
  r.scroll(tab, 2900);
  assert.equal(r.sidebar.scrollTop, 24, "row ends at 124 in a 100px viewport");
  r.sidebar.scrollTop = 90;
  r.scroll(tab, 650);
  assert.equal(r.sidebar.scrollTop, 49, "align the second row's top");
  assert.equal(tab.previewEl.scrollTop, 650);
  assert.equal(tab.previewEl.scrollLeft, 9);
  assert.equal(r.sidebar.scrollLeft, 7);
  assert.equal(r.app.els.contentWrap.scrollTop, 11);
  assert.equal(r.window.scrollY, 0);
  assert.equal(r.document.activeElement, focused);
});

test("clamps sidebar scrolling and keeps oversized wrapped entries stable", (t) => {
  const r = setup(t);
  const tab = r.addTab();
  r.rowHeights[0] = 150;
  r.show(tab);
  assert.equal(r.sidebar.scrollTop, 24);
  r.scroll(tab, 10);
  assert.equal(r.sidebar.scrollTop, 24);
  r.sidebar.scrollTop = 50;
  r.scroll(tab, 20);
  assert.equal(r.sidebar.scrollTop, 24);
  r.sidebar.scrollHeight = 110;
  r.scroll(tab, 2900);
  assert.equal(r.sidebar.scrollTop, 10);
  r.sidebar.scrollHeight = 80;
  r.scroll(tab, 0);
  assert.equal(r.sidebar.scrollTop, 0);
});

test("leaves manual Outline scrolling alone until the next document scroll", (t) => {
  const r = setup(t);
  const tab = r.addTab();
  r.show(tab);
  r.scroll(tab, 2900);
  r.sidebar.scrollTop = 0;
  r.sidebar.dispatchEvent(new r.window.Event("scroll"));
  assert.equal(r.frames.size, 0);
  r.resize();
  assert.equal(r.sidebar.scrollTop, 0, "same-section layout updates must not override browsing");
  r.scroll(tab, 2901);
  assert.equal(r.sidebar.scrollTop, 24, "same-section document scroll resumes following");
});

test("coalesces scroll bursts, retains Outline nodes, and preserves pending reveal on resize", (t) => {
  const r = setup(t);
  const tab = r.addTab();
  r.show(tab);
  const links = [...r.app.els.toc.children];
  tab.previewEl.scrollTop = 2900;
  for (let i = 0; i < 20; i++) tab.previewEl.dispatchEvent(new r.window.Event("scroll"));
  r.observers[0].callback([]);
  assert.equal(r.frames.size, 1);
  r.flush();
  r.active("section-3");
  assert.equal(r.sidebar.scrollTop, 24);
  assert.deepEqual([...r.app.els.toc.children], links);
});

test("recalculates after preview/content reflow and skips hidden geometry", (t) => {
  const r = setup(t);
  const tab = r.addTab();
  r.show(tab);
  assert.deepEqual([...r.observers[0].targets], [tab.previewEl, tab.contentEl]);
  r.scroll(tab, 650);
  r.active("section-1");
  r.measureHeadings(tab, [200, 1400, 2000, 3500]);
  r.resize();
  r.active("section-0");
  tab.previewEl.clientHeight = 2600;
  r.resize();
  r.active("section-1");
  tab.previewEl.clientHeight = 0;
  tab.contentEl.firstChild.getBoundingClientRect = () => assert.fail("measured a hidden heading");
  r.resize();
  r.active("section-1");
});

test("switching tabs uses restored scroll positions and invalidates old callbacks", async (t) => {
  const r = setup(t);
  const a = r.addTab();
  const b = r.addTab({ ids: ["b0", "b1", "b2", "b3"] });
  r.show(a);
  a.previewEl.dispatchEvent(new r.window.Event("scroll"));
  const staleFrame = [...r.frames.values()][0];
  const staleObserver = r.observers[0];
  b.previewEl.scrollTop = 1500;
  await r.window.activateTab(1);
  r.flush();
  r.active("b2");
  assert.equal(staleObserver.targets.size, 0);
  staleObserver.callback([]);
  staleFrame();
  a.previewEl.dispatchEvent(new r.window.Event("scroll"));
  assert.equal(r.frames.size, 0);
  r.active("b2");
  a.previewEl.scrollTop = 2900;
  await r.window.activateTab(0);
  r.flush();
  r.active("section-3");
});

test("rebuilds remove old listeners and closing the last tab cancels pending work", async (t) => {
  const r = setup(t);
  const tab = r.addTab();
  const listeners = new Set();
  const add = tab.previewEl.addEventListener.bind(tab.previewEl);
  const remove = tab.previewEl.removeEventListener.bind(tab.previewEl);
  tab.previewEl.addEventListener = (type, callback, options) => {
    if (type === "scroll") {
      assert.equal(options.passive, true);
      listeners.add(callback);
    }
    add(type, callback, options);
  };
  tab.previewEl.removeEventListener = (type, callback) => {
    if (type === "scroll") listeners.delete(callback);
    remove(type, callback);
  };
  for (let i = 0; i < 5; i++) r.show(tab);
  assert.equal(listeners.size, 1);
  assert.equal(r.observers.filter((o) => o.targets.size).length, 1);
  tab.previewEl.dispatchEvent(new r.window.Event("scroll"));
  await r.window.closeTab(0);
  r.flush();
  assert.equal(listeners.size, 0);
  assert.equal(r.frames.size, 0);
  assert.equal(r.observers.filter((o) => o.targets.size).length, 0);
  assert.equal(r.app.els.toc.children.length, 0);
  assert.equal(r.app.els.sidebar.classList.contains("hidden"), true);
});

test("live preview replaces headings, tracks split-preview scrolling, and hides an empty Outline", async (t) => {
  const r = setup(t);
  const tab = r.addTab({ mode: "split" });
  tab.editor = fakeCm("# Updated");
  const editorPane = r.document.createElement("div");
  tab.paneEl.appendChild(editorPane);
  r.show(tab);
  const oldObserver = r.observers[0];
  r.tauri.core.invoke = async () => ({
    html: '<h1 id="updated">Updated</h1><h2 id="later">Later</h2>',
    headings: [{ id: "updated", level: 1, text: "Updated" }, { id: "later", level: 2, text: "Later" }],
    has_mermaid: false, has_math: false,
  });
  await r.window.runPreview(tab);
  r.measureHeadings(tab, [0, 800]);
  r.flush();
  r.active("updated");
  assert.equal(oldObserver.targets.size, 0);
  editorPane.scrollTop = 650;
  editorPane.dispatchEvent(new r.window.Event("scroll"));
  assert.equal(r.frames.size, 0);
  r.active("updated");
  r.scroll(tab, 650);
  r.active("later");
  assert.equal(editorPane.scrollTop, 650);
  r.tauri.core.invoke = async () => ({ html: "<p>No headings</p>", headings: [] });
  await r.window.runPreview(tab);
  r.flush();
  assert.equal(r.app.els.toc.children.length, 0);
  assert.equal(r.sidebar.classList.contains("hidden"), true);
  assert.equal(r.observers.filter((o) => o.targets.size).length, 0);
});

test("background live previews leave the active Outline intact and attach on activation", async (t) => {
  const r = setup(t);
  const a = r.addTab();
  const b = r.addTab({ mode: "split" });
  b.editor = fakeCm("# Background");
  b.editor.refresh = () => {};
  r.show(a);
  r.tauri.core.invoke = async () => ({
    html: '<h1 id="background">Background</h1>',
    headings: [{ id: "background", level: 1, text: "Background" }],
    has_mermaid: true, has_math: true,
  });
  let enrichments = 0;
  r.window.renderMermaidFor = async () => { enrichments++; };
  r.window.renderMathFor = async () => { enrichments++; };
  await r.window.runPreview(b);
  r.flush();
  r.active("section-0");
  assert.equal(enrichments, 0);
  assert.equal(b.previewNeedsEnrich, true);
  await r.window.activateTab(1);
  r.measureHeadings(b, [0]);
  r.resize();
  r.active("background");
  assert.equal(enrichments, 2);
});

test("Outline clicks retain smooth heading navigation without changing keyboard focus", (t) => {
  const r = setup(t);
  const tab = r.addTab({ ids: ["a:b", "other", "third", "last"] });
  r.show(tab);
  let options;
  tab.contentEl.firstChild.scrollIntoView = (value) => { options = value; };
  const link = r.app.els.toc.firstChild;
  link.focus();
  const event = new r.window.MouseEvent("click", { bubbles: true, cancelable: true });
  link.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(options.behavior, "smooth");
  assert.equal(options.block, "start");
  assert.equal(r.document.activeElement, link);
});
