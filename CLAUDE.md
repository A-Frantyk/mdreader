# mdreader — project notes for Claude

Lightweight cross-platform desktop Markdown viewer. Tauri v2 (Rust shell +
OS webview) + a framework-free static frontend. Full architecture writeup
is in `README.md` — read that first for the how/why. This file is the
"don't break this" list plus a map of what lives where.

**Desktop only** — Windows, Linux, macOS. No iOS/Android target, and none
planned; `#[cfg_attr(mobile, ...)]` in `lib.rs`/`main.rs` is inert
`create-tauri-app` scaffold, not an in-use code path.

## File map

| File | Owns |
|---|---|
| `src-tauri/src/render.rs` | Markdown → sanitized HTML. The core pipeline. Has its own module doc explaining the single-pass design — read it before touching this file. |
| `src-tauri/src/lib.rs` | The three file-open entry paths, Tauri commands (`open_markdown_file`, `drain_pending_files`, `markdown_extensions`, `read_markdown_source`, `render_markdown`, `save_markdown_file`), plugin registration. `AppState`'s doc comment explains the queue-always pattern. `render_and_grant` is the shared render+scope-grant tail used by both the file-open path and the live-preview path. |
| `src-tauri/build.rs` | Generates four CSS files from syntect's bundled themes at compile time: `src/code-theme-{light,dark}.css` (read-only preview) and `src/codemirror-theme-{light,dark}.css` (editor fence-token colors, via `Highlighter::style_for_stack` — see the two-theme-layer invariant below). Re-run `cargo build` after touching this — the generated files are gitignored-adjacent build output, not hand-edited. |
| `src-tauri/tauri.conf.json` | `bundle.fileAssociations` is the **single source of truth** for which extensions this app handles — it drives the OS-level file association *and* is read back at runtime (`lib.rs`'s `configured_extensions`) for argv/drop filtering and the `markdown_extensions` command. Don't hardcode the extension list anywhere else. |
| `src/app.js` | All frontend logic: tabs, TOC, find, theme, drag-drop, lazy-loading, edit mode (split-pane source + live preview). The only JS file — no other `.js` exists outside `src/vendor/`. |
| `src/vendor/` | Mermaid + KaTeX + CodeMirror 5, vendored (no CDN, no npm dependency at runtime). Don't add a bundler to manage these. |
| `fixtures/demo.md` | Exercises every rendering feature (tables, task lists, code, mermaid, math, footnotes, raw HTML) — use it to sanity-check rendering changes. |

## Invariants — why these exist, don't casually change them

- **One `push_html` call per document, in `render.rs`.** `pulldown_cmark`'s
  `HtmlWriter` carries state across events (table head/body tracking,
  footnote numbering). Calling `push_html` more than once per document —
  e.g. once per event, to hand-build custom output for a few event types —
  silently corrupts that state: every table body cell renders as `<th>`,
  column alignment is dropped, footnotes all number `1`. This was a real,
  shipped bug; the fix was restructuring to transform the event stream
  (headings/code fences become `Event::Html(..)` inline) and call
  `push_html` exactly once at the end. Any change to the rendering pipeline
  must preserve "one writer for the whole document."

- **Path resolution stays in Rust, not JavaScript.** `render.rs` resolves
  every relative image/link destination to an absolute filesystem path
  (using `std::path`, which has real Windows/POSIX semantics) and grants
  the asset-protocol scope for exactly the image files it found. The
  frontend never joins paths or sniffs separators — it only classifies an
  already-resolved string as "looks like a URL" vs "looks like a path"
  (see `rewriteImageSources` / the click handler in `app.js`). If you find
  yourself adding `.split('/')`-style path logic to `app.js`, stop — it
  belongs in `render.rs`.

- **File-open events are a hint, not the payload.** Tauri creates the
  `main` window from `tauri.conf.json` *before* running `.setup()` or
  delivering `RunEvent::Opened` — so at cold start, `get_webview_window`
  already returns `Some` even though the page hasn't loaded and has no
  listener yet. `lib.rs`'s `queue()` always pushes to `AppState.pending`
  first, and only optionally emits `files-pending` as a nudge. The
  frontend drains the queue both on load and on every `files-pending`
  event. Don't "optimize" this by emitting the path directly — that was
  the original bug (double-clicking a `.md` file opened an empty window).

- **Mermaid/KaTeX never run against a hidden element, and never redo work
  that's already correct.** That's the intent behind "render exactly
  once, on first visibility" — but it now has two call sites, not one.
  For a plain view-only tab it's still literally once: each tab keeps its
  own persistent `<article>` element (`app.js`'s `state.tabs[i].contentEl`);
  switching tabs toggles a CSS class, it doesn't re-render, and
  `activateTab`'s one-way `tab.rendered` flag is what makes "once" hold.
  For a tab in split (edit) mode, the preview re-renders on every
  debounced settle (`runPreview`, ~200ms after typing stops) — so
  "exactly once" is impossible there, but the same two underlying rules
  still apply: `renderMermaidFor`/`renderMathFor` are only called when the
  tab's pane is visible (`runPreview` checks this and sets
  `previewNeedsEnrich` to defer the pass rather than run it hidden), and
  they only run on the settled debounce, never per keystroke. Don't move
  either library's invocation back to "on every activation regardless of
  visibility" (the old bug) or forward to "on every keystroke" (the new
  one this guards against).

