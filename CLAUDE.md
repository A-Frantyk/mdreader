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
| `src-tauri/src/render.rs` + `render/` | Markdown → sanitized HTML. `render.rs` is the single-pass driver — has its own module doc explaining the design, read it before touching any of this. It delegates to submodules: `render/events.rs` (`Tag::Link`/`Tag::Image` → `<a data-path>`/`<img data-path>` HTML), `render/paths.rs` (destination resolution), `render/headings.rs` (slug/id generation), `render/highlight.rs` (syntect fences, `SYNTAX_SET`), `render/sanitize.rs` (the ammonia allowlist). Each submodule's `#[cfg(test)]` tests live in a sibling `tests.rs` (e.g. `render/paths/tests.rs`) rather than inline — a child module reaches its parent's private items through `use super::*` regardless, so this costs no visibility widening. |
| `src-tauri/src/lib.rs` | The three file-open entry paths, `AppState`, `run()`, plugin registration, the `on_window_event` close handshake. `AppState`'s doc comment explains the queue-always pattern (and, for `frontend_ready`, the analogous close-handshake race). |
| `src-tauri/src/commands.rs` | The 10 Tauri commands (`open_markdown_file`, `drain_pending_files`, `markdown_extensions`, `read_markdown_source`, `render_markdown`, `save_markdown_file`, `save_markdown_file_as`, `mark_frontend_ready`, `quit_app`, `set_zoom`). `render_and_grant` is the shared render+scope-grant tail used by both the file-open path and the live-preview path. |
| `src-tauri/src/files.rs` | Markdown-path validation (`is_markdown_path`/`require_markdown_path`/`normalize_markdown_path`) and the app's one filesystem write, `atomic_write`. |
| `src-tauri/src/menu.rs` | The native File/Edit/View/Window/Help menu bar and its click handler. Hand-built rather than `tauri::menu::Menu::default()` — see the two menu invariants below for why. |
| `src-tauri/build.rs` | Converts the two vendored VS Code theme JSON files (`themes/`) into syntect `Theme`s and generates four CSS files at compile time: `src/code-theme-{light,dark}.css` (read-only preview's fence colors, plus a `:root { --syntax-* }` palette the editor pane and preview fences both consume) and `src/codemirror-theme-{light,dark}.css` (editor fence-token colors, via `Highlighter::style_for_stack` — see the theme-sourcing and two-theme-layer invariants below). Re-run `cargo build` after touching this — the generated files are gitignored-adjacent build output, not hand-edited. |
| `src-tauri/themes/` | The two vendored VS Code theme JSON files (One Dark Pro / One Light) `build.rs` converts at compile time, plus `LICENSE-THEMES.md` (both MIT). Vendored verbatim, same as `src/vendor/` — don't hand-edit; if either theme is ever swapped, replace the JSON and re-run `cargo build`. |
| `src-tauri/tauri.conf.json` | `bundle.fileAssociations` is the **single source of truth** for which extensions this app handles — it drives the OS-level file association and, via `build.rs`'s `generate_markdown_extensions`, the compiled-in `MARKDOWN_EXTENSIONS` used for argv/drop filtering and the `markdown_extensions` command. This has to happen at *build* time: `tauri_utils::config`'s codegen for embedding config into the binary unconditionally hardcodes `file_associations` to `None`, so `Context::config()` can never see it at runtime, on any platform — confirmed by reading `tauri_utils`' source after this exact assumption silently broke file-opening everywhere. Don't hardcode the extension list anywhere else. |
| `src-tauri/icons/app-icon.svg` | The app icon's only hand-authored source (monoline "MD" monogram, pupil dot in the D's counter — on `--accent`, `src/styles.css`). Every other file in `src-tauri/icons/` is generated from it via `npm run icon`; don't hand-edit those. Letterforms are stroked `<path>`s, not `<text>` — `tauri icon` rasterizes with resvg and must not depend on system font resolution. The generator also writes `ios/`/`android/` subfolders and a `64x64.png`; delete the `ios`/`android` dirs after regenerating (this project is desktop-only, see below) — `64x64.png` is harmless unreferenced output, same as the `Square*Logo.png`/`StoreLogo.png` Windows Store assets `tauri.conf.json`'s `bundle.icon` doesn't list. |
| `src/js/` | All frontend logic — tabs, TOC, find, theme, zoom, drag-drop, lazy-loading, edit mode (split-pane source + live preview) — split across 18 classic scripts (`tauri.js`, `helpers.js`, `dom.js`, `state.js`, `theme.js`, `zoom.js`, `loaders.js`, `toc.js`, `links.js`, `tabs.js`, `save.js`, `editor-commands.js`, `splitter.js`, `edit-mode.js`, `preview.js`, `find.js`, `modal.js`, `main.js`), loaded by `src/index.html` in that fixed order. See the "classic scripts, not ES modules" invariant below before touching load order or adding a 19th file. The only JS outside `src/vendor/`. `modal.js` owns both of the app's modals — the three-button unsaved-changes one and the About dialog (`#about-backdrop`) — and the welcome-screen support link is hand-synced between `index.html`'s `#empty-state` and `#welcome-pane-template`, same as the rest of that pair's markup. |
| `src/vendor/` | Mermaid + KaTeX + CodeMirror 5, vendored (no CDN, no npm dependency at runtime). Don't add a bundler to manage these. |
| `fixtures/demo.md` | Exercises every rendering feature (tables, task lists, code, mermaid, math, footnotes, raw HTML) — use it to sanity-check rendering changes. |

