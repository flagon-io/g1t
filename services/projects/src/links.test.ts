import { test } from "node:test";
import assert from "node:assert/strict";

import { cleanLinks, cleanUrl, projectLinks, storedLinks } from "./links.ts";

test("an address is http or https, with https added when none is given", () => {
  assert.deepEqual(cleanUrl(" g1t.sh "), { ok: true, value: "https://g1t.sh" });
  assert.deepEqual(cleanUrl("HTTP://docs.example.com/guide?x=1#a"), { ok: true, value: "http://docs.example.com/guide?x=1#a" });
  assert.deepEqual(cleanUrl("example.com:8080/app"), { ok: true, value: "https://example.com:8080/app" });
  assert.deepEqual(cleanUrl(""), { ok: true, value: null });
  assert.deepEqual(cleanUrl(null), { ok: true, value: null });
});

test("anything else is refused, naming what it is", () => {
  for (const bad of ["javascript:alert(1)", "mailto:a@example.com", "ftp://example.com", "localhost:3000", "https://", "https://exa mple.com", "https://user@example.com", "https://.com"]) {
    assert.equal(cleanUrl(bad).ok, false, bad);
  }
  assert.deepEqual(cleanUrl("ftp://x.io", "The homepage"), { ok: false, message: "The homepage is an http or https address." });
  assert.equal(cleanUrl(`https://example.com/${"a".repeat(260)}`).ok, false);
});

test("links: blank rows dropped, labels from the host, at most ten", () => {
  assert.deepEqual(
    cleanLinks([
      { label: " Status ", url: "status.example.com" },
      { label: "", url: "" },
      { label: "", url: "https://npmjs.com/package/x" },
    ]),
    {
      ok: true,
      value: [
        { label: "Status", url: "https://status.example.com" },
        { label: "npmjs.com", url: "https://npmjs.com/package/x" },
      ],
    },
  );
  assert.deepEqual(cleanLinks([{ label: "Chat", url: "" }]), { ok: false, message: "Give Chat an address." });
  assert.deepEqual(cleanLinks([{ label: "Chat", url: "irc://x.io" }]), { ok: false, message: "The address for Chat is an http or https address." });
  assert.equal(cleanLinks([{ label: "x".repeat(41), url: "x.io" }]).ok, false);
  const eleven = Array.from({ length: 11 }, (_, i) => ({ label: `L${i}`, url: `l${i}.io` }));
  assert.equal(cleanLinks(eleven).ok, false);
  assert.equal(cleanLinks(eleven.slice(0, 10)).ok, true);
  assert.equal(cleanLinks("nope").ok, false);
});

test("stored links that cannot be read are none", () => {
  assert.deepEqual(storedLinks('[{"label":"A","url":"https://a.io"},{"label":1}]'), [{ label: "A", url: "https://a.io" }]);
  assert.deepEqual(storedLinks("not json"), []);
  assert.deepEqual(storedLinks(null), []);
});

test("a repository's own project follows its website until it has a homepage of its own", () => {
  const row = { is_primary: 1, homepage: null, repo_website: "https://example.com", docs_url: null, links: null };
  assert.deepEqual(projectLinks(row), { homepage: "https://example.com", homepageInherited: true, docs: null, custom: [] });
  assert.equal(projectLinks({ ...row, homepage: "https://g1t.sh" }).homepage, "https://g1t.sh");
  assert.equal(projectLinks({ ...row, homepage: "https://g1t.sh" }).homepageInherited, false);
  // Another project in the same repository does not.
  assert.deepEqual(projectLinks({ ...row, is_primary: 0 }).homepage, null);
});
