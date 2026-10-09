import assert from "node:assert/strict";
import { test } from "node:test";

import { HOSTED_ADDRESSES, addressesFor, addressesFrom, cloneUrl, usercontentFrom } from "./addresses.ts";
import { MCP_URL } from "./agent-setup.ts";
import { OG, SITE } from "./meta.ts";

test("with no settings, the addresses are g1t.sh's", () => {
  assert.deepEqual(addressesFor({}), HOSTED_ADDRESSES);
  assert.deepEqual(addressesFor({ SITE_URL: "", API_URL: "", MCP_URL: "" }), HOSTED_ADDRESSES);
});

test("settings replace the addresses, without trailing slashes", () => {
  assert.deepEqual(
    addressesFor({
      SITE_URL: "http://localhost:8787/",
      API_URL: "http://localhost:8788",
      MCP_URL: "http://localhost:8790/mcp/",
      OG_URL: "",
    }),
    {
      site: "http://localhost:8787",
      api: "http://localhost:8788",
      mcp: "http://localhost:8790/mcp",
      og: null,
      usercontent: "http://localhost:8787/-/usercontent",
    },
  );
});

test("files people supply are served from an origin of their own", () => {
  assert.equal(addressesFor({}).usercontent, "https://g1tusercontent.com");
  assert.equal(addressesFor({ SITE_URL: "https://git.example.com", USERCONTENT_URL: "https://files.example.net/" }).usercontent, "https://files.example.net");
  assert.equal(addressesFor({ SITE_URL: "https://git.example.com", USERCONTENT_URL: "https://git.example.com" }).usercontent, "https://git.example.com/-/usercontent");
  assert.equal(usercontentFrom(undefined), "");
  assert.equal(usercontentFrom({ addresses: HOSTED_ADDRESSES }), "https://g1tusercontent.com");
});

test("pages without root data use g1t.sh's addresses", () => {
  assert.deepEqual(addressesFrom(undefined), HOSTED_ADDRESSES);
  const own = { site: "http://localhost:8787", api: "a", mcp: "m", og: null };
  assert.deepEqual(addressesFrom({ addresses: own }), own);
});

test("the defaults kept in meta and agent setup are g1t.sh's", () => {
  assert.equal(SITE, HOSTED_ADDRESSES.site);
  assert.equal(OG, HOSTED_ADDRESSES.og);
  assert.equal(MCP_URL, HOSTED_ADDRESSES.mcp);
});

test("a clone address is under the site", () => {
  assert.equal(cloneUrl(HOSTED_ADDRESSES, "acme/web"), "https://g1t.sh/acme/web.git");
});