## Comment discipline

Default to no comment. A comment survives only if it passes all four checks
below — not "does it explain why," which every author believes their own
comment does. That test can't return no, so it filters nothing; these can.

1. **Names an external, checkable fact** — an OS/webview behavior, a named
   library (with a version or source line where it's true), a spec rule, or
   a bug that actually shipped. "Because it's clearer," "so the caller can,"
   "deliberately," "this is intentional" are not external facts — delete.
2. **A reader of this file, plus the tests, could not derive it.** If the
   code already says it, delete or rename instead.
3. **Doesn't describe another file's internals.** Cross-file mechanics live
   in this file's Invariants section, not in code comments — a pointer back
   here (`see CLAUDE.md`) is fine; re-narrating the invariant next to the
   pointer is the duplication that goes stale when the invariant changes and
   the comment doesn't. Never name a specific file/function elsewhere by
   name in a comment; if it moves, the comment silently lies.
4. **Fits on one line**, or each extra line names a distinct fact.

Fails 1, 2, or 3 → delete. Fails only 4 → compress, keeping every citation.
A Rust `//!` module doc or a `src/js/*.js` file-header line is the module's
identity, not this kind of comment — keep one, 1-3 lines, naming what the
module owns; put the *why* in this file instead.

Comments in code you touch are in scope — deleting one is never "out of
scope" for an unrelated change. There is no grandfathering.

## Invariants — why these exist, don't casually change them

- **One `push_html` call per document, in `render.rs`.** `HtmlWriter` carries
  state across events (table head/body, footnote numbering) — calling it
  more than once per document silently corrupts that state (every table
  body cell renders as `<th>`, footnotes all number `1`). Shipped bug, fixed
  by transforming the event stream and calling `push_html` exactly once at
  the end. Any pipeline change must preserve "one writer for the document."

- **Path resolution stays in Rust, not JavaScript — a resolved path lives in
  `data-path`, never `src`/`href`.** `render.rs` resolves every relative
  image/link destination via `std::path` and grants asset-protocol scope for
  the images it found. `data-path`, not `src`/`href`: ammonia applies URL
  semantics to those, and a Windows path (`C:\Users\...`) parses as URL
  scheme `c`, silently dropped. Shipped bug — every local link/image was
  dead on Windows, hidden by Rust tests that hardcoded POSIX-only base dirs
  (`render/testutil.rs`'s `tdir`/`abs` now build cross-platform). `sanitize.rs`
  allowlists `data-path` (plus `role`/`tabindex`, since a href-less `<a>`
  gets neither focus nor cursor for free) scoped to `img`/`a` only — don't
  widen to `add_generic_attributes`. The frontend never joins paths or
  sniffs separators — `links.js` just reads `data-path` and hands it to
  `convertFileSrc`/`openPaths`/`openWithSystem` verbatim. External/anchor/
  scheme'd destinations are unaffected — `paths.rs`'s `resolve_local`
  returns `None` for those.

- **File-open events are a hint, not the payload.** The `main` window exists
  before `.setup()` runs or `RunEvent::Opened` fires, so `get_webview_window`
  is already `Some` with no listener attached yet. `lib.rs`'s `queue()`
  always pushes to `AppState.pending` first and only optionally emits
  `files-pending` as a nudge; the frontend drains on load and on every
  event. Don't emit the path directly — that was the original bug
  (double-clicking a `.md` file opened an empty window).

- **Mermaid/KaTeX never run against a hidden element, never redo correct
  work.** For a view-only tab it's exactly once — `activateTab`'s one-way
  `tab.rendered` flag. In split mode the preview re-renders on every
  debounced settle (~200ms, `runPreview`), so "exactly once" doesn't hold
  there, but both libraries still only run when the pane is visible
  (`previewNeedsEnrich` defers otherwise) and only on the settled debounce,
  never per keystroke.

- **Lazy-load gating.** `has_mermaid`/`has_math` from `render.rs` gate
  `ensureMermaid()`/`ensureKatex()` — a plain document must never fetch
  either bundle. A new heavy client feature follows the same pattern: a
  boolean flag from Rust, a memoized loader promise in JS.

- **The editor's two CodeMirror theme layers are disjoint by namespace, not
  a hand-picked class list — don't merge them or add a third scheme.**
  `enterSplitMode` sets `theme: "mdreader mdreader-syntax"` (CodeMirror
  applies both simultaneously) and `tokenTypeOverrides: MARKDOWN_TOKEN_TYPES`,
  which renames every markdown.js token to `md-`-prefixed, freeing the
  entire CodeMirror vocabulary for the generated theme rather than the three
  classes (`cm-comment`/`cm-variable-2`/`cm-tag`) it used to avoid.
  `cm-s-mdreader` (`styles.css`) owns chrome + every `cm-md-*` rule;
  `cm-s-mdreader-syntax` (`build.rs`'s `generate_codemirror_theme_css`, same
  two vendored themes as the preview) owns only plain code-token classes.
  `pure-helpers.test.mjs` asserts `MARKDOWN_TOKEN_TYPES` covers every
  markdown.js key and is `md-`-prefixed — a future CodeMirror bump could add
  one silently. `highlightFormatting: true` is load-bearing: markdown.js
  defaults it off, which would let a syntax marker share its content's own
  token class with no way to dim it — turning it on, plus `cm-md-punct`
  declared *last* at equal specificity, is what makes the editor read flat
  and source-first. Four token classes are hardcoded outside
  `tokenTypeOverrides`' reach — `meta`/`property` (task checkboxes),
  `url`/`link` (autolinks, alt text) — styled directly by name in
  `styles.css`. The task-checkbox rule needs `.cm-s-mdreader.CodeMirror
  .cm-meta` (not `.cm-s-mdreader .cm-meta`): `codemirror-theme-*.css` loads
  lazily, *after* `styles.css`, so on equal specificity it would win every
  tie without the bump.

- **Both syntax themes come from two vendored VS Code theme JSON files, not
  syntect's bundled `ThemeSet::load_defaults()` — their names are never
  surfaced in the UI.** `themes/one-dark-pro.json`/`one-light.json` (MIT,
  see `LICENSE-THEMES.md`). `build.rs`'s `load_vscode_theme` converts one
  directly — a VS Code theme's `tokenColors` *is* a TextMate scope table, no
  plist round-trip needed. `settings.fontStyle` is never read — Markdown
  tokens render flat by design. An unparseable/scopeless entry is skipped
  with a `cargo:warning`, never a panic. `syntax_root_css` prepends a
  `:root { --syntax-*: … }` block to `code-theme-{light,dark}.css`
  specifically (not `codemirror-theme-*.css`) because it's linked eagerly
  and swapped by `theme.js`, so the properties exist from first paint —
  `codemirror-theme-*.css` loads lazily and can't host a token a
  never-opens-the-editor session still needs. Corollary: `styles.css` (linked
  after) must never redefine a `--syntax-*` name in its own `:root` — that
  would win the cascade and pin every theme to whichever loaded last; it
  only reads them via `var(--syntax-x, var(--editor-x))` fallback.
  `contracts.rs`'s `syntax_custom_properties_defined_in_both_themes` and
  `generated_code_theme_css_has_substantial_rule_count` guard a typo'd
  property name and a broken conversion respectively.

- **The write path is one narrow, validated command — not `tauri-plugin-fs`.**
  `save_markdown_file` is the app's only filesystem write: a small custom
  command rather than the fs plugin, which would need a broad ACL grant
  reachable by any code in the webview (this app renders untrusted
  markdown). Validates the extension via `is_markdown_path` before writing,
  writes atomically (temp file same directory, then `rename` — cross-filesystem
  rename isn't atomic). Don't widen this or add `tauri-plugin-fs` alongside it.

- **Every path-taking Tauri command validates the extension Rust-side — JS
  filters are UX, not the boundary.** `require_markdown_path` gates
  `open_markdown_file`, `read_markdown_source`, `save_markdown_file` alike.
  A compromised webview can call `invoke` directly, so a command that would
  read/write `~/.ssh/id_rsa` when handed that path is a real hole regardless
  of frontend filtering. Any new path-taking command goes through
  `require_markdown_path` (or stricter) first.

- **`opener.openPath` is only ever called via `openWithSystem`, which
  denylists executable extensions and shows a native confirm with the
  resolved absolute path.** By the time a link reaches the click handler,
  `render.rs` has resolved it to an absolute path — including `../` escapes
  above the document's directory (deliberate; `relative_links_may_escape_base_dir`
  pins it). `opener:allow-open-path` has no scope, so a document shipped
  next to `install.command`/`Setup.exe` could name it under any link text.
  The denylist is convenience; the confirmation dialog is the guarantee —
  don't add a second `openPath` call site, don't make the confirm skippable.

- **`sanitize()` allows `style` on `td`/`th` only, filtered to `text-align`.**
  The one property pulldown-cmark's GFM table writer emits. Ammonia's
  default (`style_properties: None`) passes a style block through verbatim
  — a raw `background:url(https://…)` would paint over the window and
  beacon out. Widen `filter_style_properties` only for a property
  `render/events.rs` itself produces.

- **`app.security.csp` is set; don't null it.** No remote code loads —
  everything is vendored — so `default-src 'self'` costs nothing and stands
  between a future mermaid/KaTeX/ammonia bypass and IPC access. Loosen only
  the one directive genuinely needed, with a comment why; `'unsafe-inline'`
  for `style-src` exists because mermaid/KaTeX/CodeMirror set inline styles,
  and `img-src` keeps `https:`/`http:` for remote images (a tracking-pixel
  trade-off, made knowingly).

- **`scope.allow_file` grants are additive and never revoked; live preview
  calls `render_and_grant` on every debounced keystroke.** A half-typed path
  mid-edit (`![](diagram.png)`) would grant scope for `d`, `di`, `dia`, … if
  ungated. `render_and_grant` filters to `Path::is_file()` before granting —
  don't remove that filter or add another `allow_file` site that skips it.

- **Platform-gated `tauri`/`RunEvent` variants must be `#[cfg]`-gated in our
  code too, matching the crate's own gate — a hard compile error on
  excluded platforms, not just "unused."** `RunEvent::Opened` only exists
  under `target_os = "macos"` in the `tauri` crate; matching it
  unconditionally compiled fine on this (macOS) dev machine and failed
  Windows CI outright. Check the crate's cfg gate before any new
  platform-specific `tauri`/`tao` usage — this class of bug won't show up locally.

- **The native menu is hand-built; `PredefinedMenuItem::close_window` is
  absent from every submenu.** `Menu::default()` can't be reused: its File
  submenu doesn't exist on Linux, and its File/Window submenus carry
  `close_window`, which `muda` gives the Cmd+W accelerator on macOS — AppKit
  resolves that before the webview sees the keystroke, hijacking this app's
  own "close active tab." Don't add `close_window` back or switch to
  `Menu::default()`. `PredefinedMenuItem::about` is likewise a custom
  `ABOUT` id — `NSAboutPanel` can't host a clickable link, so About opens an
  app-controlled HTML dialog through the same `menu-action` pipe.

- **Quit routes through a custom menu item, never `PredefinedMenuItem::quit`.**
  Traced through `tauri`/`muda`/`tao` sources: `muda`'s macOS predefined
  Quit sends `terminate:` directly to `NSApp`; `tao`'s app delegate never
  implements `applicationShouldTerminate`, so there's no veto point;
  `tauri-runtime-wry` never produces `RunEvent::ExitRequested` from
  `terminate:`. The predefined item would terminate with **no interceptable
  event**, bypassing the unsaved-changes quit sequence. `AppHandle::exit(0)`
  (via `quit_app`) is the only sanctioned way this app ends itself — it
  produces an unprevented `ExitRequested` without re-entering
  `CloseRequested`, so the confirmed quit sequence can't loop back into its
  own prompt. `window.destroy()` needs its own capability grant;
  `AppHandle::exit` needs none.

- **`WindowEvent::CloseRequested` is prevented synchronously; the emit that
  hands off to JS is gated on `frontend_ready`.** `prevent_close()` must be
  called in the same synchronous handler invocation — any `await` first and
  the window closes anyway. Emitting `"close-requested"` before the
  frontend's listener exists would lose it outright (Tauri doesn't replay
  events) — same race as the `pending`/`files-pending` queue, on the way
  out. `frontend_ready` (flipped by `mark_frontend_ready`, called only after
  every listener is registered) keeps the window closable if the frontend
  never finishes loading.

- **App-wide zoom uses the webview's native page zoom, never CSS
  `zoom`/`transform: scale`.** CodeMirror measures character cells via
  `getBoundingClientRect`, which a transformed ancestor breaks. `tauri.conf.json`
  never sets `zoomHotkeysEnabled` — that polyfill's own un-persisted counter
  would desync from `zoom.js`'s state. `set_zoom` is custom rather than the
  core plugin's `set_webview_zoom`, to avoid widening the ACL — same
  reasoning as `save_markdown_file` staying off `tauri-plugin-fs`.
  `WKWebView.setPageZoom:` is macOS 11+, hence `minimumSystemVersion: "11.0"`.
  The native View-menu accelerators (unshifted `=`/`-`) and the JS keydown
  branch (shifted `+`, numpad Add/Subtract, matched by `e.code`) are
  disjoint key sets by construction, not two paths to one shortcut.
  "Actual Size" has no accelerator — `Cmd/Ctrl+0` is already the editor's
  "clear heading" binding, and a macOS menu key equivalent would silently
  kill it.

- **`tauri_plugin_single_instance` is registered on Windows/Linux only.** On
  macOS a file opened via Finder/"Open With" never appears in `argv` — it
  arrives via `RunEvent::Opened` on whichever process LaunchServices routes
  to, no second process spawned. Registering the plugin on macOS meant a
  repeat "Open With" forwarded an empty argv, silently dropping the file —
  shipped bug.

- **The frontend is deliberately N classic scripts sharing one global
  lexical scope — not ES modules, not IIFEs.** `index.html` loads 18 plain
  `<script src>` tags in a fixed order. Two reasons this can't change:
  `harness.mjs` evaluates the concatenated source and reads top-level
  `const`/`let` bindings by bare name, which only resolves under one shared
  scope; and several tests stub an internal function by reassigning
  `window.<fn>` and asserting a *different* function's call was
  intercepted — under modules that binds lexically at declaration time and
  the stub is a silent no-op. Load order matters only for what runs at
  script-evaluation time: `dom.js`'s `els` must precede `toc.js`/`links.js`
  (both register listeners on `els.*` at load), and `main.js` must be last
  (ends with a bare `init();`, never called by the harness).

## Day to day

```bash
npm install && npm run tauri dev          # dev build, hot-reload
npm run tauri dev -- fixtures/demo.md     # dev build with a file preloaded
cd src-tauri && cargo test                # render/, files/, commands/ unit tests + contracts.rs
npm run tauri build                       # release bundles
```

Kill any running dev/debug instance before rebuilding. On Windows/Linux the
single-instance plugin means a stale process will receive and swallow the
new one's argv instead of exiting; on macOS (where that plugin isn't
registered, see the invariant above) a stale process instead means a
double-click just brings the OLD build to front via `RunEvent::Opened`
instead of launching your new one.

