// Pure and near-pure app.js functions: no CodeMirror instance, no Tauri
// IPC — just string/number logic plus (for a few) localStorage/matchMedia.
import test from "node:test";
import assert from "node:assert/strict";
import { freshApp } from "./harness.mjs";

test("basename", async (t) => {
  const { window } = freshApp();
  await t.test("returns the last path segment on either separator", () => {
    assert.equal(window.basename("/a/b/c.md"), "c.md");
    assert.equal(window.basename("C:\\a\\b\\c.md"), "c.md");
  });
  await t.test("returns a bare filename unchanged", () => {
    assert.equal(window.basename("file.md"), "file.md");
  });
  await t.test("falls back to the whole path for a trailing slash", () => {
    // split(/[\\/]/).pop() on "a/b/" is "" (falsy), so `|| path` returns
    // the original, unsplit string — a real, if obscure, edge case.
    assert.equal(window.basename("a/b/"), "a/b/");
  });
});

test("extOf", async (t) => {
  const { window } = freshApp();
  await t.test("lowercases and strips the leading dot", () => {
    assert.equal(window.extOf("/a/Notes.MD"), "md");
  });
  await t.test("uses only the final extension of a multi-dot name", () => {
    assert.equal(window.extOf("archive.tar.gz"), "gz");
  });
  await t.test("treats a dotfile's whole name as its extension", () => {
    assert.equal(window.extOf(".zshrc"), "zshrc");
  });
  await t.test("returns empty string when there is no dot", () => {
    assert.equal(window.extOf("README"), "");
  });
  await t.test("strips a query string or fragment before matching", () => {
    // Bug fix: a link like "notes.md?v=2" used to extract "md?v=2" as the
    // extension, which matches neither markdownExtensions nor
    // BLOCKED_OPEN_EXTENSIONS, silently misrouting the click.
    assert.equal(window.extOf("notes.md?v=2"), "md");
    assert.equal(window.extOf("notes.md#section"), "md");
    assert.equal(window.extOf("Setup.EXE?download=1"), "exe");
  });
});

test("isExternal", async (t) => {
  const { window } = freshApp();
  await t.test("classifies mailto/tel/scheme URLs as external", () => {
    assert.ok(window.isExternal("https://example.com/x"));
    assert.ok(window.isExternal("mailto:a@b.com"));
    assert.ok(window.isExternal("tel:+15551234567"));
  });
  await t.test("a path merely containing '://' also counts (documents the looseness)", () => {
    assert.ok(window.isExternal("/weird/http://embedded/path"));
  });
  await t.test("does NOT classify javascript:, data:, or protocol-relative URLs as external", () => {
    // These fall through to the local-path branches in the content-wrap
    // click handler instead — which is exactly why the Rust-side
    // extension gate and openWithSystem's denylist/confirm matter.
    assert.ok(!window.isExternal("javascript:alert(1)"));
    assert.ok(!window.isExternal("data:text/html,hi"));
    assert.ok(!window.isExternal("//example.com/x"));
  });
});

test("BLOCKED_OPEN_EXTENSIONS", async (t) => {
  const { app, window } = freshApp();
  await t.test("covers one representative executable per platform group", () => {
    for (const ext of ["app", "command", "dmg", "exe", "bat", "msi", "desktop", "sh", "appimage"]) {
      assert.ok(app.BLOCKED_OPEN_EXTENSIONS.has(ext), `${ext} should be blocked`);
    }
  });
  await t.test("does not block ordinary document/image extensions", () => {
    for (const ext of ["pdf", "png", "txt", "docx"]) {
      assert.ok(!app.BLOCKED_OPEN_EXTENSIONS.has(ext), `${ext} should not be blocked`);
    }
  });
  await t.test("is matched case-insensitively via extOf's lowercasing", () => {
    assert.ok(app.BLOCKED_OPEN_EXTENSIONS.has(window.extOf("Installer.EXE")));
  });
});

