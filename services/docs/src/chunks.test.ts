import assert from "node:assert/strict";
import { test } from "node:test";

import { EMBED_CHARS, MAX_CHARS, MAX_CHUNKS, MIN_CHARS, chunkId, chunkMarkdown, embedText, repoFileId, textHash } from "./chunks.ts";

const para = (words: number, word = "rollback") => Array.from({ length: words }, (_, i) => `${word}${i % 7}`).join(" ") + ".";

test("passages follow headings, with the heading path", () => {
  const md = [
    "Intro words that set the scene for the runbook. " + para(40, "intro"),
    "",
    "# Runbook",
    "",
    "## Deploy",
    "",
    para(60, "deploy"),
    "",
    "## Rollback",
    "",
    para(60, "rollback"),
    "",
    "### Database",
    "",
    para(60, "database"),
  ].join("\n");
  const chunks = chunkMarkdown(md, "Operations");
  assert.deepEqual(
    chunks.map((c) => c.heading),
    [null, "Runbook › Deploy", "Runbook › Rollback", "Runbook › Rollback › Database"],
  );
  assert.deepEqual(
    chunks.map((c) => c.seq),
    [0, 1, 2, 3],
  );
  assert.match(chunks[2]!.text, /^rollback0/);
  // The heading isn't repeated in the text.
  assert.ok(!chunks[2]!.text.includes("## Rollback"));
});

test("long sections split on paragraphs, never past the most", () => {
  const md = ["## Big", "", ...Array.from({ length: 12 }, () => para(40)).flatMap((p) => [p, ""])].join("\n");
  const chunks = chunkMarkdown(md, "T");
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.text.length <= MAX_CHARS, `${c.text.length}`);
    assert.equal(c.heading, "Big");
  }
  // Nothing lost.
  const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
  assert.equal(words(chunks.map((c) => c.text).join("\n\n")), words(md) - 2);
});

test("one huge paragraph is cut at sentences", () => {
  const huge = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} explains a part of the system.`).join(" ");
  const chunks = chunkMarkdown(huge, "T");
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.text.length <= MAX_CHARS);
  assert.ok(chunks[0]!.text.endsWith("."));
});

test("tiny sections join the next, naming its heading", () => {
  const md = ["## A", "", "Short.", "", "## B", "", "Also short.", "", "## C", "", para(80)].join("\n");
  const chunks = chunkMarkdown(md, "T");
  assert.equal(chunks[0]!.heading, "A");
  assert.match(chunks[0]!.text, /Short\.\n\n\*\*B\*\*\n\nAlso short\./);
  for (const c of chunks.slice(0, -1)) assert.ok(c.text.length >= MIN_CHARS || chunks.length === 1);
});

test("a tiny last section joins the one before", () => {
  const md = ["## A", "", para(60), "", "## B", "", "The end."].join("\n");
  const chunks = chunkMarkdown(md, "T");
  assert.equal(chunks.length, 1);
  assert.match(chunks[0]!.text, /\*\*B\*\*\n\nThe end\.$/);
});

test("headings inside code fences are code, and fences stay whole", () => {
  const code = ["```sh", "# not a heading", ...Array.from({ length: 10 }, (_, i) => `echo step ${i}`), "```"].join("\n");
  const md = ["## Script", "", para(30), "", code, "", para(30)].join("\n");
  const chunks = chunkMarkdown(md, "T");
  assert.ok(chunks.every((c) => c.heading === "Script"));
  const withCode = chunks.find((c) => c.text.includes("```sh"))!;
  assert.ok(withCode.text.includes("# not a heading"));
  assert.equal((withCode.text.match(/```/g) ?? []).length, 2);
});

test("a file's front matter and leading title are not passages", () => {
  const md = ["---", "title: Setup", "---", "# Setup", "", para(60, "install")].join("\n");
  const chunks = chunkMarkdown(md, "Setup");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.heading, null);
  assert.ok(!chunks[0]!.text.includes("title:"));
});

test("empty documents have no passages; huge ones stop at the most", () => {
  assert.deepEqual(chunkMarkdown("", "T"), []);
  assert.deepEqual(chunkMarkdown("\n\n  \n", "T"), []);
  const many = Array.from({ length: MAX_CHUNKS + 30 }, (_, i) => `## S${i}\n\n${para(70)}`).join("\n\n");
  assert.equal(chunkMarkdown(many, "T").length, MAX_CHUNKS);
});

test("what is embedded leads with the title and heading", () => {
  assert.equal(embedText("Ops", { heading: "Runbook › Rollback", text: "Do this." }), "Ops › Runbook › Rollback\n\nDo this.");
  assert.equal(embedText("", { heading: null, text: "Just text." }), "Just text.");
  assert.equal(embedText("T", { heading: null, text: "x".repeat(5000) }).length, EMBED_CHARS);
});

test("hashes and ids are stable and short", () => {
  assert.equal(textHash("a"), textHash("a"));
  assert.notEqual(textHash("a"), textHash("b"));
  assert.match(textHash("anything"), /^[0-9a-f]{16}$/);
  const id = repoFileId("rds_1", "docs/a/very/long/path/that/goes/on/and/on/README.md");
  assert.equal(id, repoFileId("rds_1", "docs/a/very/long/path/that/goes/on/and/on/README.md"));
  assert.notEqual(id, repoFileId("rds_2", "docs/a/very/long/path/that/goes/on/and/on/README.md"));
  // A vector id is at most 64 bytes.
  assert.ok(chunkId(id, 149).length <= 64);
  assert.equal(chunkId("pag_1", 3), "pag_1:3");
});
