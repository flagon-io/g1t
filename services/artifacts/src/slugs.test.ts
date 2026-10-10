import assert from "node:assert/strict";
import { test } from "node:test";

import { freeSlug, linkedPageIds, pageIdFrom, pageSlug, slugify, validSpaceSlug } from "./slugs.ts";

const id = "pag_01jb2k7x9hfq0b3zj0f5s2m8ra";

test("page slugs carry the id, so renames keep links working", () => {
  assert.equal(pageSlug("Release checklist: v2!", id), `release-checklist-v2-${id}`);
  assert.equal(pageSlug("", id), id);
  assert.equal(pageIdFrom(`anything-${id}`), id);
  assert.equal(pageIdFrom(id), id);
  assert.equal(pageIdFrom("no-id-here"), null);
});

test("slugify drops accents and punctuation", () => {
  assert.equal(slugify("Café Ops — Runbooks"), "cafe-ops-runbooks");
});

test("space slugs avoid taken and reserved names", () => {
  assert.equal(freeSlug("Engineering", new Set()), "engineering");
  assert.equal(freeSlug("Engineering", new Set(["engineering"])), "engineering-2");
  assert.equal(freeSlug("Search", new Set()), "search-2");
  assert.equal(validSpaceSlug("eng-docs"), "eng-docs");
  assert.equal(validSpaceSlug("-bad"), null);
  assert.equal(validSpaceSlug("trash"), null);
});

test("links to pages are found by their ids", () => {
  assert.deepEqual(linkedPageIds(`See [the plan](/acme/-/docs/eng/plan-${id}) and [again](${id}).`), [id]);
});
