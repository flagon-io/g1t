import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_THEME, THEME_CHOICES, THEME_COOKIE, readTheme, resolvedTheme, themeAttribute, themeCookie } from "./theme.ts";

test("the cookie keeps auto, light or dark, and anything else is the default", () => {
  for (const choice of THEME_CHOICES) assert.equal(readTheme(choice), choice);
  for (const junk of [null, undefined, "", "LIGHT", "sepia", "dark; Path=/"]) assert.equal(readTheme(junk), DEFAULT_THEME);
});

test("the cookie is kept a year, on every path, and secure on https", () => {
  assert.equal(themeCookie("light", true), `${THEME_COOKIE}=light; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
  assert.equal(themeCookie("auto", false), `${THEME_COOKIE}=auto; Path=/; Max-Age=31536000; SameSite=Lax`);
});

test("Light and Dark are data-theme on <html>; Auto leaves it to the system", () => {
  assert.equal(themeAttribute("light"), "light");
  assert.equal(themeAttribute("dark"), "dark");
  assert.equal(themeAttribute("auto"), undefined);
});

test("a chosen theme is itself; Auto with no browser to ask is dark", () => {
  assert.equal(resolvedTheme("light"), "light");
  assert.equal(resolvedTheme("dark"), "dark");
  assert.equal(resolvedTheme("auto"), "dark");
});
