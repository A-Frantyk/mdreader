// The About dialog: opening, closing, link routing to opener.openUrl (never openPath),
// and that it blocks the rest of the app's shortcuts while open, like the unsaved-changes modal.
import test from "node:test";
import assert from "node:assert/strict";
import { freshApp } from "./harness.mjs";

function click(el) {
  const event = new el.ownerDocument.defaultView.MouseEvent("click", { bubbles: true, cancelable: true });
  el.dispatchEvent(event);
}

function key(window, props) {
  const event = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...props });
  window.document.dispatchEvent(event);
  return event;
}

// init() never runs under the test harness — wireStaticUI does nothing but register
// listeners (no IPC), so calling it directly here is safe.
function freshWiredApp() {
  const app = freshApp();
  app.window.wireStaticUI();
  return app;
}

test("About dialog", async (t) => {
  await t.test("opening sets the version text and shows the backdrop", async () => {
    const { window, tauri } = freshApp();
    tauri.app.getVersion = async () => "1.2.3";

    await window.openAbout();

    assert.equal(window.document.getElementById("about-version").textContent, "Version 1.2.3");
    assert.ok(window.document.getElementById("about-backdrop").classList.contains("visible"));
  });

  await t.test("Escape closes it and no other shortcut is reachable while it's open", async () => {
    const { window, app } = freshWiredApp();
    await window.openAbout();

    let zoomed = false;
    window.stepZoom = () => {
      zoomed = true;
    };
    key(window, { key: "f", metaKey: true });
    assert.equal(zoomed, false, "Cmd+F must be inert while About is open");
    assert.equal(app.aboutOpen, true);

    key(window, { key: "Escape" });

    assert.equal(app.aboutOpen, false);
    assert.equal(
      window.document.getElementById("about-backdrop").classList.contains("visible"),
      false
    );
  });

  await t.test("clicking the backdrop itself closes it", async () => {
    const { window, app } = freshWiredApp();
    await window.openAbout();

    click(window.document.getElementById("about-backdrop"));

    assert.equal(app.aboutOpen, false);
  });

  await t.test("the Close button closes it", async () => {
    const { window, app } = freshWiredApp();
    await window.openAbout();

    click(window.document.getElementById("about-close"));

    assert.equal(app.aboutOpen, false);
  });

  await t.test("clicking a link inside it opens via opener.openUrl and leaves it open", async () => {
    const { window, tauri, app } = freshWiredApp();
    await window.openAbout();

    let openUrlCalledWith = null;
    tauri.opener.openUrl = async (href) => {
      openUrlCalledWith = href;
    };
    let openPathCalled = false;
    tauri.opener.openPath = async () => {
      openPathCalled = true;
    };

    const link = window.document.querySelector("#about-backdrop a[href]");
    click(link);

    assert.equal(openUrlCalledWith, link.getAttribute("href"));
    assert.equal(openPathCalled, false, "About links must never reach opener.openPath");
    assert.equal(app.aboutOpen, true, "clicking a link must not also close the dialog");
  });

  await t.test("handleMenuAction('about') is blocked while the unsaved-changes modal is open", () => {
    const { window, app } = freshApp();
    let called = false;
    window.openAbout = () => {
      called = true;
    };
    app.modalOpen = true;

    window.handleMenuAction("about");

    assert.equal(called, false);
  });
});
