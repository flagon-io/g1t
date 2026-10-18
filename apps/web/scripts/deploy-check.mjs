// Exercise the built Worker in workerd before it can be deployed. Storage is
// temporary and local; no service bindings or Cloudflare credentials are used.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = resolve("build/server");
const config = JSON.parse(readFileSync(join(root, "wrangler.json"), "utf8"));
const source = readFileSync(join(root, "index.js"), "utf8");
const build = source.match(/searchParams\.set\("_g1t_build", "([^"]+)"\)/)?.[1];
assert.ok(build, "The page cache must be separated by build");
const css = "body{color:red}";
// Seed R2 and the page cache through a test-only entry, keeping all R2 I/O
// inside workerd. The application entry itself is the unmodified build.
const seed = `import app from './index.js';
import { WorkerEntrypoint } from 'cloudflare:workers';
export class ScreenshotStub extends WorkerEntrypoint {
  async image(input) {
    if (input.host !== 'public-acme.g1t.page' || input.commit !== 'abcdef1234567') throw new Error('Unexpected screenshot target');
    return {body:new TextEncoder().encode('production-preview').buffer,contentType:'image/jpeg',commit:input.commit,capturedAt:'2026-10-15T02:00:00Z'};
  }
}
export default { async fetch(request, env, ctx) {
  if (new URL(request.url).pathname === '/__seed') {
    await env.DOWNLOADS.put('web-assets/assets/app-old12345.css', ${JSON.stringify(css)}, {httpMetadata:{contentType:'text/css'}});
    const cache = new URL('/pricing.data', request.url);
    cache.searchParams.set('_g1t_build', ${JSON.stringify(build)});
    cache.searchParams.set('_g1t_representation', 'html');
    await caches.default.put(new Request(cache), new Response('wrong-build-cache', {headers:{'cache-control':'public, max-age=300','x-g1t-kept-at':String(Date.now())}}));
    return new Response('seeded');
  }
  return app.fetch(request, env, ctx);
}};`;
const files = [
  join(root, "index.js"),
  ...readdirSync(join(root, "assets"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => join(root, "assets", name)),
];
const runtime = new Miniflare(
  convertV4MiniflareOptions({
    name: "web-deploy-check",
    cf: false,
    modulesRoot: root,
    modules: [{ type: "ESModule", path: join(root, "deploy-check.mjs"), contents: seed }, ...files.map((path) => ({ type: "ESModule", path }))],
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    r2Buckets: ["DOWNLOADS"],
    serviceBindings: {
      IDENTITY: async () => Response.json(null),
      PROJECTS: async (request) => {
        const method = new URL(request.url).pathname.split("/").pop();
        const args = await request.json();
        if (method !== "get") return Response.json({ ok: true, value: [] });
        if (args.slug !== "public") return Response.json({ ok: false, error: { code: "not_found", message: "Not found" } });
        return Response.json({ ok: true, value: { source: { kind: "hosted", repo: { namespace: "acme", name: "public" } } } });
      },
      DEPLOYMENTS: async (request) => {
        const method = new URL(request.url).pathname.split("/").pop();
        const args = await request.json();
        assert.equal(method, "list_environments", "Public previews must not read member-only deployment lists");
        assert.equal(args.viewer, null);
        assert.equal(args.repo.name, "public");
        const current = {
          id: "dpl_live",
          source: "g1t_page",
          state: "success",
          sha: "abcdef1234567",
          environment_url: "https://public-acme.g1t.page",
          updated_at: "2026-10-15T01:00:00Z",
        };
        return Response.json({
          ok: true,
          value: {
            environments: [
              {
                name: "production",
                production_environment: true,
                updated_at: current.updated_at,
                current,
                latest: { ...current, id: "dpl_next", sha: "bbbbbbb", state: "in_progress" },
              },
            ],
          },
        });
      },
      SCREENSHOTS: { name: "web-deploy-check", entrypoint: "ScreenshotStub" },
    },
  }),
);
try {
  const origin = await runtime.ready;
  const request = (path, init) => fetch(new URL(path, origin), { ...init, signal: AbortSignal.timeout(15_000) });
  assert.equal((await request("/__seed")).status, 200);
  const screenshot = await request("/acme/public/production.jpg?v=abcdef1234567-" + Date.parse("2026-10-15T01:00:00Z"));
  assert.equal(screenshot.status, 200, "Signed-out readers can see public production screenshots");
  assert.equal(screenshot.headers.get("content-type"), "image/jpeg");
  assert.equal(screenshot.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal(await screenshot.text(), "production-preview");
  assert.equal((await request("/acme/private/production.jpg")).status, 404, "Unreadable projects never expose screenshots");
  console.log("Public production screenshots: anonymous access, private-project denial, and serving commit selection verified.");
  for (const [path, destination] of [
    ["/developers", "https://docs.g1t.sh/reference/developers/"],
    ["/openapi.json", "https://api.g1t.sh/openapi.json"],
    ["/mcp", "https://mcp.g1t.sh"],
  ]) {
    const answer = await request(path, { redirect: "manual" });
    assert.equal(answer.status, 308);
    assert.equal(answer.headers.get("location"), new URL(destination).href);
  }
  // Run Markdown first, then HTML at the same URL: the cache must not mix them.
  for (const path of ["/", "/__agent-readiness-missing"]) {
    for (const accept of ["text/markdown", "text/html", "text/markdown"]) {
      const answer = await request(path, { headers: { accept } });
      assert.equal(answer.status, path === "/" ? 200 : 404);
      assert.ok(
        answer.headers
          .get("vary")
          ?.toLowerCase()
          .split(",")
          .map((value) => value.trim())
          .includes("accept"),
      );
      assert.ok(answer.headers.get("content-type")?.startsWith(accept));
      const body = await answer.text();
      if (accept === "text/markdown") {
        assert.match(body, /\[.*\]\(.*\/llms.txt\)/);
        assert.ok(body.length > 20);
      } else {
        assert.match(body, /<html/);
        if (path === "/") assert.match(body, /rel="canonical"/);
      }
    }
  }
  assert.equal((await request("/", { headers: { accept: "application/json" } })).status, 406);
  for (const accept of ["text/markdown", "text/html"]) {
    const answer = await request("/", { method: "HEAD", headers: { accept } });
    assert.equal(answer.status, 200);
    assert.ok(answer.headers.get("content-type")?.startsWith(accept));
    assert.equal(await answer.text(), "");
  }
  const features = await request("/features", { headers: { accept: "text/html" } });
  assert.equal(features.status, 200);
  const featureHtml = await features.text();
  assert.match(featureHtml, /<h1[^>]*>From the first conversation to shipped code[.]<\/h1>/);
  assert.match(featureHtml, /<title>g1t features/);
  assert.match(featureHtml, /href="https:\/\/g1t.sh\/features"/);
  assert.match(featureHtml, /href="\/features"[^>]*>Features/);
  assert.match(featureHtml, /href="\/developers"/);
  console.log("Features: public HTML, branded title, canonical URL and navigation verified.");
  const old = await request("/assets/app-old12345.css");
  assert.equal(old.status, 200);
  assert.equal(old.headers.get("content-type"), "text/css");
  assert.equal(await old.text(), css);
  const missing = await request("/assets/app-missing0.css");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(missing.headers.get("content-type") ?? "", /html/);
  for (const path of ["/pricing.data", "/flagon-io/-/home.data?tab=one&_routes=root"]) {
    const answer = await request(path, { headers: { "x-g1t-build": "previous-build" } });
    assert.equal(answer.status, 202);
    const body = await answer.text();
    assert.match(body, /reload/);
    assert.ok(body.includes(path.split(".data")[0]));
    assert.doesNotMatch(body, /_routes|wrong-build-cache/);
  }
  console.log("Deployment safety: old CSS survives, missing assets stay isolated, old navigations bypass cache and loaders.");
  console.log("Agent pages: Markdown/HTML negotiation, isolated caches, 404s, HEAD, canonical metadata and discovery redirects verified.");
} finally {
  await runtime.dispose();
}