- **Lazy-load gating.** `has_mermaid`/`has_math` come from `render.rs` and
  gate `ensureMermaid()`/`ensureKatex()` in `app.js` — a plain document
  must never fetch either bundle. If you add a new heavy client-side
  feature, follow the same pattern (a boolean flag from Rust, a memoized
  loader promise in JS).

- **The editor's two CodeMirror theme layers own disjoint CSS selectors —
  don't merge them.** `enterSplitMode` sets `theme: "mdreader mdreader-syntax"`
  (CodeMirror applies both as separate classes on the same wrapper
  simultaneously — verified against `lib/codemirror.js`'s theme option
  handler, not assumed). `cm-s-mdreader` (hand-written, `styles.css`) owns
  chrome — background, base text, gutters, cursor, selection — plus
  markdown-*structural* tokens bridged to this app's own design tokens.
  `cm-s-mdreader-syntax` (generated by `build.rs`'s
  `generate_codemirror_theme_css`, from the *same* syntect `ThemeSet` the
  read-only preview uses) owns only code-token colors, so a document's
  fence colors match whether you're viewing or editing it. Three token
  classes — `cm-comment`, `cm-variable-2`, `cm-tag` — are deliberately
  owned by the hand-written side only, even though a real language mode
  would also use all three: `markdown.js` reuses them for its own
  non-code purposes (inline `` `code` `` spans, nested list markers, HTML
  embedded in prose). Adding a rule for any of these three to the
  generated theme creates two same-specificity selectors whose winner
  depends on stylesheet link order — this was caught and fixed once
  already; don't reintroduce it.

