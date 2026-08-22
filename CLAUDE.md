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
| `src-tauri/tauri.conf.json` | `bundle.fileAssociations` is the **single source of truth** for which extensions this app handles — it drives the OS-level file association *and* is read back at runtime (`lib.rs`'s `configured_extensions`) for argv/drop filtering and the `markdown_extensions` command. Don't hardcode the extension list anywhere else. |
| `src-tauri/icons/app-icon.svg` | The app icon's only hand-authored source (monoline "MD" monogram, pupil dot in the D's counter — on `--accent`, `src/styles.css`). Every other file in `src-tauri/icons/` is generated from it via `npm run icon`; don't hand-edit those. Letterforms are stroked `<path>`s, not `<text>` — `tauri icon` rasterizes with resvg and must not depend on system font resolution. The generator also writes `ios/`/`android/` subfolders and a `64x64.png`; delete the `ios`/`android` dirs after regenerating (this project is desktop-only, see below) — `64x64.png` is harmless unreferenced output, same as the `Square*Logo.png`/`StoreLogo.png` Windows Store assets `tauri.conf.json`'s `bundle.icon` doesn't list. |
| `src/js/` | All frontend logic — tabs, TOC, find, theme, zoom, drag-drop, lazy-loading, edit mode (split-pane source + live preview) — split across 18 classic scripts (`tauri.js`, `helpers.js`, `dom.js`, `state.js`, `theme.js`, `zoom.js`, `loaders.js`, `toc.js`, `links.js`, `tabs.js`, `save.js`, `editor-commands.js`, `splitter.js`, `edit-mode.js`, `preview.js`, `find.js`, `modal.js`, `main.js`), loaded by `src/index.html` in that fixed order. See the "classic scripts, not ES modules" invariant below before touching load order or adding a 19th file. The only JS outside `src/vendor/`. `modal.js` owns both of the app's modals — the three-button unsaved-changes one and the About dialog (`#about-backdrop`) — and the welcome-screen support link is hand-synced between `index.html`'s `#empty-state` and `#welcome-pane-template`, same as the rest of that pair's markup. |
| `src/vendor/` | Mermaid + KaTeX + CodeMirror 5, vendored (no CDN, no npm dependency at runtime). Don't add a bundler to manage these. |
| `fixtures/demo.md` | Exercises every rendering feature (tables, task lists, code, mermaid, math, footnotes, raw HTML) — use it to sanity-check rendering changes. |

## Comment discipline

