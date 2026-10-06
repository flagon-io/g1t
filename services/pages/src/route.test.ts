import assert from "node:assert/strict";
import { test } from "node:test";

import { parseEntry, redirectTo, route } from "./route.ts";
import worker from "./index.ts";

test("hosts on g1t.page are the home page, the fallback origin, or an app", () => {
  assert.deepEqual(route("g1t.page"), { kind: "home" });
  assert.deepEqual(route("domains.g1t.page"), { kind: "fallback" });
  assert.deepEqual(route("web-acme.g1t.page"), { kind: "app", label: "web-acme" });
  assert.deepEqual(route("WEB-Acme.g1t.page."), { kind: "app", label: "web-acme" });
  assert.deepEqual(route("a.b.g1t.page"), { kind: "invalid" });
});

test("any other host is a custom domain", () => {
  assert.deepEqual(route("aut10dmain.io"), { kind: "custom", hostname: "aut10dmain.io" });
  assert.deepEqual(route("www.example.co.uk"), { kind: "custom", hostname: "www.example.co.uk" });
  assert.deepEqual(route("xn--bcher-kva.example"), { kind: "custom", hostname: "xn--bcher-kva.example" });
  assert.deepEqual(route("localhost"), { kind: "invalid" });
  assert.deepEqual(route("-bad.example"), { kind: "invalid" });
});

test("entries are read only when they are well formed", () => {
  assert.deepEqual(parseEntry({ script: "web-acme", redirect: null }), { script: "web-acme", redirect: null });
  assert.deepEqual(parseEntry({ script: "web-acme", redirect: "example.com" }), { script: "web-acme", redirect: "example.com" });
  assert.equal(parseEntry({ script: "../x" }), null);
  assert.equal(parseEntry(null), null);
  assert.equal(parseEntry("web-acme"), null);
});

test("redirects keep the path and query", () => {
  assert.equal(redirectTo("https://www.example.com/a/b?x=1#h", "example.com"), "https://example.com/a/b?x=1");
});

/** The worker with a namespace that knows `scripts`, and a KV holding `domains`. */
function env(scripts: Record<string, string>, domains: Record<string, unknown>) {
  const seen: string[] = [];
  return {
    seen,
    env: {
      APPS: {
        get(name: string) {
          return {
            async fetch(request: Request) {
              seen.push(`${name} ${new URL(request.url).hostname}`);
              if (!(name in scripts)) throw new Error("Worker not found");
              return new Response(scripts[name]);
            },
          };
        },
      },
      DOMAINS: {
        async get(key: string) {
          return domains[key] ?? null;
        },
      },
    } as any,
  };
}

const call = (url: string, e: any) => worker.fetch(new Request(url), e, {} as any);

test("a custom domain is served by its project's app, with the request's host kept", async () => {
  const { env: e, seen } = env({ "web-acme": "hello" }, { "app.example.com": { script: "web-acme", redirect: null } });
  const response = await call("https://app.example.com/docs?q=1", e);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "hello");
  assert.deepEqual(seen, ["web-acme app.example.com"]);
});

test("a paired domain redirects with a 308, path and query kept", async () => {
  const { env: e, seen } = env({}, { "www.example.org": { script: "web-acme", redirect: "example.org" } });
  const response = await call("https://www.example.org/pricing?plan=pro", e);
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://example.org/pricing?plan=pro");
  assert.deepEqual(seen, []);
});

test("an unknown custom domain gets the branded 404", async () => {
  const { env: e } = env({}, {});
  const response = await call("https://nobody.example.net/", e);
  assert.equal(response.status, 404);
  assert.match(await response.text(), /This domain is not set up/);
});

test("a custom domain whose app is not up says so", async () => {
  const { env: e } = env({}, { "shop.example.com": { script: "shop-acme", redirect: null } });
  const response = await call("https://shop.example.com/", e);
  assert.equal(response.status, 404);
  assert.match(await response.text(), /Nothing deployed here yet/);
});

test("g1t.page addresses dispatch by label as before", async () => {
  const { env: e, seen } = env({ "web-acme": "prod", "web-git-x-acme": "preview" }, {});
  assert.equal(await (await call("https://web-acme.g1t.page/", e)).text(), "prod");
  const preview = await call("https://web-git-x-acme.g1t.page/", e);
  assert.equal(preview.headers.get("x-robots-tag"), "noindex");
  assert.deepEqual(seen, ["web-acme web-acme.g1t.page", "web-git-x-acme web-git-x-acme.g1t.page"]);
  assert.equal((await call("https://gone-acme.g1t.page/", e)).status, 404);
  assert.equal((await call("https://domains.g1t.page/", e)).status, 200);
});

test("an app's old address redirects to its new one, whatever the old script answers", async () => {
  // The old script is the paused notice, as when the old workspace reached its limit.
  const { env: e, seen } = env(
    { "lab-api-syntaqx": "This app is paused", "lab-api-flagon-io": "api" },
    { "lab-api-syntaqx.g1t.page": { script: "lab-api-syntaqx", redirect: "lab-api-flagon-io.g1t.page" } },
  );
  const response = await call("https://lab-api-syntaqx.g1t.page/v1/items?page=2", e);
  assert.equal(response.status, 301);
  assert.equal(response.headers.get("location"), "https://lab-api-flagon-io.g1t.page/v1/items?page=2");
  assert.equal(response.headers.get("x-robots-tag"), "noindex");
  assert.deepEqual(seen, []);
  // The new address is served.
  assert.equal(await (await call("https://lab-api-flagon-io.g1t.page/", e)).text(), "api");
});

test("an app address with no redirect, or a failing lookup, is served as it is", async () => {
  const { env: e } = env({ "shop-acme": "shop" }, {});
  e.DOMAINS = {
    async get() {
      throw new Error("KV is down");
    },
  };
  assert.equal(await (await call("https://shop-acme.g1t.page/", e)).text(), "shop");
});
