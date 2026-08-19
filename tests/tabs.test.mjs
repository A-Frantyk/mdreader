// The tab lifecycle: creation, activation, dirty tracking, and the
// identity-based re-resolution closeTab/confirmClosable rely on to stay
// correct when a modal await lets the tab bar change out from under a
// stale index.
import test from "node:test";
import assert from "node:assert/strict";
import { freshApp } from "./harness.mjs";

test("createTabShell", async (t) => {
  await t.test("returns the documented 24-field tab shape", () => {
    const { window } = freshApp();
    const tab = window.createTabShell({});
    assert.equal(Object.keys(tab).length, 24);
    assert.equal(tab.kind, "document");
    assert.equal(tab.path, null);
    assert.equal(tab.mode, "view");
    assert.equal(tab.dirty, false);
    assert.equal(tab.rendered, false);
  });

  await t.test("appends the pane to #content-wrap but does not push onto state.tabs", () => {
    const { window, app } = freshApp();
    const before = app.els.contentWrap.querySelectorAll(".tab-pane").length;
    window.createTabShell({});
    assert.equal(app.els.contentWrap.querySelectorAll(".tab-pane").length, before + 1);
    assert.equal(app.state.tabs.length, 0);
  });

  await t.test("overrides are applied on top of the defaults", () => {
    const { window } = freshApp();
    const tab = window.createTabShell({ path: "/a/b.md", title: "b.md" });
    assert.equal(tab.path, "/a/b.md");
    assert.equal(tab.title, "b.md");
  });
});

test("activateTab", async (t) => {
  await t.test("toggles .visible onto only the activated pane and updates activeIndex", async () => {
    const { window, app } = freshApp();
    const a = window.createTabShell({});
    const b = window.createTabShell({});
    app.state.tabs.push(a, b);

    await window.activateTab(1);
    assert.equal(app.state.activeIndex, 1);
    assert.equal(a.paneEl.classList.contains("visible"), false);
    assert.equal(b.paneEl.classList.contains("visible"), true);

    await window.activateTab(0);
    assert.equal(app.state.activeIndex, 0);
    assert.equal(a.paneEl.classList.contains("visible"), true);
    assert.equal(b.paneEl.classList.contains("visible"), false);
  });

  await t.test("index -1 (no tabs) shows the empty state and clears the TOC", async () => {
    const { window, app } = freshApp();
    await window.activateTab(-1);
    assert.equal(app.els.emptyState.style.display, "flex");
    assert.equal(app.els.toc.innerHTML, "");
  });

  await t.test("the edit button is gated on kind === 'document' AND path !== null", async () => {
    const { window, app } = freshApp();
    const welcome = window.createTabShell({ kind: "welcome", path: null });
    const unsaved = window.createTabShell({ kind: "document", path: null });
    const saved = window.createTabShell({ kind: "document", path: "/a/b.md" });
    app.state.tabs.push(welcome, unsaved, saved);

    await window.activateTab(0);
    assert.equal(app.els.editToggleBtn.disabled, true, "a welcome tab must not be editable");
    await window.activateTab(1);
    assert.equal(app.els.editToggleBtn.disabled, true, "an unsaved document tab must not show the edit button");
    await window.activateTab(2);
    assert.equal(app.els.editToggleBtn.disabled, false, "a saved document tab must be editable");
  });
});

test("renderTabBar", async (t) => {
  await t.test("shows a dirty dot only for dirty tabs, and one close button per tab", () => {
    const { window, app } = freshApp();
    const clean = window.createTabShell({ title: "clean.md" });
    const dirty = window.createTabShell({ title: "dirty.md", dirty: true });
    app.state.tabs.push(clean, dirty);

    window.renderTabBar();

    const rows = app.els.tabbar.querySelectorAll(".tab");
    assert.equal(rows.length, 2);
    assert.equal(rows[0].querySelector(".tab-dirty"), null);
    assert.notEqual(rows[1].querySelector(".tab-dirty"), null);
    assert.equal(app.els.tabbar.querySelectorAll(".tab-close").length, 2);
  });
});

test("markDirty", async (t) => {
  await t.test("does nothing when the value is unchanged (avoids a full re-render per keystroke)", () => {
    const { window, app } = freshApp();
    const tab = window.createTabShell({ dirty: false });
    app.state.tabs.push(tab);

    let renderCalls = 0;
    window.renderTabBar = () => {
      renderCalls++;
    };

    window.markDirty(tab, false); // already false
    assert.equal(renderCalls, 0);

    window.markDirty(tab, true); // real change
    assert.equal(renderCalls, 1);
    assert.equal(tab.dirty, true);

    window.markDirty(tab, true); // already true now
    assert.equal(renderCalls, 1);
  });
});

