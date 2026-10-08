// Persistent recently opened documents and their welcome-screen lists.

const RECENT_FILES_KEY = "mdreader.recentFiles";
const RECENT_FILES_LIMIT = 5;

function readRecentFiles() {
  let stored;
  try {
    stored = JSON.parse(localStorage.getItem(RECENT_FILES_KEY) ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(stored)) return [];

  const seen = new Set();
  return stored
    .filter((path) => {
      if (typeof path !== "string" || path.length === 0 || seen.has(path)) return false;
      seen.add(path);
      return true;
    })
    .slice(0, RECENT_FILES_LIMIT);
}

function writeRecentFiles(paths) {
  try {
    localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(paths));
  } catch (err) {
    console.error("failed to persist recent files", err);
    return;
  }
  refreshRecentFiles();
}

function recordRecentFile(path) {
  if (typeof path !== "string" || path.length === 0) return;
  const paths = [path, ...readRecentFiles().filter((storedPath) => storedPath !== path)];
  writeRecentFiles(paths.slice(0, RECENT_FILES_LIMIT));
}

function removeRecentFile(path) {
  const current = readRecentFiles();
  const next = current.filter((storedPath) => storedPath !== path);
  if (next.length !== current.length) writeRecentFiles(next);
}

function renderRecentFiles(root) {
  if (!root) return;
  const list = root.querySelector(".recent-files-list");
  const paths = readRecentFiles();
  root.hidden = paths.length === 0;
  list.replaceChildren();

  for (const path of paths) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "recent-file";
    button.title = path;

    const name = document.createElement("span");
    name.className = "recent-file-name";
    name.textContent = basename(path);

    const fullPath = document.createElement("span");
    fullPath.className = "recent-file-path";
    fullPath.textContent = path;

    button.append(name, fullPath);
    button.addEventListener("click", () => openPaths([path]));
    item.appendChild(button);
    list.appendChild(item);
  }
}

function refreshRecentFiles() {
  document.querySelectorAll("[data-recent-files]").forEach(renderRecentFiles);
}