## Known gaps

- Developed and tested on macOS only. Windows file-association registration
  and Linux `.desktop`/WebKitGTK behavior follow Tauri's documented
  behavior but are unverified on real Windows/Linux machines.
- **macOS builds are ad-hoc signed, not notarized; Windows/Linux are
  unsigned.** `signingIdentity: "-"` exists because `--target
  universal-apple-darwin`'s `lipo` step invalidates each arch's implicit
  ad-hoc signature — without an explicit identity, Apple Silicon refuses to
  launch the result at all ("app is damaged," unrecoverable). Ad-hoc
  signing downgrades that to the ordinary "unidentified developer" prompt
  (System Settings → Privacy & Security → Open Anyway). `hardenedRuntime`
  is explicitly `false` — it only pays off once notarized and can break the
  webview's JIT without a matching entitlements file. If a Developer cert
  is bought: notarize, flip `hardenedRuntime` to `true`, add an
  entitlements plist with `com.apple.security.cs.allow-jit`. Windows
  SmartScreen still warns — no signing pipeline exists yet. Releases are
  tag-driven (`v*`) via `build.yml`'s `release` job; every installer ships
  a `SHA256SUMS-*.txt`.
- No auto-update mechanism.
- Sanitizer/DoS headroom: `unique_id` (`render/headings.rs`) is quadratic on
  N duplicate headings, and syntect's `fancy-regex` grammars have no
  backtracking limit, so a hostile fence body can hang a render per
  debounced keystroke. Hang, not crash — no `unwrap`s on the render hot
  path. Cap/timeout is a possible follow-up.
