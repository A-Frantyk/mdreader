// Source mappings and contrast of the generated application palettes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const rgb = (hex) => {
  const digits = hex.slice(1);
  const full = digits.length <= 4 ? [...digits].map((c) => c + c).join("") : digits;
  return [0, 2, 4, 6].map((offset) => parseInt(full.slice(offset, offset + 2) || "ff", 16));
};
const over = (fg, bg) => {
  const alpha = fg[3] / 255;
  return [...fg.slice(0, 3).map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha))), 255];
};
const luminance = (color) => color.slice(0, 3).reduce((sum, value, index) => {
  const s = value / 255;
  return sum + (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index];
}, 0);
const contrast = (fg, bg) => {
  const a = luminance(over(fg, bg));
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

for (const [mode, filename] of [["dark", "one-dark-pro.json"], ["light", "one-light.json"]]) {
  const source = JSON.parse(read(`src-tauri/themes/${filename}`)).colors;
  const css = read(`src/code-theme-${mode}.css`);
  const palette = Object.fromEntries([...css.matchAll(/--ui-([\w-]+):\s*(#[\da-f]+);/gi)].map((m) => [m[1], rgb(m[2])]));

  test(`${mode}: exact UI source mappings and alpha preservation`, () => {
    for (const [role, key] of [
      ["bg", "editor.background"], ["surface", "sideBar.background"],
      ["tabs", "editorGroupHeader.tabsBackground"], ["tab-bg", "tab.activeBackground"],
      ["border", "editorGroup.border"], ["input", "input.background"],
      ["button", "button.background"], ["selection", "editor.selectionBackground"],
      ["find", "editor.findMatchHighlightBackground"], ["hover", "list.hoverBackground"],
      ["selected", "list.activeSelectionBackground"],
    ]) assert.deepEqual(palette[role], rgb(source[key]), `${role} must come from ${key}`);
    if (mode === "light") {
      assert.deepEqual(palette.secondary, rgb(source["editorWidget.background"]));
      assert.deepEqual(palette["find-current"], rgb(source["editor.selectionBackground"]));
    } else {
      assert.deepEqual(palette.secondary, rgb(source["button.secondaryBackground"]));
      assert.deepEqual(palette["find-current"], rgb(source["editor.findMatchBackground"]));
      assert.notDeepEqual(palette["button-hover"], palette.button);
    }
    assert.notDeepEqual(palette["button-pressed"], palette["button-hover"]);
    assert.notDeepEqual(palette["find-current"], palette.find);
  });

  test(`${mode}: generated roles are complete and all have consumers`, () => {
    const styles = read("src/styles.css");
    const used = new Set([...styles.matchAll(/var\(--ui-([\w-]+)/g)].map((m) => m[1]));
    assert.deepEqual(new Set(Object.keys(palette)), used);
    assert.doesNotMatch(styles, /--(?:ui|syntax)-[\w-]+\s*:/);
    assert.doesNotMatch(styles, /#[\da-f]{3,8}\b|rgba?\(/i);
    assert.match(styles, /\.cm-s-mdreader\.CodeMirror \.CodeMirror-selected,/,
      "the selection theme must outrank lazily loaded CodeMirror-focused selection CSS");
  });

  test(`${mode}: UI text and focus meet contrast targets`, () => {
    const check = (role, background, minimum = 4.5) => {
      assert.ok(palette[role], `missing role ${role}`);
      const ratio = contrast(palette[role], background);
      assert.ok(ratio >= minimum, `${role} on ${background}: ${ratio.toFixed(3)} < ${minimum}`);
    };
    const surfaces = ["bg", "surface", "tabs", "input", "tab-bg"].map((role) => palette[role]);
    surfaces.push(over(palette.hover, palette.surface), over(palette.hover, palette.bg),
      over(palette["tab-hover"], palette.tabs), over(palette.selected, palette.surface));
    for (const bg of surfaces) {
      for (const fg of ["text", "muted", "accent"]) check(fg, bg);
      check("focus", bg, 3);
    }
    check("tab-text", palette["tab-bg"]);
    check("selected-text", over(palette.selected, palette.surface));
    for (const role of ["button", "button-hover", "button-pressed"]) check("button-text", palette[role]);
    check("secondary-text", palette.secondary);
    check("secondary-text", over(palette.hover, palette.surface));
    check("selection-text", over(palette.selection, palette.bg));
    for (const role of ["find", "find-current"]) check("find-text", over(palette[role], palette.bg));
    for (const role of ["bg", "surface"]) check("danger", palette[role]);
  });
}