Default to no comment — code should read clearly from naming and structure
alone. Add one only when it carries information the code itself can't: *why*
a non-obvious choice was made, a constraint from outside this file (an
OS/library/framework quirk), or a historical footgun ("this was a real,
shipped bug") — the kind already throughout the Invariants section below and
`render.rs`/`lib.rs`/`src/js/`. Never add a comment that just restates what
the next line does; if a comment only explains *what*, delete it or rename
something instead. This is guidance for new code, not a mandate to strip
existing rationale comments as a side effect of an unrelated change.

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

- **Path resolution stays in Rust, not JavaScript — and a resolved path
  lives in `data-path`, never `src`/`href`.** `render.rs` resolves every
  relative image/link destination to an absolute filesystem path (using
  `std::path`, which has real Windows/POSIX semantics) and grants the
  asset-protocol scope for exactly the image files it found. It emits that
  path into a `data-path` attribute (see `resolve_event` / `resolve_local_image`
  in `render/events.rs`), not `src`/`href` — ammonia applies URL semantics to
  those, and a resolved Windows path (`C:\Users\...`) parses as URL scheme
  `c`, which isn't in ammonia's scheme allowlist, so the whole attribute is
  silently dropped. This was a real, shipped bug: every local image and
  local link was dead on Windows, hidden by Rust unit tests that hardcoded
  POSIX-only base dirs (`render/testutil.rs`'s `tdir`/`abs` helpers now
  build paths cross-platform). `render/sanitize.rs`'s ammonia builder
  allowlists `data-path` (plus `role`/`tabindex`, needed because an `<a>`
  with no `href` gets neither keyboard focus nor a pointer cursor for free)
  scoped to `img`/`a` specifically — don't widen it to `add_generic_attributes`.
  The frontend never joins paths or sniffs separators — `js/links.js`'s
  `rewriteImageSources` and click handler just read `data-path` off the
  element and hand it to `convertFileSrc`/`openPaths`/`openWithSystem`
  verbatim. If you find yourself adding `.split('/')`-style path logic to
  the frontend, stop — it belongs in `render.rs`. External/anchor/scheme'd
  destinations are unaffected: `render/paths.rs`'s `resolve_local` returns
  `None` for those, so they keep flowing through pulldown-cmark's normal
  `href=`/`src=` output.

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
  own persistent `<article>` element (`js/state.js`'s `state.tabs[i].contentEl`);
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
  gate `ensureMermaid()`/`ensureKatex()` in `js/loaders.js` — a plain document
  must never fetch either bundle. If you add a new heavy client-side
  feature, follow the same pattern (a boolean flag from Rust, a memoized
  loader promise in JS).

- **The editor's two CodeMirror theme layers are disjoint by *namespace*,
  not by a hand-picked class list — don't merge them, and don't add a
  third scheme.** `enterSplitMode` (`edit-mode.js`) sets
  `theme: "mdreader mdreader-syntax"` (CodeMirror applies both as separate
  classes on the same wrapper simultaneously — verified against
  `lib/codemirror.js`'s theme option handler, not assumed) *and* passes
  `mode: { name: "gfm", highlightFormatting: true, tokenTypeOverrides:
  MARKDOWN_TOKEN_TYPES }`. `MARKDOWN_TOKEN_TYPES` (`edit-mode.js`, next to
  `createEditorToolbar`) renames every key in markdown.js's own
  `tokenTypes` table to an `md-`-prefixed class, so Markdown's structural
  tokens (`cm-md-header`, `cm-md-strong`, `cm-md-link`, `cm-md-punct`, …)
  can never collide with a plain CodeMirror code-token class — freeing the
  *entire* CodeMirror vocabulary for the generated theme, rather than the
  three classes (`cm-comment`/`cm-variable-2`/`cm-tag`) it used to have to
  avoid. `cm-s-mdreader` (hand-written, `styles.css`) owns chrome —
  background, gutters, cursor, selection — plus every `cm-md-*` rule.
  `cm-s-mdreader-syntax` (generated by `build.rs`'s
  `generate_codemirror_theme_css`, from the *same* two vendored themes the
  read-only preview uses — see the theme-sourcing invariant below) owns
  only plain CodeMirror code-token classes, so a document's fence colors
  match whether you're viewing or editing it.
  `tests/pure-helpers.test.mjs` asserts `MARKDOWN_TOKEN_TYPES` covers every
  key markdown.js defines and that every value is `md-`-prefixed — the
  guarantee is only as good as that map being complete, and a future
  CodeMirror bump could add a token type silently.
  `highlightFormatting: true` is load-bearing, not cosmetic: markdown.js
  defaults it *off*, which means a syntax marker (`#`, `**`, `>`, `` ` ``,
  `[]()`, list bullets) shares its content's own token class with no way
  to style the marker differently — turning it on, plus `cm-md-punct`
  being declared *last* in styles.css's `.cm-s-mdreader` block (same
  specificity as every content rule above it, so source order decides the
  winner on a token that carries both classes), is what makes the editor
  read as flat, source-first text instead of a second copy of the preview.
  Four token classes are hardcoded by markdown.js/gfm.js *outside*
  `tokenTypeOverrides`' reach — `meta`/`property` (task checkboxes) and a
  bare `url`/`link` (autolinks, image alt text) — and are styled directly
  by their original names in `styles.css`, each with a comment explaining
  which token emits them. The task-checkbox rule needs an extra
  specificity bump (`.cm-s-mdreader.CodeMirror .cm-meta`, not
  `.cm-s-mdreader .cm-meta`) for a reason worth internalizing: unlike
  `code-theme-*.css` (linked eagerly, before `styles.css`, in
  `index.html`), `codemirror-theme-*.css` is only injected into `<head>`
  lazily on first editor open (`loaders.js`'s `ensureCodeMirror`) — i.e.
  *after* `styles.css` — so on equal specificity the generated theme's
  `cm-meta`/`cm-property` rule (if the current theme pair happens to
  define one) would win every tie without it.

- **Both syntax themes come from two vendored VS Code theme JSON files,
  not syntect's bundled `ThemeSet::load_defaults()` — and their names are
  deliberately never surfaced in the UI.** `src-tauri/themes/one-dark-pro.json`
  / `one-light.json` are vendored verbatim (MIT, see
  `themes/LICENSE-THEMES.md`; same no-CDN policy as `src/vendor/`).
  `build.rs`'s `load_vscode_theme` converts one into a syntect `Theme`
  directly — a VS Code theme's `tokenColors` array *is* a TextMate scope
  table, so each entry's `scope`/`settings.foreground`/`settings.background`
  maps straight onto `ThemeItem`/`StyleModifier`, no plist round-trip
  needed. `settings.fontStyle` is deliberately never read: the editor's
  Markdown tokens render flat by design (previous invariant), and
  `css_for_theme_with_class_style`'s own output (the read-only preview)
  never emits it either. An unparseable scope or a non-token (scopeless)
  `tokenColors` entry is skipped with a `cargo:warning`, never a panic —
  one odd entry in a 200+-rule upstream file must not break the build.
  `generate_code_theme_css` additionally prepends a `:root { --syntax-*: …
  }` block (`syntax_root_css`) to `code-theme-{light,dark}.css` — chrome
  values (`--syntax-bg`/`-fg`/`-gutter-bg`/`-gutter-fg`/`-selection`/
  `-caret`/`-line-highlight`) straight from the theme's `ThemeSettings`,
  plus a handful of Markdown-scope lookups (`--syntax-md-header`, `-strong`,
  `-list`, …) resolved through the *same* `Highlighter::style_for_stack`
  call the code-token generator uses, so a color is never hand-picked
  where the theme itself defines one. This lives in `code-theme-*.css`
  specifically (not `codemirror-theme-*.css`) because it's linked eagerly
  in `index.html` and swapped by `theme.js`'s `setCodeThemeLink`, so the
  properties exist from first paint — `codemirror-theme-*.css` is only
  injected lazily on first editor open and can't host a token the preview
  pane's fence background needs in a session that never opens the editor.
  The corollary: because `styles.css` is linked *after* `code-theme-*.css`,
  it must never redefine any `--syntax-*` name in its own `:root` — that
  would win the cascade and pin every theme to whichever was linked last.
  It only ever reads them as `var(--syntax-x, var(--editor-x))`, with the
  pre-existing `--editor-*`/`--text-*`/`--code-bg` tokens kept purely as
  fallbacks. `tests/contracts.rs`'s
  `syntax_custom_properties_defined_in_both_themes` and
  `generated_code_theme_css_has_substantial_rule_count` guard against a
  typo'd property name (silently degrades to its fallback, no error) and a
  broken conversion (silently drops most scopes) respectively.

- **The write path is one narrow, validated command — not
  `tauri-plugin-fs`.** `save_markdown_file` (`commands.rs`) is the app's
  only filesystem write. It's a deliberately small custom command rather
  than the fs plugin, which would need a broad ACL scope grant reachable
  by any code running in the webview — this app renders untrusted
  markdown, so keeping the write surface to one extension-validated path
  is a meaningfully smaller attack surface. It validates the target
  extension via `is_markdown_path` (`files.rs`) before writing, and writes
  atomically (temp file
  in the *same* directory, then `rename` over the target — same-directory
  matters because a cross-filesystem rename isn't atomic). Don't widen
  this into a general-purpose write command, and don't add
  `tauri-plugin-fs` alongside it.

- **Every path-taking Tauri command validates the extension Rust-side —
  the JS filters are UX, not the boundary.** `require_markdown_path`
  (`files.rs`) gates `open_markdown_file`, `read_markdown_source`, and
  `save_markdown_file` alike (all three now in `commands.rs`). The open
  dialog and drop handler (`js/main.js`) and link click (`js/links.js`)
  also filter by extension in the frontend, but a compromised webview
  can call `invoke` directly, so a command that would read or write
  `~/.ssh/id_rsa` when handed that path is a real hole regardless of
  what the frontend does. Any new command that takes a path goes
  through `require_markdown_path` (or a stricter check) first.

- **`opener.openPath` is only ever called via `openWithSystem`
  (`js/links.js`), which denylists executable extensions and then shows a
  native confirm with the resolved absolute path.** By the time a link
  reaches the click handler, `render.rs` has resolved it to an absolute
  filesystem path — including `../` escapes above the document's own
  directory (deliberate; `relative_links_may_escape_base_dir` pins it).
  `opener:allow-open-path` has no scope, so a document shipped next to
  `install.command` / `Setup.exe` / `x.desktop` could name it under any
  link text and a bare `openPath` would run it on one click. The
  denylist (`BLOCKED_OPEN_EXTENSIONS`) is convenience; the confirmation
  dialog is the guarantee — don't add a second `openPath` call site,
  and don't make the confirm skippable.

- **`sanitize()` allows `style` on `td`/`th` only, and filters the value
  to `text-align`.** That's the one property pulldown-cmark's GFM table
  writer emits. Ammonia's default is `style_properties: None`, which
  passes a declaration block through *verbatim* — raw
  `<td style="position:fixed;inset:0;background:url(https://…)">` in a
  document would paint over the whole window and beacon out. Widen the
  `filter_style_properties` list only for a property `render/events.rs`
  itself produces, never for "a document might want it."

- **`app.security.csp` is set (`tauri.conf.json`); don't null it.** The
  app loads no remote code — every script/style/font is vendored — so
  `default-src 'self'` costs nothing and is what stands between a future
  mermaid/KaTeX/ammonia bypass and IPC access or exfil. If a change
  genuinely needs a looser directive, loosen *that one directive* and
  say why in a comment next to it; `'unsafe-inline'` for `style-src` is
  already there because mermaid/KaTeX/CodeMirror set inline styles, and
  `img-src` deliberately keeps `https:`/`http:` so documents' remote
  images still load (a tracking-pixel trade-off, made knowingly).

- **`scope.allow_file` grants are additive and never revoked, and live
  preview calls `render_and_grant` on every debounced keystroke.**
  `render()`'s asset list reflects whatever an image destination
  *currently* is, including a half-typed path mid-edit
  (`![](diagram.png)` grants scope for `d`, `di`, `dia`, … along the way
  if ungated). `render_and_grant` (`commands.rs`) filters to
  `Path::is_file()` before granting for exactly this reason — don't remove
  that filter, and don't add another `scope.allow_file` call site that
  skips it.

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

- **The native menu is hand-built, and `PredefinedMenuItem::close_window`
  is deliberately absent from every submenu.** `tauri::menu::Menu::default()`
  can't be reused for two verified reasons: its File submenu is
  `#[cfg(not(any(target_os = "linux", "dragonfly", "freebsd", "netbsd",
  "openbsd")))]` — there is no File submenu on Linux at all — and its
  File/Window submenus both carry `PredefinedMenuItem::close_window`,
  which `muda` gives the Cmd+W accelerator on macOS. AppKit resolves menu
  key equivalents before the webview ever sees the keystroke, so that item
  would hijack this app's own Cmd+W ("close the active tab," wired in
  `js/main.js`'s global keydown handler) and close the whole window instead.
  `menu.rs` hand-builds every submenu instead, and omits `close_window`
  everywhere. Don't add it back, and don't switch back to `Menu::default()`.
  `PredefinedMenuItem::about` is likewise replaced with a custom `ABOUT`
  id, because macOS's `NSAboutPanel` (what the predefined item renders)
  can't host a clickable link — About now opens an app-controlled HTML
  dialog (`index.html`'s `#about-backdrop`, wired in `js/modal.js`/
  `js/main.js`) through the same `menu-action` string-event pipe every
  other menu action already uses.

