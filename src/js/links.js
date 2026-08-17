// Routing clicks/keydowns on rendered content: local images, local links, and external URLs.

// render.rs already resolved every local image destination to an absolute
// filesystem path and put it in data-path, never src — see the
// path-resolution invariant in CLAUDE.md for why (ammonia applies URL rules
// to src=, and a Windows path like C:\... parses as URL scheme "c" and gets
// silently dropped). A remote or data-URI <img> never gets a data-path, so
// this is a pure attribute-presence check, not path arithmetic.
function rewriteImageSources(root) {
  root.querySelectorAll("img[data-path]").forEach((img) => {
    img.src = tauri.core.convertFileSrc(img.dataset.path);
  });
}

// ---------------------------------------------------------------------
// Handing a non-markdown link to the OS (`opener.openPath`) is the one
// place this app turns untrusted document content into "run something
// outside the webview". By the time a link reaches the click handler,
// render.rs has already resolved it to an absolute filesystem path (see
// the path-resolution invariant in CLAUDE.md), so a document shipped
// alongside `install.command` / `Setup.exe` / `x.desktop` could name it
// with any link text it likes. Two layers, deliberately both:
//   1. a denylist of extensions the OS would *execute* rather than
//      *display* — refused outright, with a message;
//   2. a native yes/no dialog showing the resolved absolute path (not the
//      link text) for everything else, so a click is never silent.
// The denylist is a convenience, not the guarantee — the confirmation is.
// Never call `tauri.opener.openPath` anywhere except through
// openWithSystem.
// ---------------------------------------------------------------------
const BLOCKED_OPEN_EXTENSIONS = new Set([
  // macOS
  "app", "command", "terminal", "workflow", "scpt", "action", "pkg", "dmg",
  // Windows
  "exe", "bat", "cmd", "com", "scr", "ps1", "hta", "lnk", "msi", "pif", "vbs", "vbe", "wsf", "wsh", "reg",
  // Linux / cross-platform
  "desktop", "sh", "run", "appimage", "js", "jar",
]);

async function openWithSystem(href) {
  if (BLOCKED_OPEN_EXTENSIONS.has(extOf(href))) {
    await tauri.dialog.message(`Refusing to open this file — it looks like an executable.\n\n${href}`, {
      title: "Blocked",
      kind: "warning",
    });
    return;
  }
  const ok = await tauri.dialog.ask(`Open this file with its default application?\n\n${href}`, {
    title: "Open file",
    kind: "warning",
    okLabel: "Open",
    cancelLabel: "Cancel",
  });
  if (!ok) return;
  await tauri.opener.openPath(href).catch((err) => console.error("failed to open path", err));
}

// A resolved local link carries data-path, not href (see rewriteImageSources'
// comment above), but everything downstream of "we have a local filesystem
// path" is one decision regardless of which attribute it came from — this is
// also the click handler's own href fallback for a raw <a href> the document
// wrote itself in literal HTML (never touched by render.rs's resolution,
// since it isn't markdown link syntax).
function activateLocalPath(path) {
  if (markdownExtensions.has(extOf(path))) {
    openPaths([path]);
  } else {
    openWithSystem(path);
  }
}

// Delegated once on the shared container rather than per-link per-render:
// tabs' content persists, so this fires for every tab without rebinding.
// In-page `#anchor` clicks are handled here too (not left to the browser)
// because every open tab's headings live in the same document at once —
// default fragment navigation can't tell which tab's heading you meant.
els.contentWrap.addEventListener("click", (e) => {
  const a = e.target.closest("a[href], a[data-path]");
  if (!a) return;
  e.preventDefault();

  if (a.dataset.path) {
    activateLocalPath(a.dataset.path);
    return;
  }

  const href = a.getAttribute("href");
  if (!href) return;

  if (href.startsWith("#")) {
    const tab = state.tabs[state.activeIndex];
    tab?.contentEl.querySelector(`#${CSS.escape(href.slice(1))}`)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
    return;
  }
  if (isExternal(href)) {
    tauri.opener.openUrl(href).catch((err) => console.error("failed to open url", err));
    return;
  }
  activateLocalPath(href);
});

// role="link" tabindex="0" (render.rs) makes a data-path <a> focusable, same
// as a real href would — but an <a> with no href fires no native "click"
// activation on Enter/Space, so that has to be replicated here explicitly.
els.contentWrap.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const a = e.target.closest("a[data-path]");
  if (!a) return;
  e.preventDefault();
  activateLocalPath(a.dataset.path);
});
