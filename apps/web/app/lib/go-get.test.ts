import assert from "node:assert/strict";
import { test } from "node:test";

import { goImport } from "./go-get.ts";

test("go get finds a repository's code from its address and any package in it", () => {
  for (const path of ["/acme/lib", "/acme/lib/", "/acme/lib/pkg/sub", "/acme/lib.git"]) {
    const page = goImport(new URL(`https://g1t.sh${path}?go-get=1`));
    assert.ok(page, path);
    assert.match(page, /<meta name="go-import" content="g1t\.sh\/acme\/lib git https:\/\/g1t\.sh\/acme\/lib\.git">/);
    assert.match(page, /<meta name="go-source" content="g1t\.sh\/acme\/lib https:\/\/g1t\.sh\/acme\/lib /);
  }
});

test("only go-get requests for a repository's address are answered", () => {
  assert.equal(goImport(new URL("https://g1t.sh/acme/lib")), null, "no go-get");
  assert.equal(goImport(new URL("https://g1t.sh/acme/lib?go-get=0")), null);
  assert.equal(goImport(new URL("https://g1t.sh/acme?go-get=1")), null, "a workspace is not a module");
  assert.equal(goImport(new URL("https://g1t.sh/acme/-/packages?go-get=1")), null, "workspace pages");
  assert.equal(goImport(new URL("https://g1t.sh/Acme/lib?go-get=1")), null);
  assert.equal(goImport(new URL("https://g1t.sh/acme/%22%3E?go-get=1")), null, "nothing is put in the page unchecked");
});
