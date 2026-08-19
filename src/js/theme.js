// Light/dark theme preference, persisted and applied across preview, mermaid, and the editor.

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

// On first launch the OS's current theme preference is read once and
// persisted as an explicit choice; the app never re-consults the OS
// after that, so a later OS theme flip doesn't silently relabel anything.
const THEME_KEY = "mdreader.theme";
const THEME_ICON = { light: "☀", dark: "☾" };

function themePreference() {
  let pref = localStorage.getItem(THEME_KEY);
  if (!pref) {
    pref = darkQuery.matches ? "dark" : "light";
    localStorage.setItem(THEME_KEY, pref);
  }
  return pref;
}

function setCodeThemeLink(theme) {
  els.codeThemeLink.href = theme === "dark" ? "code-theme-dark.css" : "code-theme-light.css";
}

async function applyTheme() {
  const pref = themePreference();
  document.documentElement.dataset.theme = pref;
  setCodeThemeLink(pref);
  // Only exists once edit mode has been entered at least once (see
  // ensureCodeMirror) — a session that never opens the editor never
  // creates this link, so there's nothing to flip.
  if (cmSyntaxThemeLink) {
    cmSyntaxThemeLink.href = pref === "dark" ? "codemirror-theme-dark.css" : "codemirror-theme-light.css";
  }
  els.themeBtn.textContent = THEME_ICON[pref];
  els.themeBtn.title = `Theme: ${pref[0].toUpperCase()}${pref.slice(1)}`;
  await refreshMermaidTheme();
}

async function refreshMermaidTheme() {
  for (const tab of state.tabs) {
    if (tab.rendered && tab.hasMermaid) await renderMermaidFor(tab, { restore: true });
  }
}

function cycleTheme() {
  const next = themePreference() === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme();
}
