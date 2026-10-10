import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The shared tokens every site draws from (packages/theme/tokens.css).
const css = readFileSync(new URL("../../../../packages/theme/tokens.css", import.meta.url), "utf8");

function token(name: string): string {
  const found = css.match(new RegExp(`--g1t-${name}:\\s*(#[0-9a-f]{6});`, "i"));
  assert.ok(found, `--g1t-${name} is a six-digit hex colour`);
  return found[1].toLowerCase();
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("the accent is the logo's lavender, and mint means success", () => {
  assert.equal(token("accent"), "#b6a8ff");
  assert.equal(token("success"), "#86efc4");
});

test("merged reads apart from the accent", () => {
  assert.notEqual(token("merged"), token("accent"));
  assert.notEqual(token("merged"), token("success"));
});

test("text colours meet WCAG AA on every surface", () => {
  for (const surface of ["bg", "surface", "raised"]) {
    for (const ink of ["fg", "muted", "accent", "success", "merged", "info", "warn", "danger"]) {
      const ratio = contrast(token(ink), token(surface));
      assert.ok(ratio >= 4.5, `--g1t-${ink} on --g1t-${surface} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test("the dark base reads on an accent or success button", () => {
  for (const fill of ["accent", "accent-hover", "success"]) {
    const ratio = contrast(token("bg"), token(fill));
    assert.ok(ratio >= 4.5, `--g1t-bg on --g1t-${fill} is ${ratio.toFixed(2)}:1`);
  }
});

test("focus borders in the dim accent stand out from the page", () => {
  assert.ok(contrast(token("accent-dim"), token("bg")) >= 3);
});

// The light palette (Appearance, lib/theme.ts): the same names after `light-`.

test("the light accent is a deeper lavender, and light success is green", () => {
  assert.equal(token("light-accent"), "#6b52c8");
  assert.equal(token("light-success"), "#0d7a52");
});

test("every dark token has a light one", () => {
  const dark = [...css.matchAll(/--g1t-(?!light-|font-)([a-z-]+):/g)].map((match) => match[1]);
  assert.ok(dark.length > 10);
  for (const name of dark) token(`light-${name}`);
});

test("light text colours meet WCAG AA on every light surface", () => {
  for (const surface of ["bg", "surface", "raised"]) {
    for (const ink of ["fg", "fg-soft", "muted", "faint", "accent", "accent-hover", "success", "merged", "info", "warn", "danger"]) {
      const ratio = contrast(token(`light-${ink}`), token(`light-${surface}`));
      assert.ok(ratio >= 4.5, `--g1t-light-${ink} on --g1t-light-${surface} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test("the light page reads on an accent or success button", () => {
  for (const fill of ["accent", "accent-hover", "success"]) {
    const ratio = contrast(token("light-bg"), token(`light-${fill}`));
    assert.ok(ratio >= 4.5, `--g1t-light-bg on --g1t-light-${fill} is ${ratio.toFixed(2)}:1`);
  }
});

test("light focus borders in the dim accent stand out from the page", () => {
  assert.ok(contrast(token("light-accent-dim"), token("light-bg")) >= 3);
});
