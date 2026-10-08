// Light/dark switching shares the eagerly loaded UI and syntax palette.
import test from "node:test";
import assert from "node:assert/strict";
import { freshApp } from "./harness.mjs";

function setup(t) {
  const env = freshApp();
  env.window.refreshMermaidTheme = async () => {};
  t.after(() => env.window.close());
  return env;
}

test("initial theme follows the OS once and then restores the saved preference", async (t) => {
  const { window, app, document } = setup(t);
  app.darkQuery.matches = true;
  await window.applyTheme();
  assert.equal(document.documentElement.dataset.theme, "dark");
  assert.equal(window.localStorage.getItem("mdreader.theme"), "dark");
  assert.match(app.els.codeThemeLink.href, /code-theme-dark\.css$/);
  app.darkQuery.matches = false;
  await window.applyTheme();
  assert.equal(document.documentElement.dataset.theme, "dark");
  assert.equal(document.querySelectorAll('link[href*="codemirror-theme"]').length, 0);
});

test("switches the shared UI/syntax link both ways before loading the editor", async (t) => {
  const { window, document, app } = setup(t);
  await window.applyTheme();
  assert.equal(document.documentElement.dataset.theme, "light");
  for (const mode of ["dark", "light", "dark", "light"]) {
    window.cycleTheme();
    assert.equal(document.documentElement.dataset.theme, mode);
    assert.equal(window.localStorage.getItem("mdreader.theme"), mode);
    assert.match(app.els.codeThemeLink.href, new RegExp(`code-theme-${mode}\\.css$`));
    assert.equal(app.els.themeBtn.title, `Theme: ${mode[0].toUpperCase()}${mode.slice(1)}`);
  }
  const sheets = [...document.querySelectorAll('link[rel="stylesheet"]')];
  assert.ok(sheets.indexOf(app.els.codeThemeLink) < sheets.findIndex((el) => el.href.endsWith("/styles.css")));
});

test("lazy editor theme starts in the selected mode and switches with the UI", async (t) => {
  const { window, document, app } = setup(t);
  window.localStorage.setItem("mdreader.theme", "dark");
  await window.applyTheme();
  const scripts = [];
  window.loadScript = async (src) => { scripts.push(src); };
  await window.ensureCodeMirror();
  const editorLink = document.querySelector('link[href*="codemirror-theme"]');
  assert.match(editorLink.href, /codemirror-theme-dark\.css$/);
  for (const mode of ["light", "dark"]) {
    window.cycleTheme();
    assert.match(editorLink.href, new RegExp(`codemirror-theme-${mode}\\.css$`));
    assert.match(app.els.codeThemeLink.href, new RegExp(`code-theme-${mode}\\.css$`));
  }
  const count = scripts.length;
  await window.ensureCodeMirror();
  assert.equal(scripts.length, count);
  assert.equal(document.querySelectorAll('link[href*="codemirror-theme"]').length, 1);
});