- **Quit routes through a custom menu item (`menu.rs`'s `QUIT`), never
  `PredefinedMenuItem::quit`.** Traced through the `tauri`/`muda`/`tao`
  crate sources: `muda`'s macOS predefined Quit sends `terminate:` to
  `NSApp`; `tao`'s `NSApplicationDelegate` implements only
  `applicationWillTerminate`, never `applicationShouldTerminate`, so
  there's no veto point; `tauri-runtime-wry` produces
  `RunEvent::ExitRequested` from exactly two places (a window-destroyed
  event, and `AppHandle::exit`/`restart`) — neither reachable from
  `terminate:`. The predefined item would therefore terminate the process
  with **no interceptable event at all**, silently bypassing the
  unsaved-changes quit sequence. The corollary: `AppHandle::exit(0)` (via
  `quit_app`, `commands.rs`) is the only sanctioned way this app ends itself — it's the
  one path that produces an *unprevented* `ExitRequested` without
  re-entering `WindowEvent::CloseRequested`, so the frontend's
  already-confirmed quit sequence can't loop back into its own prompt.
  `window.destroy()` was deliberately not used — it needs its own
  capability grant, where `AppHandle::exit` needs none.

- **`WindowEvent::CloseRequested` is prevented synchronously, and the
  emit that hands off to JS is gated on `frontend_ready`.** The runtime
  checks whether `CloseRequestApi::prevent_close()` was called immediately
  after running listeners — any `await` first and the window closes
  anyway, so `lib.rs`'s `on_window_event` handler can only prevent-and-emit
  in one synchronous step, never await the frontend's answer. And emitting
  `"close-requested"` before `js/main.js`'s listener for it exists would lose
  the event outright (Tauri doesn't replay events) — the same race
  `AppState`'s `pending`/`files-pending` queue already guards against, just
  on the way out instead of the way in. `frontend_ready` (flipped by the
  `mark_frontend_ready` command in `commands.rs`, called only after `init()`
  in `js/main.js` has registered both the `close-requested` and
  `menu-action` listeners) is what makes the window still closable if the
  frontend never finishes loading.

- **App-wide zoom uses the webview's native page zoom
  (`commands.rs`'s `set_zoom` → `Webview::set_zoom`), never CSS `zoom`/
  `transform: scale`.** CodeMirror 5 measures character cells via
  `getBoundingClientRect`, which a transformed/zoomed ancestor breaks —
  native page zoom is ordinary browser zoom, which the editor already
  handles correctly. `tauri.conf.json`'s window config deliberately never
  sets `zoomHotkeysEnabled`: that option injects a polyfill
  (`zoom-hotkey.js`) with its own un-persisted zoom counter, which would
  desync from this app's `js/zoom.js` state and double-step on every
  keypress. `set_zoom` is a custom command rather than the core plugin's
  `plugin:webview|set_webview_zoom` specifically to avoid adding
  `core:webview:allow-set-webview-zoom` to `capabilities/default.json` — same
  reasoning as `save_markdown_file` staying off `tauri-plugin-fs`. `WKWebView.setPageZoom:`
  is macOS 11+, which is why `bundle.macOS.minimumSystemVersion` is `"11.0"`,
  not `"10.15"`.
  The native `View` menu accelerators (`menu.rs`'s `ZOOM_IN`/`ZOOM_OUT`,
  `"CmdOrCtrl+Equal"`/`"CmdOrCtrl+Minus"`) and `js/main.js`'s keydown
  branch for zoom are deliberately disjoint key sets, not two paths to the
  same shortcut: the menu owns the unshifted main-row `=`/`-` keys, and the
  JS branch only handles the shifted `+` (`Cmd+Shift+Equal`) and the numpad
  Add/Subtract keys (matched by `e.code`, since `NumpadSubtract`'s `e.key`
  is the same `"-"` string the menu's physical `Minus` key already owns).
  "Actual Size" carries no accelerator at all — `Cmd/Ctrl+0` is already
  `editor-commands.js`'s "clear heading" binding inside the editor, and a
  macOS menu key equivalent is resolved by AppKit before the webview ever
  sees the keystroke, which would silently kill that editor shortcut.

- **`tauri_plugin_single_instance` is registered on Windows/Linux only**
  (`#[cfg(not(target_os = "macos"))]` in `lib.rs`). On macOS it forwards
  `argv` to an already-running instance — but a file opened via
  Finder/"Open With" never appears in `argv` there, it arrives via
  `RunEvent::Opened` directly on whichever process macOS's LaunchServices
  routes to (including an already-running one, no second process spawned
  at all). Registering the plugin on macOS meant a repeat "Open With"
  connected to the running instance and forwarded an empty argv,
  silently dropping the file — this was a real, shipped bug.

- **The frontend is deliberately N classic scripts sharing one global
  lexical scope — not ES modules, not IIFEs.** `src/index.html` loads
  `src/js/*.js` as 18 plain `<script src>` tags, in the fixed order listed
  in the file map above. Two reasons this can't become `type="module"` or
  get wrapped: the JS test suite (`tests/harness.mjs`) evaluates the
  concatenated source and appends an epilogue that reads top-level
  `const`/`let` bindings (`state`, `els`, `EDITOR_SHORTCUTS`, …) by bare
  name — that only resolves because every file shares one script-level
  scope; and several tests (`tests/tabs.test.mjs`, `tests/link-routing.test.mjs`)
  stub an internal function by reassigning `window.<fn>` and asserting a
  *different* top-level function's call to it was intercepted — under
  modules or an IIFE that call binds lexically at declaration time and the
  stub becomes a silent no-op. Load order matters only for what runs at
  script-evaluation time rather than inside a later function call:
  `js/dom.js`'s `els` must precede `js/toc.js` and `js/links.js` (both
  register listeners on `els.*` at load, not inside `init()`), and
  `js/main.js` must be last — it ends with a bare `init();`. Don't move
  those three listener registrations into `wireStaticUI`; `js/main.js`'s
  `init()` is never called by the test harness (see `tests/harness.mjs`'s
  `TRAILING_INIT_CALL`), so anything the app needs before a real page load
  has to run at script-evaluation time the way those three already do.

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

- Developed and tested on macOS only so far. Windows file-association
  registration (NSIS installer, registry `ProgId`) and Linux (`.desktop`
  MIME handling, WebKitGTK rendering quirks — see the "Known risks"
  history in past planning) are implemented per Tauri's documented
  behavior but not yet verified on real Windows/Linux machines.
- **macOS builds are ad-hoc signed, not notarized; Windows/Linux builds
  are unsigned.** `bundle.macOS.signingIdentity: "-"` in
  `tauri.conf.json` exists specifically because `--target
  universal-apple-darwin`'s `lipo` step invalidates each arch's implicit
  ad-hoc signature — without an explicit identity, Tauri skips
  `codesign` entirely and Apple Silicon refuses to launch the result at
  all ("app is damaged," not recoverable by any Gatekeeper override). Ad-hoc
  signing downgrades that to the ordinary "unidentified developer"
  prompt, cleared via System Settings → Privacy & Security → Open Anyway
  (macOS 15 removed the old right-click → Open bypass — see README.md's
  "Download & install"). `hardenedRuntime` is
  explicitly set to `false` there too (the schema default is `true`) —
  hardened runtime only pays off once notarized, and without a matching
  entitlements file it can break the webview's JIT. If an Apple
  Developer cert is ever bought, notarize, flip `hardenedRuntime` back
  to `true`, and add an entitlements plist with
  `com.apple.security.cs.allow-jit`. Windows SmartScreen still warns —
  no code-signing pipeline exists for Windows, that needs a paid cert
  or an approved free-for-OSS signer (e.g. SignPath Foundation), neither
  wired up yet. Releases are tag-driven (`v*` push) via
  `.github/workflows/build.yml`'s `release` job, and every installer
  ships a `SHA256SUMS-*.txt` alongside it — see `README.md`'s
  "Download & install".
- No auto-update mechanism.
- Sanitizer/DoS headroom not addressed yet: `unique_id` in
  `render/headings.rs` is quadratic on N duplicate headings, and syntect's `fancy-regex`
  grammars have no backtracking limit, so a hostile fence body can hang
  a render (per debounced keystroke in split mode). Hang, not crash —
  `panic = "abort"` only matters for real panics, and there are no
  `unwrap`s on the render hot path. Cap/timeout is a possible follow-up.
- Fixed: local links/images used to die on Windows (`C:\...` in `src=`/
  `href=` parsed by ammonia as URL scheme `c` and dropped) — see the
  path-resolution invariant above for the `data-path` fix. Covered by
  cross-platform Rust unit tests (`render/testutil.rs`'s `tdir`/`abs` test
  helpers) and by Windows CI (`.github/workflows/build.yml`'s `check` job), but
  still not verified in a real Windows GUI — CI proves the attribute
  survives sanitization with a drive letter, not that the Tauri asset
  protocol renders that path in a Windows webview.
- "New Document" (`newDocument` in `js/tabs.js`) creates an untitled,
  never-saved tab (`tab.path === null` until a successful save); its first
  Cmd/Ctrl+S goes through `saveTabAs`/`save_markdown_file_as` instead of
  `save_markdown_file`. There is deliberately **no "Save As…"** for a file
  that's already been saved once — Save always overwrites its existing
  path silently, same as before this feature. Saving an untitled tab onto
  a path that's already open in another tab is refused with a message
  dialog rather than merging or shadowing the two tabs.
- Both tab-close and app-quit now guard on unsaved changes (the shared
  three-button modal driven by `confirmClosable` in `js/tabs.js` /
  `confirmUnsaved` in `js/modal.js`), and quitting with several dirty tabs prompts once per tab,
  switching to each one first. This only covers the paths that go through
  `WindowEvent::CloseRequested` or the quit menu item — macOS Dock icon →
  Quit, Log Out/Restart, and a force-quit all send `terminate:` directly
  (see the quit-menu-item invariant above) and cannot be intercepted;
  unsaved changes are lost on those specific paths, same as before this
  feature. Still no crash-safe autosave.
- On Linux, `muda` silently drops menu items it doesn't support on GTK —
  confirmed for `Undo`, `Redo`, `Minimize`, `Quit`, `Fullscreen` — so the
  Edit menu there shows only Cut/Copy/Paste/Select All, and there is no
  Window menu at all (`menu.rs` gates it to macOS for exactly this
  reason). Those surviving GTK clipboard items are also libxdo-simulated
  keystrokes, compiled out unless tauri's `linux-libxdo` feature is
  enabled — deliberately left off (an X11-only C dependency, one this
  project otherwise avoids — see `Cargo.toml`'s `regex-fancy` comment).
  The keyboard shortcuts work regardless, since muda registers no GTK
  accelerator for these items to steal.
- No scroll sync between the editor and preview panes in split mode.
- The split-pane divider (`js/splitter.js`'s `attachSplitterDrag`) is
  drag-resizable via Pointer Events + `setPointerCapture` — the pane
  widths come from one CSS custom property (`--split-ratio`, set on each
  `.tab-pane`) so the drag handler only ever writes one number. The ratio
  is a single global preference (`localStorage`'s `mdreader.splitRatio`),
  not per-tab — same "one persisted setting" grain as the theme toggle.
  The splitter element itself is created once per tab (in `enterSplitMode`,
  alongside `editorEl`) and its listeners are never torn down, the same
  create-once/keep-alive lifetime the rest of a tab's DOM already follows
  — so there's deliberately no cleanup path in `exitSplitMode`. No
  keyboard resize (no `tabindex` on the separator) — that would need its
  own keydown handling alongside the app's global handler and a tab-order
  decision, out of scope for the drag itself.
- The editor's formatting toolbar (`js/editor-commands.js`'s `TOOLBAR_GROUPS`) covers
  Bold/Italic/Strikethrough/Inline-code, Heading/Blockquote/Bullet-list/
  Numbered-list/Task-list, and Link/Image/Horizontal-rule/Table/Footnote —
  every control is real syntax this app's own `render.rs` enables. No
  Underline, deliberately — Markdown has no native underline syntax, and
  the only way to fake one (raw `<u>` HTML, which this app's sanitizer does
  happen to allow through) isn't "MD syntax." Don't add an underline button
  by reaching for `<u>`; if this ever changes it needs a real decision, not
  a silent workaround. Also deliberately not built: guided cell-to-cell
  navigation after inserting a table (just a static skeleton, cursor lands
  on the first header cell), and footnote-number reuse (numbering always
  increments off the highest existing `[^n]:` definition, never recycles a
  deleted one's number).
- **`extraKeys` bindings must be built through `js/editor-commands.js`'s
  `editorKeyName` (used by `EDITOR_SHORTCUTS`/`editorExtraKeys`), never hand-written with
  a `"Mod-"` prefix.** CodeMirror 5 looks `extraKeys` up as a raw object
  property against the name `addModifierNames` builds at keypress time —
  `"Cmd-B"` on macOS, `"Ctrl-B"` elsewhere, Shift outermost
  (`"Shift-Cmd-X"`, not `"Cmd-Shift-X"`) — and never runs `extraKeys`
  through `normalizeKeyMap` (which the library defines and exports but
  never calls itself). This was a real, shipped bug: this app's
  Cmd/Ctrl+Bold/Italic/Strikethrough bindings were originally written as
  `"Mod-B"` etc. and matched nothing for the entire life of the split-mode
  feature — the toolbar buttons worked, the advertised shortcuts silently
  didn't. `EDITOR_SHORTCUTS` (`js/editor-commands.js`, next to
  `TOOLBAR_GROUPS`) is the full current set — Bold/Italic/Strikethrough,
  Link (Cmd/Ctrl+K), Inline code (+Shift+C), Blockquote (+Shift+.), and
  Heading 1–6/paragraph (Cmd/Ctrl+1–6, +0) — and every entry calls a
  function the toolbar also calls, which is what keeps "only real
  Markdown syntax `render.rs` renders" true by construction rather than
  by convention. Cmd/Ctrl+N (native menu accelerator → `newWelcomeTab`)
  and Cmd/Ctrl+W (`js/main.js`'s keydown handler → `closeTab` in
  `js/tabs.js` → `confirmClosable` → the shared Save/Don't Save/Cancel
  modal) were both already correct before this and needed no change.
- Fence-language resolution goes through `mode/meta.js`'s alias table,
  which is missing a couple of short forms this project's own fixtures
  don't hit but real documents might — notably no `"py"` alias for Python
  and no `"rs"` alias for Rust (the full words work fine). Upstream
  CodeMirror's own limitation, not worth patching around.
- **Live-preview render cost has real headroom pressure on larger
  documents.** `render/tests.rs`'s `render_timing_on_realistic_documents`
  test (ignored by default; run with `cargo test --release -- --ignored
  --nocapture`) measured p50=82ms / p95=158ms on `fixtures/large.md`
  (56KB, code-fence-heavy) — against the ~200ms debounce in
  `js/preview.js`'s `schedulePreview`. That leaves little room for IPC and `innerHTML`
  reflow on top before a large document's preview starts feeling behind
  while typing. Syntect's per-fence highlighting is the dominant cost
  (every fence is re-highlighted on every render, not just the one being
  edited) — a content-keyed fence-highlight cache is the natural next
  step if this becomes noticeable in practice, but isn't implemented yet.
