import assert from "node:assert/strict";
import { test } from "node:test";

import { safeNext, withNext } from "./next.ts";

test("a path on g1t is kept, with its query and fragment", () => {
  assert.equal(safeNext("/acme/web"), "/acme/web");
  assert.equal(safeNext("/acme/web/issues?state=closed#top"), "/acme/web/issues?state=closed#top");
  assert.equal(safeNext("/device?code=ABCD-EFGH"), "/device?code=ABCD-EFGH");
});

test("anything that could leave g1t goes home instead", () => {
  for (const raw of [
    null,
    undefined,
    "",
    "acme/web",
    "https://evil.example/",
    "//evil.example/",
    "/\\evil.example/",
    "/\\/evil.example/",
    "\\\\evil.example",
    "/%5C%5Cevil.example".replace(/%5C/g, "\\"),
    "/\t/evil.example",
    "/\n/evil.example",
    "/%0a",
    "javascript:alert(1)",
  ]) {
    const kept = safeNext(raw);
    // An encoded newline is still a path on g1t.
    if (raw === "/%0a") assert.equal(kept, "/%0a");
    else assert.equal(kept, "/", String(raw));
  }
});

test("sign in and sign up links carry where to come back to", () => {
  assert.equal(withNext("/login", "/acme/web/issues?state=open"), "/login?next=%2Facme%2Fweb%2Fissues%3Fstate%3Dopen");
  assert.equal(withNext("/register", "/explore"), "/register?next=%2Fexplore");
  assert.equal(withNext("/login", "/"), "/login");
  assert.equal(withNext("/login", "//evil.example"), "/login");
});