test("closeTab", async (t) => {
  await t.test("re-resolves which tab to close by identity, not by the stale index argument", async () => {
    // Simulates the exact race closeTab's own comment describes: while
    // closeTab(1) (intending to close `b`) is awaiting confirmClosable,
    // something else closes `a` first — shifting b from index 1 to 0. A
    // version that trusted the original `index` would splice out `c`
    // instead.
    const { window, app } = freshApp();
    const a = window.createTabShell({ title: "a" });
    const b = window.createTabShell({ title: "b" });
    const c = window.createTabShell({ title: "c" });
    app.state.tabs.push(a, b, c);

    window.confirmClosable = async () => {
      app.state.tabs.splice(app.state.tabs.indexOf(a), 1); // remove `a` mid-await
      return true;
    };

    await window.closeTab(1);

    // Compared by length + reference (not deepEqual) — state.tabs is an
    // array built inside jsdom's realm, and deepStrictEqual treats a
    // same-shaped array from a different realm as unequal regardless of
    // element identity.
    assert.equal(app.state.tabs.length, 1);
    assert.equal(app.state.tabs[0], c);
  });

  await t.test("a declined confirmation leaves the tab in place", async () => {
    const { window, app } = freshApp();
    const tab = window.createTabShell({ dirty: true });
    app.state.tabs.push(tab);
    window.confirmClosable = async () => false;

    await window.closeTab(0);

    assert.equal(app.state.tabs.length, 1);
  });
});

test("confirmClosable", async (t) => {
  await t.test("a clean tab closes immediately with no modal", async () => {
    const { window } = freshApp();
    const tab = window.createTabShell({ dirty: false });
    let confirmUnsavedCalled = false;
    window.confirmUnsaved = async () => {
      confirmUnsavedCalled = true;
      return "cancel";
    };

    const result = await window.confirmClosable(tab);

    assert.equal(result, true);
    assert.equal(confirmUnsavedCalled, false);
  });

  await t.test("'cancel' resolves false", async () => {
    const { window, app } = freshApp();
    const tab = window.createTabShell({ dirty: true });
    app.state.tabs.push(tab);
    window.confirmUnsaved = async () => "cancel";

    assert.equal(await window.confirmClosable(tab), false);
  });

  await t.test("'dont-save' resolves true without saving", async () => {
    const { window, app } = freshApp();
    const tab = window.createTabShell({ dirty: true });
    app.state.tabs.push(tab);
    window.confirmUnsaved = async () => "dont-save";
    let saveTabCalled = false;
    window.saveTab = async () => {
      saveTabCalled = true;
      return true;
    };

    assert.equal(await window.confirmClosable(tab), true);
    assert.equal(saveTabCalled, false);
  });

  await t.test("'save' defers to saveTab's own success/failure", async () => {
    const { window, app } = freshApp();
    const tab = window.createTabShell({ dirty: true });
    app.state.tabs.push(tab);
    window.confirmUnsaved = async () => "save";

    window.saveTab = async () => true;
    assert.equal(await window.confirmClosable(tab), true);

    window.saveTab = async () => false; // e.g. the save dialog was cancelled
    assert.equal(await window.confirmClosable(tab), false);
  });

  await t.test("closeConfirmPending guards against a second concurrent call", async () => {
    const { window, app } = freshApp();
    const tab = window.createTabShell({ dirty: true, closeConfirmPending: true });
    app.state.tabs.push(tab);
    let confirmUnsavedCalled = false;
    window.confirmUnsaved = async () => {
      confirmUnsavedCalled = true;
      return "dont-save";
    };

    assert.equal(await window.confirmClosable(tab), false);
    assert.equal(confirmUnsavedCalled, false);
  });
});

test("handleMenuAction", async (t) => {
  await t.test("dispatches each menu id to its corresponding action", () => {
    const { window, app } = freshApp();
    const calls = [];
    window.newWelcomeTab = () => calls.push("new");
    window.openFileDialog = () => calls.push("open");
    window.saveTab = () => calls.push("save");
    window.requestQuit = () => calls.push("quit");
    window.stepZoom = (direction) => calls.push(`step-zoom:${direction}`);
    window.resetZoom = () => calls.push("reset-zoom");

    for (const id of ["new", "open", "save", "quit", "zoom-in", "zoom-out", "zoom-reset"]) {
      window.handleMenuAction(id);
    }
    assert.deepEqual(calls, [
      "new",
      "open",
      "save",
      "quit",
      "step-zoom:1",
      "step-zoom:-1",
      "reset-zoom",
    ]);
  });

  await t.test("does nothing for an unrecognized id", () => {
    const { window } = freshApp();
    assert.doesNotThrow(() => window.handleMenuAction("bogus"));
  });

  await t.test("short-circuits every branch while the unsaved-changes modal is open", () => {
    const { window, app } = freshApp();
    let called = false;
    window.newWelcomeTab = () => {
      called = true;
    };
    app.modalOpen = true;

    window.handleMenuAction("new");

    assert.equal(called, false);
  });
});