- Fixed: local links/images used to die on Windows (`C:\...` parsed by
  ammonia as URL scheme `c`) — see the path-resolution invariant. Covered
  by cross-platform Rust tests and Windows CI, but not verified in a real
  Windows GUI — CI proves the attribute survives sanitization, not that the
  asset protocol renders it in a Windows webview.
- "New Document" creates an untitled, never-saved tab (`path === null`
  until saved); its first save goes through `save_markdown_file_as`, not
  `save_markdown_file`. Deliberately no "Save As…" for an already-saved
  file — Save always overwrites silently. Saving an untitled tab onto a
  path already open elsewhere is refused, not merged or shadowed.
- Tab-close and app-quit both guard on unsaved changes (`confirmClosable`/
  `confirmUnsaved`); quitting with several dirty tabs prompts once per tab.
  Only covers `CloseRequested`/the quit menu item — macOS Dock Quit, Log
  Out/Restart, and force-quit send `terminate:` directly and can't be
  intercepted (see the quit-menu-item invariant); unsaved changes are lost
  there, same as before this feature. Still no crash-safe autosave.
- On Linux, `muda` silently drops unsupported menu items (`Undo`, `Redo`,
  `Minimize`, `Quit`, `Fullscreen`) — Edit shows only Cut/Copy/Paste/Select
  All, no Window menu at all (`menu.rs` gates it to macOS). Surviving GTK
  clipboard items are libxdo-simulated keystrokes, compiled out since
  tauri's `linux-libxdo` (an X11-only C dependency) is deliberately off —
  keyboard shortcuts work regardless, since muda registers no accelerator
  to steal.
