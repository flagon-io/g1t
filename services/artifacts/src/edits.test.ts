import assert from "node:assert/strict";
import { test } from "node:test";

import * as Y from "yjs";

import { seed } from "./blocks.ts";
import { anchorThread, applyEdit, commentMarkKey, findTarget, rangeIds, rangeMarkdown, restoreFrom, unanchorThread } from "./edits.ts";
import { documentMarkdown, outline, topContainers } from "./markdown.ts";

const PAGE = `# Plan

Intro.

## Rollout

Old rollout.

- step one

### Detail

Fine print.

## Risks

None.
`;

function docFrom(markdown: string) {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("document-store");
  seed(doc, fragment, markdown);
  return { doc, fragment };
}

test("a section runs to the next heading of its level or higher, subsections included", () => {
  const { fragment } = docFrom(PAGE);
  const range = findTarget(fragment, { kind: "section", heading: "rollout" })!;
  assert.equal(rangeMarkdown(fragment, range), "## Rollout\n\nOld rollout.\n\n- step one\n\n### Detail\n\nFine print.");
  assert.equal(findTarget(fragment, { kind: "section", heading: "Nope" }), null);
});

test("replacing a section changes only that section", () => {
  const { doc, fragment } = docFrom(PAGE);
  const ok = applyEdit(doc, fragment, { kind: "section", heading: "Rollout" }, "## Rollout\n\nShip to 10% first, then everyone.");
  assert.equal(ok, true);
  assert.equal(documentMarkdown(fragment), "# Plan\n\nIntro.\n\n## Rollout\n\nShip to 10% first, then everyone.\n\n## Risks\n\nNone.\n");
});

test("blocks targets use the ids agents read from the outline", () => {
  const { doc, fragment } = docFrom(PAGE);
  const blocks = outline(fragment);
  const intro = blocks.find((b) => b.markdown === "Intro.")!;
  applyEdit(doc, fragment, { kind: "blocks", from_block: intro.id, to_block: intro.id }, "A better intro.");
  assert.match(documentMarkdown(fragment), /^# Plan\n\nA better intro\.\n\n## Rollout/);
  // Untouched blocks keep their ids.
  assert.equal(outline(fragment)[0]!.id, blocks[0]!.id);
});

test("append adds at the end; document replaces everything", () => {
  const { doc, fragment } = docFrom("# A");
  applyEdit(doc, fragment, { kind: "append" }, "Added.");
  assert.equal(documentMarkdown(fragment), "# A\n\nAdded.\n");
  applyEdit(doc, fragment, { kind: "document" }, "");
  // The editor keeps one empty block.
  assert.equal(topContainers(fragment).length, 1);
  assert.equal(documentMarkdown(fragment), "");
});

test("an edit made on the server merges with a person typing at the same time", () => {
  const { doc, fragment } = docFrom(PAGE);
  const person = new Y.Doc();
  Y.applyUpdate(person, Y.encodeStateAsUpdate(doc));
  // The person types in the intro while the agent rewrites Risks.
  const theirs = person.getXmlFragment("document-store");
  const intro = topContainers(theirs)[1]!.get(0) as Y.XmlElement;
  (intro.get(0) as Y.XmlText).insert(0, "Hello. ");
  applyEdit(doc, fragment, { kind: "section", heading: "Risks" }, "## Risks\n\nRollback is one click.");
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(person));
  Y.applyUpdate(person, Y.encodeStateAsUpdate(doc));
  const merged = documentMarkdown(fragment);
  assert.equal(merged, documentMarkdown(theirs));
  assert.match(merged, /Hello\. Intro\./);
  assert.match(merged, /Rollback is one click\./);
});

test("restoring a version brings back its blocks as a new change", () => {
  const { doc, fragment } = docFrom("# v1\n\nfirst");
  const v1 = Y.encodeStateAsUpdate(doc);
  applyEdit(doc, fragment, { kind: "document" }, "# v2\n\nsecond");
  const old = new Y.Doc();
  Y.applyUpdate(old, v1);
  restoreFrom(doc, fragment, old.getXmlFragment("document-store"));
  assert.equal(documentMarkdown(fragment), "# v1\n\nfirst\n");
});

test("a comment anchors to the text between two positions, across blocks", () => {
  const { doc, fragment } = docFrom("alpha beta\n\ngamma delta");
  const tops = topContainers(fragment);
  const first = (tops[0]!.get(0) as Y.XmlElement).get(0) as Y.XmlText;
  const second = (tops[1]!.get(0) as Y.XmlElement).get(0) as Y.XmlText;
  const anchor = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(first, 6));
  const head = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(second, 5));
  const quote = anchorThread(doc, fragment, anchor, head, "t1");
  assert.equal(quote, "beta gamma");
  const key = commentMarkKey("t1");
  assert.match(key, /^comment--[A-Za-z0-9+/=]{8}$/);
  assert.deepEqual(first.toDelta(), [{ insert: "alpha " }, { insert: "beta", attributes: { [key]: { orphan: false, threadId: "t1" } } }]);
  // Marks don't show in Markdown.
  assert.equal(documentMarkdown(fragment), "alpha beta\n\ngamma delta\n");
  unanchorThread(doc, fragment, "t1");
  assert.deepEqual(first.toDelta(), [{ insert: "alpha beta" }]);
});

test("range ids list the blocks a suggestion covers", () => {
  const { fragment } = docFrom(PAGE);
  const range = findTarget(fragment, { kind: "section", heading: "Risks" })!;
  assert.equal(rangeIds(fragment, range).length, 2);
});
