import assert from "node:assert/strict";
import { test } from "node:test";

import * as Y from "yjs";

import { KINDS, kindModel } from "../index.ts";
import { doc, docTarget, docTargets, linkedFolioIds, previewLines } from "./index.ts";

const origin = { key: "user:ana", kind: "edit" as const, note: null };

test("the registry has the doc kind and nothing not built yet", () => {
  assert.equal(kindModel("doc"), doc);
  assert.equal(kindModel("slides"), null);
  assert.equal(kindModel("nope"), null);
  assert.deepEqual(Object.keys(KINDS), ["doc"]);
});

test("a doc seeds from Markdown and renders it back, with its card", () => {
  const d = new Y.Doc();
  assert.equal(doc.isEmpty(d), true);
  doc.seed(d, { text: "# Plan\n\nShip it on Tuesday.\n\n- one\n- two\n" });
  assert.equal(doc.isEmpty(d), false);
  const r = doc.render(d);
  assert.match(r.text, /^# Plan/);
  assert.match(r.text, /Ship it on Tuesday\./);
  assert.deepEqual(r.preview, { kind: "doc", lines: ["Plan", "Ship it on Tuesday.", "one", "two"] });
  const read = doc.read(d);
  assert.equal(read.content, r.text);
  assert.ok((read.blocks ?? []).length >= 3);
  assert.ok(doc.chunks(r.text, "Plan").length >= 1);
  assert.equal(doc.validate(d), null);
});

test("an agent's edit applies to its target, and a missing one doesn't", () => {
  const d = new Y.Doc();
  doc.seed(d, { text: "# Notes\n\nFirst.\n\n## Risks\n\nNone yet.\n" });
  const appended = doc.applyAgentEdit(d, { kind: "doc", target: { kind: "append" }, markdown: "Added by an agent." }, origin);
  assert.deepEqual(appended, { applied: true, summary: "Added to the end" });
  assert.match(doc.render(d).text, /Added by an agent\./);
  const section = doc.applyAgentEdit(d, { kind: "doc", target: { kind: "section", heading: "Risks" }, markdown: "## Risks\n\nThe date." }, origin);
  assert.equal(section.applied, true);
  assert.match(doc.render(d).text, /The date\./);
  assert.doesNotMatch(doc.render(d).text, /None yet\./);
  const gone = doc.applyAgentEdit(d, { kind: "doc", target: { kind: "section", heading: "Nowhere" }, markdown: "x" }, origin);
  assert.equal(gone.applied, false);
  assert.ok(docTarget(d, { kind: "section", heading: "Risks" }));
  assert.equal(docTarget(d, { kind: "section", heading: "Nowhere" }), null);
  assert.deepEqual(docTargets(d, [{ kind: "section", heading: "Nowhere" }]), [null]);
  // Another kind's edit is never applied to a doc.
  assert.equal(doc.applyAgentEdit(d, { kind: "slides", ops: [] } as never, origin).applied, false);
});

test("a doc restores from an old state and from old text", () => {
  const d = new Y.Doc();
  doc.seed(d, { text: "Version one.\n" });
  const old = new Y.Doc();
  Y.applyUpdate(old, Y.encodeStateAsUpdate(d));
  doc.applyAgentEdit(d, { kind: "doc", target: { kind: "document" }, markdown: "Version two." }, origin);
  assert.match(doc.render(d).text, /Version two/);
  doc.restore(d, old, { ...origin, kind: "restore" });
  assert.match(doc.render(d).text, /Version one/);
  doc.restoreText(d, "Version three.\n", { ...origin, kind: "restore" });
  assert.match(doc.render(d).text, /Version three/);
});

test("links to other folios and preview lines", () => {
  const a = "fol_01jb2k7x9hfq0b3zj0f5s2m8ra";
  assert.deepEqual(linkedFolioIds(`see /acme/-/artifacts/plan-${a} and ${a}`), [a]);
  assert.deepEqual(previewLines("# A\n\n**B** text\n\n```\ncode\n```\n", 2), ["A", "B text"]);
});
