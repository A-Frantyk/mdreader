// Find-in-document: a hand-rolled TreeWalker-based highlighter (no
// selection API, no browser find-in-page) — runFind/clearMarks/stepMatch
// are the whole implementation and were completely unexercised before
// this suite.
import test from "node:test";
import assert from "node:assert/strict";
import { freshApp } from "./harness.mjs";

function activate({ window, app }, html) {
  const tab = window.createTabShell({});
  tab.contentEl.innerHTML = html;
  app.state.tabs.push(tab);
  app.state.activeIndex = 0;
  return tab;
}

test("runFind", async (t) => {
  await t.test("matches case-insensitively", () => {
    const { window, app } = freshApp();
    activate({ window, app }, "<p>Hello World</p>");
    window.runFind("world");
    assert.equal(app.els.contentWrap.querySelectorAll("mark.find-hit").length, 1);
    assert.equal(app.els.contentWrap.querySelector("mark.find-hit").textContent, "World");
  });

  await t.test("finds multiple hits within one text node and reports a running count", () => {
    const { window, app } = freshApp();
    activate({ window, app }, "<p>cat cat cat</p>");
    window.runFind("cat");
    const marks = app.els.contentWrap.querySelectorAll("mark.find-hit");
    assert.equal(marks.length, 3);
    assert.equal(app.els.findCount.textContent, "1/3");
  });

  await t.test("finds hits across sibling elements", () => {
    const { window, app } = freshApp();
    activate({ window, app }, "<p>first needle</p><p>second needle</p>");
    window.runFind("needle");
    assert.equal(app.els.contentWrap.querySelectorAll("mark.find-hit").length, 2);
  });

  await t.test("never matches inside a SCRIPT or STYLE subtree", () => {
    const { window, app } = freshApp();
    activate(
      { window, app },
      "<p>visible needle</p><script>var needle = 1;</script><style>.needle { color: red; }</style>"
    );
    window.runFind("needle");
    assert.equal(app.els.contentWrap.querySelectorAll("mark.find-hit").length, 1);
    assert.equal(app.els.contentWrap.querySelector("script mark, style mark"), null);
  });

  await t.test("a query matching nothing reports 0/0 and leaves no marks", () => {
    const { window, app } = freshApp();
    activate({ window, app }, "<p>hello world</p>");
    window.runFind("xyz");
    assert.equal(app.els.contentWrap.querySelectorAll("mark.find-hit").length, 0);
    assert.equal(app.els.findCount.textContent, "0/0");
  });

  await t.test("a match spanning an element boundary is not found", () => {
    // "**bo**ld" renders as <strong>bo</strong>ld — "bo" and "ld" are two
    // separate text nodes, and runFind walks node-by-node, so "bold"
    // matches neither individually.
    const { window, app } = freshApp();
    activate({ window, app }, "<p><strong>bo</strong>ld</p>");
    window.runFind("bold");
    assert.equal(app.els.contentWrap.querySelectorAll("mark.find-hit").length, 0);
  });

  await t.test("an empty query clears without erroring", () => {
    const { window, app } = freshApp();
    activate({ window, app }, "<p>hello world</p>");
    window.runFind("world");
    assert.equal(app.els.contentWrap.querySelectorAll("mark.find-hit").length, 1);
    window.runFind("");
    assert.equal(app.els.contentWrap.querySelectorAll("mark.find-hit").length, 0);
    assert.equal(app.els.findCount.textContent, "");
  });
});

test("clearMarks", async (t) => {
  await t.test("restores the DOM to its original innerHTML (normalize merges split text nodes)", () => {
    const { window, app } = freshApp();
    const tab = activate({ window, app }, "<p>cat cat cat</p>");
    const original = tab.contentEl.innerHTML;
    window.runFind("cat");
    assert.notEqual(tab.contentEl.innerHTML, original);
    window.clearMarks(tab.contentEl);
    assert.equal(tab.contentEl.innerHTML, original);
  });

  await t.test("a second search after clearing still finds every hit", () => {
    // Guards against clearMarks leaving adjacent text nodes split —
    // an un-normalized DOM would make a later cross-boundary query miss.
    const { window, app } = freshApp();
    const tab = activate({ window, app }, "<p>cat cat cat</p>");
    window.runFind("cat");
    window.clearMarks(tab.contentEl);
    window.runFind("cat cat");
    assert.equal(app.els.contentWrap.querySelectorAll("mark.find-hit").length, 1);
  });
});

test("stepMatch", async (t) => {
  await t.test("steps forward and wraps past the last match", () => {
    const { window, app } = freshApp();
    activate({ window, app }, "<p>cat cat cat</p>");
    window.runFind("cat"); // currentIndex = 0
    window.stepMatch(1);
    assert.equal(app.find.currentIndex, 1);
    window.stepMatch(1);
    assert.equal(app.find.currentIndex, 2);
    window.stepMatch(1); // wraps
    assert.equal(app.find.currentIndex, 0);
  });

  await t.test("steps backward and wraps before the first match", () => {
    const { window, app } = freshApp();
    activate({ window, app }, "<p>cat cat cat</p>");
    window.runFind("cat"); // currentIndex = 0
    window.stepMatch(-1);
    assert.equal(app.find.currentIndex, 2);
  });
});
