import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import { FEATURES } from "../apps/web/app/lib/features.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");

test("llms.txt follows the heading and file-list format and preserves the detailed guide", () => {
  const index = read("apps/web/public/llms.txt");
  assert.match(index, /^# g1t\n\n> /);
  for (const section of index.split(/^## .+$/m).slice(1)) {
    const lines = section.trim().split("\n").filter(Boolean);
    assert.ok(lines.length > 0);
    for (const line of lines) assert.match(line, /^- \[[^\]]+\]\(https:\/\/[^)]+\)(: .+)?$/);
  }
  for (const url of ["/features", "/developers", "/agents.md", "/openapi.json", "/reference/versioning.md", "/settings/tokens"]) assert.ok(index.includes(url), url);
  assert.match(read("apps/web/public/agents.md"), /## Set someone up/);
});

test("features is routed, discoverable on desktop and mobile, and has real documentation targets", () => {
  assert.match(read("apps/web/app/routes.ts"), /route\("features", "routes\/features.tsx"\)/);
  assert.match(read("apps/web/app/routes/sitemap-xml.ts"), /"\/features"/);
  const header = read("apps/web/app/components/public-header.tsx");
  assert.match(header, /<HeaderLink to="\/features">Features<\/HeaderLink>/);
  assert.match(header, /<Link to="\/features">/);
  assert.equal(new Set(FEATURES.map((f) => f.id)).size, FEATURES.length);
  for (const feature of FEATURES) for (const link of feature.links) {
    if (!link.href.startsWith("https://docs.g1t.sh/")) continue;
    const slug = new URL(link.href).pathname.replace(/\/$/, "");
    assert.ok(["md", "mdx"].some((ext) => existsSync(new URL(`../apps/docs/src/content/docs${slug}.${ext}`, import.meta.url))), link.href);
  }
});

test("built developer pages have branded headings, canonical URLs and Markdown counterparts", () => {
  for (const slug of ["reference/developers", "reference/versioning", "reference/api", "reference/mcp", "guides/authentication"]) {
    const html = read(`apps/docs/dist/${slug}/index.html`);
    assert.match(html, /<title>g1t /);
    assert.match(html, /<h1[^>]*[^]*?>g1t /);
    assert.ok(html.includes(`https://docs.g1t.sh/${slug}/`));
    assert.match(read(`apps/docs/dist/${slug}.md`), /^# g1t /);
  }
  const policy = read("apps/docs/dist/reference/versioning.md");
  for (const text of ["X-G1t-Api-Version", "Deprecation", "Sunset", 'rel="deprecation"', "No REST version is currently deprecated"]) assert.ok(policy.includes(text), text);
});
