# mdreader — project notes for Claude

Lightweight cross-platform desktop Markdown viewer. Tauri v2 (Rust shell +
OS webview) + a framework-free static frontend. Full architecture writeup
is in `README.md` — read that first for the how/why. This file is the
"don't break this" list plus a map of what lives where.

## File map

| File | Owns |
|---|---|
| `src-tauri/src/render.rs` | Markdown → sanitized HTML. The core pipeline. Has its own module doc explaining the single-pass design — read it before touching this file. |
| `src-tauri/src/lib.rs` | The three file-open entry paths, Tauri commands (`open_markdown_file`, `drain_pending_files`, `markdown_extensions`), plugin registration. `AppState`'s doc comment explains the queue-always pattern. |
| `src-tauri/build.rs` | Generates `src/code-theme-light.css` and `src/code-theme-dark.css` from syntect's bundled themes at compile time. Re-run `cargo build` after touching this — the generated files are gitignored-adjacent build output, not hand-edited. |
| `src-tauri/tauri.conf.json` | `bundle.fileAssociations` is the **single source of truth** for which extensions this app handles — it drives the OS-level file association *and* is read back at runtime (`lib.rs`'s `configured_extensions`) for argv/drop filtering and the `markdown_extensions` command. Don't hardcode the extension list anywhere else. |
| `src/app.js` | All frontend logic: tabs, TOC, find, theme, drag-drop, lazy-loading. The only JS file — no other `.js` exists outside `src/vendor/`. |
| `src/vendor/` | Mermaid + KaTeX, vendored (no CDN, no npm dependency at runtime). Don't add a bundler to manage these. |
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

- **Mermaid/KaTeX render exactly once, on first visibility, not on every
  tab switch.** Each tab keeps its own persistent `<article>` element
  (`app.js`'s `state.tabs[i].contentEl`); switching tabs toggles a CSS
  class, it doesn't re-render. Both libraries measure text via the DOM, so
  they must not run against a `display: none` element — `activateTab`
  toggles visibility *before* triggering the first render. Don't move
  Mermaid/KaTeX rendering back to "on every activation" or "at load time
  regardless of visibility."

- **Lazy-load gating.** `has_mermaid`/`has_math` come from `render.rs` and
  gate `ensureMermaid()`/`ensureKatex()` in `app.js` — a plain document
  must never fetch either bundle. If you add a new heavy client-side
  feature, follow the same pattern (a boolean flag from Rust, a memoized
  loader promise in JS).

## Day to day

```bash
npm install && npm run tauri dev          # dev build, hot-reload
npm run tauri dev -- fixtures/demo.md     # dev build with a file preloaded
cd src-tauri && cargo test                # render.rs unit tests
npm run tauri build                       # release bundles
```

Kill any running dev/debug instance before rebuilding — the single-instance
plugin means a stale process will just receive and swallow the new one's
argv instead of exiting.

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
