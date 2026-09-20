// The security-critical suite: everything between "user clicked something in a
// rendered document" and "a native OS action actually happened." See CLAUDE.md's
// path-resolution invariant — the frontend only classifies an already-resolved string.
import test from "node:test";
import assert from "node:assert/strict";
import { freshApp } from "./harness.mjs";

function click(el) {
  const event = new el.ownerDocument.defaultView.MouseEvent("click", { bubbles: true, cancelable: true });
  el.dispatchEvent(event);
}

function makeActiveTab({ window, app }) {
  const tab = window.createTabShell({});
  app.state.tabs.push(tab);
  app.state.activeIndex = 0;
  return tab;
}

test("#content-wrap click routing", async (t) => {
  await t.test("an in-page #anchor scrolls within the active tab and calls no IPC", () => {
    const { window, document, tauri } = freshApp();
    const tab = makeActiveTab({ window, app: window.__testExports });
    tab.contentEl.innerHTML = '<h2 id="target">Target</h2><a href="#target">jump</a>';

    let scrolledTarget = null;
    window.Element.prototype.scrollIntoView = function () {
      scrolledTarget = this;
    };
    let openUrlCalled = false;
    tauri.opener.openUrl = async () => {
      openUrlCalled = true;
    };

    const link = tab.contentEl.querySelector("a[href='#target']");
    click(link);

    assert.equal(scrolledTarget?.id, "target");
    assert.equal(openUrlCalled, false, "an in-page anchor must never reach opener.openUrl");
  });

  await t.test("an external URL is routed to opener.openUrl, never openPath", async () => {
    const { window, tauri } = freshApp();
    makeActiveTab({ window, app: window.__testExports });
    let openUrlCalledWith = null;
    tauri.opener.openUrl = async (href) => {
      openUrlCalledWith = href;
    };
    let openPathCalled = false;
    tauri.opener.openPath = async () => {
      openPathCalled = true;
    };

    const link = window.document.createElement("a");
    link.href = "https://example.com/page";
    window.document.getElementById("content-wrap").appendChild(link);
    click(link);

    // openUrl is awaited inside a .catch chain — give the microtask queue a tick to settle.
    await Promise.resolve();
    assert.equal(openUrlCalledWith, "https://example.com/page");
    assert.equal(openPathCalled, false);
  });

  await t.test("a recognized markdown extension is routed to openPaths, not openWithSystem", () => {
    const { window } = freshApp();
    window.__testExports.markdownExtensions = new Set(["md"]);
    makeActiveTab({ window, app: window.__testExports });

    let openPathsCalledWith = null;
    window.openPaths = (paths) => {
      openPathsCalledWith = paths;
    };
    let openWithSystemCalled = false;
    window.openWithSystem = async () => {
      openWithSystemCalled = true;
    };

    // Local links carry data-path, not href — see CLAUDE.md's path-resolution invariant.
    const link = window.document.createElement("a");
    link.dataset.path = "/resolved/absolute/other.md";
    window.document.getElementById("content-wrap").appendChild(link);
    click(link);

    assert.deepEqual(structuredClone(openPathsCalledWith), ["/resolved/absolute/other.md"]);
    assert.equal(openWithSystemCalled, false);
  });

  await t.test("a non-markdown local path is routed to openWithSystem", () => {
    const { window } = freshApp();
    window.__testExports.markdownExtensions = new Set(["md"]);
    makeActiveTab({ window, app: window.__testExports });

    let openWithSystemCalledWith = null;
    window.openWithSystem = async (href) => {
      openWithSystemCalledWith = href;
    };
    let openPathsCalled = false;
    window.openPaths = () => {
      openPathsCalled = true;
    };

    const link = window.document.createElement("a");
    link.dataset.path = "/resolved/absolute/notes.txt";
    window.document.getElementById("content-wrap").appendChild(link);
    click(link);

    assert.equal(openWithSystemCalledWith, "/resolved/absolute/notes.txt");
    assert.equal(openPathsCalled, false);
  });

  await t.test("a Windows-style resolved path round-trips untouched", () => {
    // The regression this data-path channel exists for: a Windows destination like
    // C:\Users\a\pic.md must reach openPaths/openWithSystem byte-for-byte, no rewriting.
    const { window } = freshApp();
    window.__testExports.markdownExtensions = new Set(["md"]);
    makeActiveTab({ window, app: window.__testExports });

    let openPathsCalledWith = null;
    window.openPaths = (paths) => {
      openPathsCalledWith = paths;
    };

    const link = window.document.createElement("a");
    link.dataset.path = "C:\\Users\\a\\notes.md";
    window.document.getElementById("content-wrap").appendChild(link);
    click(link);

    assert.deepEqual(structuredClone(openPathsCalledWith), ["C:\\Users\\a\\notes.md"]);
  });
});

