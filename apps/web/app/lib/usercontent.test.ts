import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PDF_POLICY,
  USERCONTENT_POLICY,
  imageSource,
  isCommit,
  parseRawPath,
  rawHeaders,
  rawPath,
  signRaw,
  usercontentPath,
  verifyRaw,
} from "./usercontent.ts";

const FILE = { owner: "acme", repo: "web", ref: "feat/new", path: "docs/a b.png" };

test("a raw file's path keeps a ref with slashes in one segment", () => {
  const path = rawPath(FILE);
  assert.equal(path, "/acme/web/raw/feat%2Fnew/docs/a%20b.png");
  assert.deepEqual(parseRawPath(path), FILE);
});

test("paths that are not a file, or climb out of the repository, are refused", () => {
  for (const path of ["/acme/web/raw/main", "/acme/web/blob/main/a.png", "/acme/web/raw/main/../x", "/acme/web/raw/main/a//b", "/acme/web/raw/main/%E0%A4%A"]) {
    assert.equal(parseRawPath(path), null, path);
  }
});

test("usercontent is its own host, or a path on the site", () => {
  const hosted = "https://g1tusercontent.com";
  assert.equal(usercontentPath(new URL("https://g1tusercontent.com/acme/web/raw/main/a.png"), hosted), "/acme/web/raw/main/a.png");
  assert.equal(usercontentPath(new URL("https://g1t.sh/acme/web/raw/main/a.png"), hosted), null);
  const own = "https://git.example.com/-/usercontent";
  assert.equal(usercontentPath(new URL("http://localhost:8787/-/usercontent/avatars/ab"), own), "/avatars/ab");
  assert.equal(usercontentPath(new URL("http://localhost:8787/-/usercontentx"), own), null);
  assert.equal(usercontentPath(new URL("http://localhost:8787/acme/web"), own), null);
});

test("a token is good for its file alone, until it ends", async () => {
  const now = Date.UTC(2026, 9, 8, 12, 30);
  const token = await signRaw("secret", FILE, "repo_1", now);
  assert.match(token, /^\d+\.repo_1\.[A-Za-z0-9_-]{43}$/);
  // The same within the hour, so a page's addresses are kept by the browser.
  assert.equal(await signRaw("secret", FILE, "repo_1", now + 20 * 60_000), token);
  assert.equal(await verifyRaw("secret", FILE, token, now), "repo_1");
  assert.equal(await verifyRaw("secret", { ...FILE, owner: "ACME" }, token, now), "repo_1");
  assert.equal(await verifyRaw("secret", { ...FILE, path: "docs/other.png" }, token, now), null);
  assert.equal(await verifyRaw("secret", { ...FILE, repo: "api" }, token, now), null);
  assert.equal(await verifyRaw("secret", { ...FILE, ref: "main" }, token, now), null);
  assert.equal(await verifyRaw("other", FILE, token, now), null);
  assert.equal(await verifyRaw("secret", FILE, token.replace("repo_1", "repo_2"), now), null);
  assert.equal(await verifyRaw("secret", FILE, token, now + 2 * 3600_000), null);
  assert.equal(await verifyRaw("secret", FILE, "nonsense", now), null);
});

test("files are served as data that cannot run", () => {
  const text = new TextEncoder().encode("<script>alert(1)</script>");
  for (const name of ["index.html", "page.xhtml", "data.xml", "app.js", "README.md"]) {
    const headers = rawHeaders(name, text);
    assert.equal(headers.get("content-type"), "text/plain; charset=utf-8", name);
    assert.equal(headers.get("x-content-type-options"), "nosniff");
    assert.equal(headers.get("content-security-policy"), USERCONTENT_POLICY);
  }
  assert.equal(rawHeaders("logo.png", new Uint8Array([137, 80, 78, 71])).get("content-type"), "image/png");
  // An SVG shows as an image; opened on its own, its scripts are sandboxed.
  const svg = rawHeaders("logo.svg", text);
  assert.equal(svg.get("content-type"), "image/svg+xml");
  assert.match(svg.get("content-security-policy")!, /sandbox/);
  assert.equal(rawHeaders("paper.pdf", new Uint8Array([37, 80])).get("content-security-policy"), PDF_POLICY);
  const binary = rawHeaders("tool.bin", new Uint8Array([0, 1, 2]));
  assert.equal(binary.get("content-type"), "application/octet-stream");
  assert.match(binary.get("content-disposition")!, /^attachment; filename="tool.bin"/);
});

test("a README's relative pictures are the repository's files at the same commit", () => {
  const root = "/acme/web/raw/abc123";
  const docs = `${root}/docs`;
  assert.equal(imageSource("logo.png", root), `${root}/logo.png`);
  assert.equal(imageSource("./img/a b.png", docs), `${root}/docs/img/a%20b.png`);
  assert.equal(imageSource("../logo.png?raw=true", docs), `${root}/logo.png`);
  // From the repository's root, as people write them.
  assert.equal(imageSource("/assets/x.svg", docs), `${root}/assets/x.svg`);
  // Never out of the repository.
  assert.equal(imageSource("../../../../other/repo/raw/main/x.png", docs), undefined);
  // External pictures, and those with no repository, are as written.
  assert.equal(imageSource("https://example.com/x.png", docs), "https://example.com/x.png");
  assert.equal(imageSource("data:image/png;base64,AA", docs), "data:image/png;base64,AA");
  assert.equal(imageSource("logo.png", undefined), "logo.png");
});

test("commits are full hashes", () => {
  assert.equal(isCommit("a".repeat(40)), true);
  assert.equal(isCommit("main"), false);
});
