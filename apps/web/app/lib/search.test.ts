import assert from "node:assert/strict";
import { test } from "node:test";

import { isValue, qualifier, searchHref, shortCount, tokens, withIs, withQualifier } from "./search.ts";

test("quoted runs stay whole", () => {
  assert.deepEqual(tokens('parse "two words" label:"good first issue" x'), [
    "parse",
    '"two words"',
    'label:"good first issue"',
    "x",
  ]);
});

test("a qualifier is read, quotes and all", () => {
  assert.equal(qualifier("x language:rust", "language"), "rust");
  assert.equal(qualifier('x label:"good first issue"', "label"), "good first issue");
  assert.equal(qualifier("x", "language"), null);
});

test("a filter replaces its qualifier and keeps the rest", () => {
  assert.equal(withQualifier("parse language:go repo:a/b", "language", "rust"), "parse repo:a/b language:rust");
  assert.equal(withQualifier("parse language:go", "language", null), "parse");
  assert.equal(withQualifier("crash", "label", "good first issue"), 'crash label:"good first issue"');
  assert.equal(withQualifier("x workspace:acme", "org", "beta", ["workspace"]), "x org:beta");
});

test("is: values of one family replace each other", () => {
  assert.equal(withIs("crash is:open is:pr", ["open", "closed", "merged"], "closed"), "crash is:pr is:closed");
  assert.equal(withIs("crash is:open", ["open", "closed"], null), "crash");
  assert.equal(isValue("crash is:Closed", ["open", "closed"]), "closed");
  assert.equal(isValue("crash", ["open", "closed"]), null);
});

test("addresses carry the query, the tab and the page", () => {
  assert.equal(searchHref(" fn main ", "code"), "/search?q=fn+main&type=code");
  assert.equal(searchHref("x", null, 3), "/search?q=x&page=3");
  assert.equal(searchHref("x", "issues", 1), "/search?q=x&type=issues");
});

test("counts stop at the cap", () => {
  assert.equal(shortCount(12), "12");
  assert.equal(shortCount(1000), "1k+");
});
