import assert from "node:assert/strict";
import { test } from "node:test";

import { THEME_COOKIE, readTheme, themeAttribute, themeCookie } from "./theme.ts";

test("the theme: the cookie's choice, else Auto; Light and Dark on <html>, Auto nothing", () => {
  assert.equal(readTheme("light"), "light");
  assert.equal(readTheme("dark"), "dark");
  assert.equal(readTheme("auto"), "auto");
  assert.equal(readTheme("sepia"), "auto");
  assert.equal(readTheme(null), "auto");
  assert.equal(themeAttribute("light"), "light");
  assert.equal(themeAttribute("auto"), undefined);
  assert.equal(themeCookie("dark", true), `${THEME_COOKIE}=dark; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
  assert.ok(!themeCookie("dark", false).includes("Secure"));
});
