import test from "node:test";
import assert from "node:assert/strict";
import { freshApp } from "./harness.mjs";

function recentPaths(window) {
  return structuredClone(window.readRecentFiles());
}

test("recent file storage", async (t) => {
  await t.test("returns an empty list for absent, malformed, or non-array storage", () => {
    const { window, app } = freshApp();
    assert.deepEqual(recentPaths(window), []);

    window.localStorage.setItem(app.RECENT_FILES_KEY, "{bad json");
    assert.deepEqual(recentPaths(window), []);

    window.localStorage.setItem(app.RECENT_FILES_KEY, JSON.stringify({ path: "/a.md" }));
    assert.deepEqual(recentPaths(window), []);
  });

  await t.test("filters invalid entries, deduplicates, and caps stored paths", () => {
    const { window, app } = freshApp();
    window.localStorage.setItem(
      app.RECENT_FILES_KEY,
      JSON.stringify(["/a.md", "", null, "/a.md", "/b.md", "/c.md", "/d.md", "/e.md", "/f.md"])
    );

    assert.deepEqual(recentPaths(window), ["/a.md", "/b.md", "/c.md", "/d.md", "/e.md"]);
  });

  await t.test("records paths in MRU order and moves an existing path to the front", () => {
    const { window } = freshApp();
    for (const path of ["/a.md", "/b.md", "/c.md", "/d.md", "/e.md", "/f.md"]) {
      window.recordRecentFile(path);
    }
    assert.deepEqual(recentPaths(window), ["/f.md", "/e.md", "/d.md", "/c.md", "/b.md"]);

    window.recordRecentFile("/d.md");
    assert.deepEqual(recentPaths(window), ["/d.md", "/f.md", "/e.md", "/c.md", "/b.md"]);
  });

  await t.test("removes a matching path without changing unrelated entries", () => {
    const { window } = freshApp();
    window.recordRecentFile("/a.md");
    window.recordRecentFile("/b.md");

    window.removeRecentFile("/a.md");

    assert.deepEqual(recentPaths(window), ["/b.md"]);
  });
});

test("recent file rendering", async (t) => {
  await t.test("shows filename and full path and delegates clicks to openPaths", () => {
    const { window, app } = freshApp();
    const path = "C:\\Docs\\notes.md";
    window.localStorage.setItem(app.RECENT_FILES_KEY, JSON.stringify([path]));
    let opened = null;
    window.openPaths = (paths) => {
      opened = paths;
    };

    window.refreshRecentFiles();

    const root = window.document.querySelector("#empty-state [data-recent-files]");
    assert.equal(root.hidden, false);
    assert.equal(root.querySelector(".recent-file-name").textContent, "notes.md");
    assert.equal(root.querySelector(".recent-file-path").textContent, path);
    root.querySelector(".recent-file").click();
    assert.deepEqual(structuredClone(opened), [path]);
  });

  await t.test("renders the same entries on startup and cloned welcome surfaces", () => {
    const { window, app } = freshApp();
    window.localStorage.setItem(app.RECENT_FILES_KEY, JSON.stringify(["/docs/a.md", "/docs/b.md"]));
    window.refreshRecentFiles();

    const tab = window.createTabShell({ kind: "welcome", title: "New Tab" });
    app.state.tabs.push(tab);
    window.buildWelcomePane(tab);

    const roots = window.document.querySelectorAll("[data-recent-files]");
    assert.equal(roots.length, 2);
    for (const root of roots) {
      assert.deepEqual(
        Array.from(root.querySelectorAll(".recent-file-name"), (node) => node.textContent),
        ["a.md", "b.md"]
      );
    }
  });

  await t.test("refreshes welcome panes that were already mounted", () => {
    const { window, app } = freshApp();
    const tab = window.createTabShell({ kind: "welcome", title: "New Tab" });
    app.state.tabs.push(tab);
    window.buildWelcomePane(tab);

    window.recordRecentFile("/docs/new.md");

    assert.equal(
      tab.contentEl.querySelector(".recent-file-name").textContent,
      "new.md"
    );
  });

  await t.test("keeps guidance before recents and support as the final page element", () => {
    const { window, app } = freshApp();
    const tab = window.createTabShell({ kind: "welcome", title: "New Tab" });
    app.state.tabs.push(tab);
    window.buildWelcomePane(tab);

    const roots = [
      window.document.getElementById("empty-state"),
      tab.contentEl.querySelector(".empty-state"),
    ];
    for (const root of roots) {
      const main = root.querySelector(".empty-state-main");
      const dropHint = main.querySelector(".drop-hint");
      const recents = main.querySelector("[data-recent-files]");
      const support = root.querySelector(".support-hint");
      assert.ok(
        dropHint.compareDocumentPosition(recents) & window.Node.DOCUMENT_POSITION_FOLLOWING
      );
      assert.equal(root.lastElementChild, support);
    }
  });
});

test("recent files follow tab opening", async (t) => {
  await t.test("records the normalized path returned by a successful open", async () => {
    const { window, tauri } = freshApp();
    tauri.core.invoke = async () => ({
      path: "/canonical/notes.md",
      doc: { headings: [], has_mermaid: false, has_math: false, html: "<p>ok</p>" },
    });

    await window.loadTab("/input/notes.md");

    assert.deepEqual(recentPaths(window), ["/canonical/notes.md"]);
  });

  await t.test("a storage write failure does not turn a successful document open into an error", async () => {
    const { window, app, tauri } = freshApp();
    window.Storage.prototype.setItem = () => {
      throw new Error("storage unavailable");
    };
    window.console.error = () => {};
    tauri.core.invoke = async () => ({
      path: "/canonical/notes.md",
      doc: { headings: [], has_mermaid: false, has_math: false, html: "<p>ok</p>" },
    });

    await window.loadTab("/input/notes.md");

    assert.equal(app.state.tabs.length, 1);
    assert.equal(app.state.tabs[0].contentEl.textContent, "ok");
    assert.equal(app.state.tabs[0].contentEl.querySelector(".render-error"), null);
  });

  await t.test("removes a stale entry when opening it fails", async () => {
    const { window, tauri } = freshApp();
    window.recordRecentFile("/missing.md");
    tauri.core.invoke = async () => {
      throw new Error("not found");
    };

    await window.loadTab("/missing.md");

    assert.deepEqual(recentPaths(window), []);
  });

  await t.test("promotes an already-open document without loading a duplicate tab", async () => {
    const { window, app } = freshApp();
    window.recordRecentFile("/other.md");
    window.recordRecentFile("/open.md");
    window.recordRecentFile("/newer.md");
    const tab = window.createTabShell({ path: "/open.md", title: "open.md" });
    app.state.tabs.push(tab);
    let loadCalled = false;
    window.loadTab = async () => {
      loadCalled = true;
    };

    await window.openPaths(["/open.md"]);

    assert.equal(loadCalled, false);
    assert.equal(app.state.tabs.length, 1);
    assert.equal(app.state.activeIndex, 0);
    assert.deepEqual(recentPaths(window), ["/open.md", "/newer.md", "/other.md"]);
  });
});
