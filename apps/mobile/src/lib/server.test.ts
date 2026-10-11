import assert from "node:assert/strict";
import { test } from "node:test";

import { HOSTED, apiFor, parseOrigin, parseServer, socketUrl } from "./server.ts";

test("an origin is all that is kept", () => {
  assert.equal(parseOrigin("https://g1t.sh/acme/-/chat?x#y"), "https://g1t.sh");
  assert.equal(parseOrigin("  g1t.example.com  "), "https://g1t.example.com");
  assert.equal(parseOrigin("http://192.168.1.20:5173/login"), "http://192.168.1.20:5173");
  assert.equal(parseOrigin("ftp://g1t.sh"), null);
  assert.equal(parseOrigin("not a url at all"), null);
  assert.equal(parseOrigin(""), null);
});

test("hosted g1t's API is api.g1t.sh, and a self-hosted one's is api. on its host", () => {
  assert.equal(apiFor("https://g1t.sh"), "https://api.g1t.sh");
  assert.equal(apiFor("https://g1t.example.com"), "https://api.g1t.example.com");
  assert.deepEqual(parseServer("g1t.sh"), HOSTED);
});

test("an API given by hand wins", () => {
  assert.deepEqual(parseServer("http://localhost:5173", "http://localhost:8789/"), {
    site: "http://localhost:5173",
    api: "http://localhost:8789",
  });
  assert.equal(parseServer("g1t.sh", "javascript:alert(1)"), null);
});

test("sockets follow the site's scheme", () => {
  assert.equal(socketUrl(HOSTED, "/acme/-/chat/live?channel=chn_1"), "wss://g1t.sh/acme/-/chat/live?channel=chn_1");
  assert.equal(socketUrl({ site: "http://localhost:5173", api: "" }, "/-/live"), "ws://localhost:5173/-/live");
});
