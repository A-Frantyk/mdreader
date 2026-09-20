// Routing clicks/keydowns on rendered content: local images, local links, and external URLs.

// data-path, not src — see CLAUDE.md's path-resolution invariant. A remote/data-URI
// <img> never gets one, so this is a pure attribute-presence check.
function rewriteImageSources(root) {
  root.querySelectorAll("img[data-path]").forEach((img) => {
    img.src = tauri.core.convertFileSrc(img.dataset.path);
  });
}

// The one place untrusted document content can run something outside the webview.
// Two layers: a denylist of executable extensions (convenience), and a confirm dialog
// showing the resolved absolute path (the guarantee). Never call opener.openPath
// anywhere except through this function.
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

// Also the fallback for a raw <a href> the document wrote in literal HTML — never
// touched by render.rs's resolution, since it isn't markdown link syntax.
function activateLocalPath(path) {
  if (markdownExtensions.has(extOf(path))) {
    openPaths([path]);
  } else {
    openWithSystem(path);
  }
}

// Delegated once: tabs' content persists, so this fires for every tab without rebinding.
// #anchor clicks are handled here, not left to the browser — default fragment
// navigation can't tell which open tab's heading you meant.
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

// An <a> with no href fires no native "click" on Enter/Space, so replicate it here.
els.contentWrap.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const a = e.target.closest("a[data-path]");
  if (!a) return;
  e.preventDefault();
  activateLocalPath(a.dataset.path);
});