test("openWithSystem", async (t) => {
  await t.test("every denylisted extension shows a warning and never calls opener.openPath", async () => {
    for (const href of ["/a/installer.exe", "/a/App.app", "/a/script.sh", "/a/setup.MSI", "/a/thing.desktop"]) {
      const { window, tauri } = freshApp();
      let messageShown = null;
      tauri.dialog.message = async (msg, opts) => {
        messageShown = { msg, opts };
      };
      let openPathCalled = false;
      tauri.opener.openPath = async () => {
        openPathCalled = true;
      };
      // Should never even be consulted for a blocked extension.
      tauri.dialog.ask = async () => {
        throw new Error("dialog.ask must not be called for a blocked extension");
      };

      await window.openWithSystem(href);

      assert.ok(messageShown, `expected a warning dialog for ${href}`);
      assert.match(messageShown.msg, /Refusing to open/);
      assert.ok(messageShown.msg.includes(href));
      assert.equal(openPathCalled, false, `openPath must not fire for ${href}`);
    }
  });

  await t.test("a non-blocked file shows a confirm dialog with the resolved absolute path", async () => {
    const { window, tauri } = freshApp();
    let askedWith = null;
    tauri.dialog.ask = async (msg) => {
      askedWith = msg;
      return false; // decline
    };
    let openPathCalled = false;
    tauri.opener.openPath = async () => {
      openPathCalled = true;
    };

    await window.openWithSystem("/resolved/absolute/report.pdf");

    assert.ok(askedWith.includes("/resolved/absolute/report.pdf"));
    assert.equal(openPathCalled, false, "declining the confirmation must not open anything");
  });

  await t.test("opener.openPath fires only after the user confirms", async () => {
    const { window, tauri } = freshApp();
    tauri.dialog.ask = async () => true; // confirm
    let openPathCalledWith = null;
    tauri.opener.openPath = async (path) => {
      openPathCalledWith = path;
    };

    await window.openWithSystem("/resolved/absolute/report.pdf");

    assert.equal(openPathCalledWith, "/resolved/absolute/report.pdf");
  });
});

test("rewriteImageSources", async (t) => {
  await t.test("rewrites a resolved local path through convertFileSrc", () => {
    const { window, tauri } = freshApp();
    const root = window.document.createElement("div");
    root.innerHTML = '<img data-path="/resolved/absolute/pic.png">';
    window.rewriteImageSources(root);
    assert.equal(root.querySelector("img").getAttribute("src"), tauri.core.convertFileSrc("/resolved/absolute/pic.png"));
  });

  await t.test("a Windows-style resolved path round-trips untouched into convertFileSrc", () => {
    // Same regression coverage as the click-routing suite above, for image paths.
    const { window, tauri } = freshApp();
    const root = window.document.createElement("div");
    root.innerHTML = '<img data-path="C:\\Users\\a\\pic.png">';
    window.rewriteImageSources(root);
    assert.equal(root.querySelector("img").getAttribute("src"), tauri.core.convertFileSrc("C:\\Users\\a\\pic.png"));
  });

  await t.test("leaves a data: URL untouched", () => {
    // A remote/data-URI image never gets a data-path — nothing to select.
    const { window } = freshApp();
    const root = window.document.createElement("div");
    root.innerHTML = '<img src="data:image/png;base64,AAAA">';
    window.rewriteImageSources(root);
    assert.equal(root.querySelector("img").getAttribute("src"), "data:image/png;base64,AAAA");
  });

  await t.test("leaves a remote URL untouched", () => {
    const { window } = freshApp();
    const root = window.document.createElement("div");
    root.innerHTML = '<img src="https://example.com/pic.png">';
    window.rewriteImageSources(root);
    assert.equal(root.querySelector("img").getAttribute("src"), "https://example.com/pic.png");
  });
});
