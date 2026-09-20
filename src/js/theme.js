// Light/dark theme preference, persisted and applied across preview, mermaid, and the editor.

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

// The OS preference is read once on first launch and persisted; a later OS flip
// never silently relabels the app's own choice.
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
  // Only exists once edit mode has been entered at least once — see ensureCodeMirror.
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
