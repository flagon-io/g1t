import assert from "node:assert/strict";
import { test } from "node:test";

import { connectLink, parseDiscovery } from "./discovery.ts";

test("a discovery document is read for its origins", () => {
  assert.deepEqual(
    parseDiscovery({
      name: "g1t",
      site: "https://g1t.example.com/",
      api: "http://10.0.0.5:8789/x",
      mcp: "https://g1t.example.com/mcp/",
      hosted: false,
      phone: { chat: true, push: false },
    }),
    {
      name: "g1t",
      site: "https://g1t.example.com",
      api: "http://10.0.0.5:8789",
      mcp: "https://g1t.example.com/mcp",
      hosted: false,
      phone: { chat: true, push: false },
    },
  );
});

test("anything else is not one", () => {
  assert.equal(parseDiscovery(null), null);
  assert.equal(parseDiscovery({ site: "https://a.example", api: "https://b.example" }), null, "no name");
  assert.equal(parseDiscovery({ name: "g1t", site: "javascript:alert(1)", api: "https://b.example" }), null);
  assert.equal(parseDiscovery({ name: "g1t", site: "https://a.example" }), null, "no API");
});

test("a connect link carries the site", () => {
  assert.equal(connectLink("https://g1t.example.com"), "g1t://connect?server=https%3A%2F%2Fg1t.example.com");
});