test("editorKeyName / editorExtraKeys", async (t) => {
  await t.test("uses Cmd- on mac, Ctrl- elsewhere, with Shift outermost", () => {
    const { window } = freshApp();
    const mac = {};
    window.CodeMirror.keyMap.default = window.CodeMirror.keyMap.macDefault; // simulate macOS
    assert.equal(window.editorKeyName("B"), "Cmd-B");
    assert.equal(window.editorKeyName("X", true), "Shift-Cmd-X");

    window.CodeMirror.keyMap.default = mac === window.CodeMirror.keyMap.macDefault ? {} : {}; // simulate non-mac (a distinct object)
    assert.equal(window.editorKeyName("B"), "Ctrl-B");
    assert.equal(window.editorKeyName("X", true), "Shift-Ctrl-X");
  });

  await t.test("every EDITOR_SHORTCUTS entry maps to a distinct key with no 'Mod-' prefix", () => {
    // Direct regression guard for the shipped bug: shortcuts were once
    // hand-written as "Mod-B" etc. and matched nothing, because
    // CodeMirror never runs extraKeys through normalizeKeyMap.
    const { app, window } = freshApp();
    window.CodeMirror.keyMap.default = window.CodeMirror.keyMap.macDefault;
    const keys = app.EDITOR_SHORTCUTS.map((s) => window.editorKeyName(s.key, s.shift));
    assert.equal(new Set(keys).size, keys.length, "shortcut keys must be unique");
    for (const key of keys) assert.ok(!key.includes("Mod-"), `${key} must not contain "Mod-"`);
  });

  await t.test("editorExtraKeys keys every action under its editorKeyName", () => {
    const { app, window } = freshApp();
    window.CodeMirror.keyMap.default = window.CodeMirror.keyMap.macDefault;
    const map = window.editorExtraKeys();
    assert.equal(Object.keys(map).length, app.EDITOR_SHORTCUTS.length);
    assert.equal(typeof map["Cmd-B"], "function");
    assert.equal(typeof map["Shift-Cmd-X"], "function");
  });
});

test("splitRatio", async (t) => {
  await t.test("defaults to 50 when nothing is stored", () => {
    const { window } = freshApp();
    assert.equal(window.splitRatio(), 50);
  });
  await t.test("defaults to 50 for zero, negative, or non-numeric garbage", () => {
    const { window } = freshApp();
    for (const bad of ["0", "-10", "not-a-number", ""]) {
      window.localStorage.setItem("mdreader.splitRatio", bad);
      assert.equal(window.splitRatio(), 50, `stored ${JSON.stringify(bad)} should fall back to default`);
    }
  });
  await t.test("returns a valid stored value unchanged", () => {
    const { window } = freshApp();
    window.localStorage.setItem("mdreader.splitRatio", "35");
    assert.equal(window.splitRatio(), 35);
  });
  await t.test("clamps an out-of-range stored value instead of using it verbatim", () => {
    // Bug fix: a corrupted/hand-edited value like "400" used to be
    // returned as-is, producing `--split-ratio: 400%`.
    const { window } = freshApp();
    window.localStorage.setItem("mdreader.splitRatio", "400");
    assert.equal(window.splitRatio(), 90);
    window.localStorage.setItem("mdreader.splitRatio", "1");
    assert.equal(window.splitRatio(), 10);
  });
});

test("untitledTitle", async (t) => {
  await t.test("is 'Untitled' when no tab has claimed it", () => {
    const { window } = freshApp();
    assert.equal(window.untitledTitle(), "Untitled");
  });
  await t.test("counts up when 'Untitled' is taken", () => {
    const { app, window } = freshApp();
    app.state.tabs.push({ title: "Untitled" });
    assert.equal(window.untitledTitle(), "Untitled 2");
  });
  await t.test("reuses a gap left by a closed tab", () => {
    const { app, window } = freshApp();
    app.state.tabs.push({ title: "Untitled" }, { title: "Untitled 3" });
    // "Untitled 2" was never taken (or was freed by a close) — the scan
    // is a linear "first free n", not a running counter, so it reuses it.
    assert.equal(window.untitledTitle(), "Untitled 2");
  });
  await t.test("a real file named Untitled also occupies the slot", () => {
    const { app, window } = freshApp();
    app.state.tabs.push({ title: "Untitled" });
    assert.equal(window.untitledTitle(), "Untitled 2");
  });
});

test("themePreference", async (t) => {
  await t.test("persists the OS preference on first read", () => {
    const { window } = freshApp();
    assert.equal(window.localStorage.getItem("mdreader.theme"), null);
    const pref = window.themePreference();
    assert.equal(pref, "light"); // harness's matchMedia stub always reports matches: false
    assert.equal(window.localStorage.getItem("mdreader.theme"), "light");
  });
  await t.test("a stored preference is returned without re-consulting matchMedia", () => {
    const { window } = freshApp();
    window.localStorage.setItem("mdreader.theme", "dark");
    assert.equal(window.themePreference(), "dark");
  });
});

test("debounce", async (t) => {
  await t.test("only the trailing call fires, with its own args", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] }); // clearTimeout is mocked as setTimeout's pair automatically
    const { window } = freshApp();
    const calls = [];
    const debounced = window.debounce((...args) => calls.push(args), 100);

    debounced("first");
    t.mock.timers.tick(50);
    debounced("second");
    t.mock.timers.tick(50);
    assert.deepEqual(calls, [], "should not have fired yet");
    t.mock.timers.tick(50);
    assert.deepEqual(calls, [["second"]]);
  });
});