- No scroll sync between the editor and preview panes in split mode.
- The split-pane divider (`attachSplitterDrag`) is drag-resizable via
  Pointer Events + `setPointerCapture`; pane widths come from one CSS
  property (`--split-ratio`). The ratio is a single global preference
  (`localStorage`'s `mdreader.splitRatio`), not per-tab — same grain as the
  theme toggle. The splitter element is created once per tab and never torn
  down, same create-once lifetime as the rest of a tab's DOM. No keyboard
  resize (no `tabindex` on the separator) — a bigger decision than "make
  the drag work," out of scope for now.
- The editor's formatting toolbar (`TOOLBAR_GROUPS`) covers
  Bold/Italic/Strikethrough/Inline-code, Heading/Blockquote/Bullet/
  Numbered/Task-list, and Link/Image/Rule/Table/Footnote — every control is
  real syntax `render.rs` enables. No Underline, deliberately — Markdown
  has no native underline syntax, and the only fake (raw `<u>`, which the
  sanitizer happens to allow) isn't MD syntax; don't add one by reaching
  for `<u>` without a real decision. Also not built: guided cell navigation
  after inserting a table, and footnote-number reuse (always increments off
  the highest existing definition).
- **`extraKeys` bindings must be built through `editorKeyName`, never
  hand-written with a `"Mod-"` prefix.** CodeMirror 5 looks `extraKeys` up
  against `addModifierNames`'s output ("Cmd-B" on macOS, "Ctrl-B"
  elsewhere, Shift outermost) and never runs it through `normalizeKeyMap`.
  Shipped bug: this app's shortcuts were originally written as `"Mod-B"`
  and matched nothing for the entire life of the split-mode feature — the
  toolbar buttons worked, the advertised shortcuts silently didn't.
  `EDITOR_SHORTCUTS` is the full current set, and every entry calls a
  function the toolbar also calls, keeping "only real Markdown syntax" true
  by construction. Cmd/Ctrl+N and +W were already correct before this.
- Fence-language resolution goes through `mode/meta.js`'s alias table,
  missing a couple of short forms (no `"py"`/`"rs"` alias, though the full
  words work) — upstream CodeMirror's own limitation.
- **Live-preview render cost has real headroom pressure on larger
  documents.** `render_timing_on_realistic_documents` (ignored by default;
  `cargo test --release -- --ignored --nocapture`) measured p50=82ms /
  p95=158ms on `fixtures/large.md` (56KB) — against the ~200ms live-preview
  debounce. Little room left for IPC/`innerHTML` reflow before a large
  document starts feeling behind while typing. Syntect's per-fence
  highlighting dominates (every fence re-highlighted on every render) — a
  content-keyed cache is the natural next step, not implemented yet.