- **The write path is one narrow, validated command — not
  `tauri-plugin-fs`.** `save_markdown_file` (`lib.rs`) is the app's only
  filesystem write. It's a deliberately small custom command rather than
  the fs plugin, which would need a broad ACL scope grant reachable by
  any code running in the webview — this app renders untrusted markdown,
  so keeping the write surface to one extension-validated path is a
  meaningfully smaller attack surface. It validates the target extension
  via `is_markdown_path` before writing, and writes atomically (temp file
  in the *same* directory, then `rename` over the target — same-directory
  matters because a cross-filesystem rename isn't atomic). Don't widen
  this into a general-purpose write command, and don't add
  `tauri-plugin-fs` alongside it.

- **`scope.allow_file` grants are additive and never revoked, and live
  preview calls `render_and_grant` on every debounced keystroke.**
  `render()`'s asset list reflects whatever an image destination
  *currently* is, including a half-typed path mid-edit
  (`![](diagram.png)` grants scope for `d`, `di`, `dia`, … along the way
  if ungated). `render_and_grant` filters to `Path::is_file()` before
  granting for exactly this reason — don't remove that filter, and don't
  add another `scope.allow_file` call site that skips it.

- **Platform-gated `tauri`/`RunEvent` variants must be `#[cfg]`-gated in
  our code too, matching the crate's own gate exactly — not just
  "unused," a hard compile error on the excluded platforms.**
  `RunEvent::Opened` (`lib.rs`'s macOS file-open handling) only exists
  under `target_os = "macos"` in the `tauri` crate itself; matching on it
  unconditionally compiled fine here (dev machine is macOS) and failed
  Windows CI outright. This project builds and tests exclusively on
  macOS, so this class of bug won't show up locally — before adding any
  new platform-specific `tauri`/`tao` API usage, check its cfg gate in
  the crate source, not just in the docs.

- **`tauri_plugin_single_instance` is registered on Windows/Linux only**
  (`#[cfg(not(target_os = "macos"))]` in `lib.rs`). On macOS it forwards
  `argv` to an already-running instance — but a file opened via
  Finder/"Open With" never appears in `argv` there, it arrives via
  `RunEvent::Opened` directly on whichever process macOS's LaunchServices
  routes to (including an already-running one, no second process spawned
  at all). Registering the plugin on macOS meant a repeat "Open With"
  connected to the running instance and forwarded an empty argv,
  silently dropping the file — this was a real, shipped bug.

## Day to day

```bash
npm install && npm run tauri dev          # dev build, hot-reload
npm run tauri dev -- fixtures/demo.md     # dev build with a file preloaded
cd src-tauri && cargo test                # render.rs unit tests
npm run tauri build                       # release bundles
```

Kill any running dev/debug instance before rebuilding. On Windows/Linux the
single-instance plugin means a stale process will receive and swallow the
new one's argv instead of exiting; on macOS (where that plugin isn't
registered, see the invariant above) a stale process instead means a
double-click just brings the OLD build to front via `RunEvent::Opened`
instead of launching your new one.

## Known gaps

- Developed and tested on macOS only so far. Windows file-association
  registration (NSIS installer, registry `ProgId`) and Linux (`.desktop`
  MIME handling, WebKitGTK rendering quirks — see the "Known risks"
  history in past planning) are implemented per Tauri's documented
  behavior but not yet verified on real Windows/Linux machines.
- Builds are unsigned. macOS Gatekeeper needs a right-click → Open on
  first launch; Windows SmartScreen will warn. No code-signing pipeline
  exists yet.
- No auto-update mechanism.
- Edit mode covers editing and saving an *existing* file only. No "New
  Document" / Save As / untitled-tab support yet (`tab.path` is always a
  real path today), and no window-close guard — quitting the app with
  unsaved edits in a background tab doesn't currently prompt (closing an
  individual dirty *tab* does). No crash-safe autosave: a crash or force
  quit loses unsaved edits, same as most editors without that feature.
- No scroll sync between the editor and preview panes in split mode.
- The editor's formatting toolbar (`app.js`'s `TOOLBAR_BUTTONS`) is
  deliberately Bold/Italic/Strikethrough only, no Underline — Markdown has
  no native underline syntax, and the only way to fake one (raw `<u>` HTML,
  which this app's sanitizer does happen to allow through) isn't "MD
  syntax." Don't add an underline button by reaching for `<u>`; if this
  ever changes it needs a real decision, not a silent workaround.
- Fence-language resolution goes through `mode/meta.js`'s alias table,
  which is missing a couple of short forms this project's own fixtures
  don't hit but real documents might — notably no `"py"` alias for Python
  and no `"rs"` alias for Rust (the full words work fine). Upstream
  CodeMirror's own limitation, not worth patching around.
- **Live-preview render cost has real headroom pressure on larger
  documents.** `render.rs`'s `render_timing_on_realistic_documents` test
  (ignored by default; run with `cargo test --release -- --ignored
  --nocapture`) measured p50=82ms / p95=158ms on `fixtures/large.md`
  (56KB, code-fence-heavy) — against the ~200ms debounce in `app.js`'s
  `schedulePreview`. That leaves little room for IPC and `innerHTML`
  reflow on top before a large document's preview starts feeling behind
  while typing. Syntect's per-fence highlighting is the dominant cost
  (every fence is re-highlighted on every render, not just the one being
  edited) — a content-keyed fence-highlight cache is the natural next
  step if this becomes noticeable in practice, but isn't implemented yet.
