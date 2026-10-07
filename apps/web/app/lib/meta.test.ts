import assert from "node:assert/strict";
import { test } from "node:test";

import { OG_RENDER_VERSION } from "@g1t/contracts/og";

import { DESCRIPTION, cardUrl, excerpt, fingerprint, page } from "./meta.ts";

type Tag = Record<string, string>;

function tags(list: unknown[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const tag of list as Tag[]) {
    if ("title" in tag) found.set("title", tag.title);
    else found.set(tag.property ?? tag.name, tag.content);
  }
  return found;
}

test("a page gets its title, description, Open Graph and Twitter tags", () => {
  const meta = tags(page({ location: { pathname: "/pricing" }, matches: [] }, { title: "Pricing · g1t", description: "What it costs." }));
  assert.equal(meta.get("title"), "Pricing · g1t");
  assert.equal(meta.get("description"), "What it costs.");
  assert.equal(meta.get("og:title"), "Pricing");
  assert.equal(meta.get("og:url"), "https://g1t.sh/pricing");
  assert.equal(meta.get("og:site_name"), "g1t");
  assert.equal(meta.get("og:image"), `https://og.g1t.sh/image?path=%2Fpricing&v=${OG_RENDER_VERSION}`);
  assert.equal(meta.get("twitter:card"), "summary_large_image");
  assert.equal(meta.get("twitter:image"), meta.get("og:image"));
});

test("pages under a project describe the project, and their card follows its details", () => {
  const project = {
    id: "routes/repo/layout",
    loaderData: { repo: { description: "Repo words" }, project: { name: "Web", description: "The storefront" }, open: { issues: 2, pulls: 1 } },
  };
  const meta = tags(page({ location: { pathname: "/acme/web/commits/" }, matches: [project] }, { title: "Commits · acme/web · g1t" }));
  assert.equal(meta.get("description"), "The storefront");
  assert.equal(meta.get("og:url"), "https://g1t.sh/acme/web/commits");
  assert.match(meta.get("og:image") ?? "", new RegExp(`\\?path=%2Facme%2Fweb%2Fcommits&v=${OG_RENDER_VERSION}\\.[0-9a-z]+$`));
});

test("a page's address and card come from the root loader's addresses", () => {
  const root = { id: "root", loaderData: { addresses: { site: "http://localhost:8787", og: "http://localhost:8799" } } };
  const meta = tags(page({ location: { pathname: "/pricing" }, matches: [root] }, { title: "Pricing · g1t" }));
  assert.equal(meta.get("og:url"), "http://localhost:8787/pricing");
  assert.equal(meta.get("og:image"), `http://localhost:8799/image?path=%2Fpricing&v=${OG_RENDER_VERSION}`);
  assert.equal(meta.get("twitter:image"), meta.get("og:image"));
});

test("without a card service, a page has no image tags", () => {
  const root = { id: "root", loaderData: { addresses: { site: "http://localhost:8787", og: null } } };
  const meta = tags(page({ location: { pathname: "/" }, matches: [root] }, { title: "g1t" }));
  assert.equal(meta.get("og:url"), "http://localhost:8787/");
  for (const name of ["og:image", "og:image:type", "og:image:width", "og:image:height", "og:image:alt", "twitter:image", "twitter:image:alt"]) {
    assert.equal(meta.has(name), false, name);
  }
  assert.equal(meta.get("twitter:card"), "summary");
});

test("with nothing particular to say, a page says what g1t is", () => {
  const meta = tags(page({ location: { pathname: "/login" }, matches: [] }, { title: "Sign in · g1t" }));
  assert.equal(meta.get("description"), DESCRIPTION);
});

test("a card's version changes with what it shows", () => {
  assert.equal(fingerprint(["a", "open"]), fingerprint(["a", "open"]));
  assert.notEqual(fingerprint(["a", "open"]), fingerprint(["a", "merged"]));
  assert.equal(cardUrl("/", undefined), `https://og.g1t.sh/image?path=%2F&v=${OG_RENDER_VERSION}`);
});

test("every card address carries the render version, so a new design is a new address", () => {
  assert.match(cardUrl("/"), new RegExp(`[?&]v=${OG_RENDER_VERSION}$`));
  assert.match(cardUrl("/acme", ["Acme"]), new RegExp(`[?&]v=${OG_RENDER_VERSION}\\.[0-9a-z]+$`));
});

test("an excerpt is plain text from the start of the Markdown", () => {
  assert.equal(excerpt("## Why\n\nThe [queue](https://x) is **slow**.\n\n```ts\ncode()\n```"), "Why The queue is slow.");
  assert.equal(excerpt("x".repeat(300), 10).length, 10);
  assert.equal(excerpt(null), "");
});
