import assert from "node:assert/strict";
import { test } from "node:test";

import { type DocNode, docToMarkdown, escapeText, markdownToDoc } from "./chat-compose.ts";

const text = (value: string, ...marks: (string | { type: string; attrs?: Record<string, unknown> })[]): DocNode => ({
  type: "text",
  text: value,
  ...(marks.length ? { marks: marks.map((mark) => (typeof mark === "string" ? { type: mark } : mark)) } : {}),
});
const p = (...content: DocNode[]): DocNode => (content.length ? { type: "paragraph", content } : { type: "paragraph" });
const doc = (...content: DocNode[]): DocNode => ({ type: "doc", content });

test("formatting is written as Markdown", () => {
  assert.equal(
    docToMarkdown(doc(p(text("bold", "bold"), text(" "), text("it", "italic"), text(" "), text("gone", "strike"), text(" "), text("a*b", "code")))),
    "**bold** _it_ ~~gone~~ `a*b`",
  );
  // Marks that overlap open and close once.
  assert.equal(docToMarkdown(doc(p(text("a", "bold"), text("b", "bold", "italic"), text("c", "bold")))), "**a_b_c**");
  // Spaces at a mark's edges sit outside it.
  assert.equal(docToMarkdown(doc(p(text("say "), text(" hi ", "bold"), text("there")))), "say  **hi** there");
  assert.equal(docToMarkdown(doc(p(text("tick ` in", "code")))), "`` tick ` in ``");
});

test("links: with their text, or bare when the text is the address", () => {
  const link = (href: string) => ({ type: "link", attrs: { href } });
  assert.equal(docToMarkdown(doc(p(text("the docs", link("https://g1t.sh/docs"))))), "[the docs](https://g1t.sh/docs)");
  assert.equal(docToMarkdown(doc(p(text("https://g1t.sh", link("https://g1t.sh"))))), "https://g1t.sh");
  assert.equal(docToMarkdown(doc(p(text("x", link("https://a.example/a b"))))), "[x](<https://a.example/a%20b>)");
});

test("each paragraph is a line; an empty one is a blank line", () => {
  assert.equal(docToMarkdown(doc(p(text("one")), p(text("two")), p(), p(text("three")))), "one\ntwo\n\nthree");
  assert.equal(docToMarkdown(doc(p(), p(text("x")), p())), "x");
});

test("text that only looks like Markdown is escaped, and mentions stay mentions", () => {
  assert.equal(escapeText("2*3 and snake_case and _edge_ and [x] and `t` and ~5"), "2\\*3 and snake_case and \\_edge\\_ and \\[x\\] and \\`t\\` and \\~5");
  assert.equal(docToMarkdown(doc(p(text("- not a list")), p(text("1. not either")), p(text("# nor this")), p(text("> or this")))), "\\- not a list\n1\\. not either\n\\# nor this\n\\> or this");
  assert.equal(docToMarkdown(doc(p(text("ask @ana in #web about #12")))), "ask @ana in #web about #12");
});

test("lists, quotes and code blocks", () => {
  const item = (...content: DocNode[]): DocNode => ({ type: "listItem", content });
  assert.equal(
    docToMarkdown(
      doc(
        p(text("Plan:")),
        { type: "bulletList", content: [item(p(text("one"))), item(p(text("two")), { type: "orderedList", attrs: { start: 1 }, content: [item(p(text("deep")))] })] },
        p(text("after")),
      ),
    ),
    "Plan:\n\n- one\n- two\n  1. deep\n\nafter",
  );
  assert.equal(docToMarkdown(doc({ type: "orderedList", attrs: { start: 3 }, content: [item(p(text("c"))), item(p(text("d")))] })), "3. c\n4. d");
  assert.equal(docToMarkdown(doc({ type: "blockquote", content: [p(text("quoted")), p(), p(text("more"))] })), "> quoted\n>\n> more");
  assert.equal(docToMarkdown(doc({ type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const a = 1;\n\n\nconst b = `x`;" }] })), "```ts\nconst a = 1;\n\n\nconst b = `x`;\n```");
  assert.equal(docToMarkdown(doc({ type: "codeBlock", attrs: { language: null }, content: [{ type: "text", text: "```\nfence\n```" }] })), "````\n```\nfence\n```\n````");
});

test("Markdown comes back into the composer as it was written", () => {
  const samples = [
    "**bold** _it_ ~~gone~~ `code`",
    "one\ntwo\n\nthree",
    "Plan:\n\n- one\n- two\n  1. deep\n\nafter",
    "3. c\n4. d",
    "> quoted\n>\n> more",
    "```ts\nconst a = 1;\n\nconst b = 2;\n```",
    "[the docs](https://g1t.sh/docs) and https://g1t.sh",
    "ask @ana in #web about g1t#12",
    "\\- not a list and 2\\*3 and snake_case",
    "**a _b_ c**",
    "| Session | Length |\n| --- | --: |\n| **Welcome** | `45` min |",
  ];
  for (const sample of samples) assert.equal(docToMarkdown(markdownToDoc(sample)), sample, sample);
});

test("Markdown the composer cannot write still comes in", () => {
  // A heading is a bold line; a rule is left out; an image is a link.
  assert.equal(docToMarkdown(markdownToDoc("## Notes\n---\ntext")), "**Notes**\ntext");
  assert.equal(docToMarkdown(markdownToDoc("*star em* and __strong__ and ~one~")), "_star em_ and **strong** and ~~one~~");
  assert.deepEqual(markdownToDoc(""), { type: "doc", content: [{ type: "paragraph" }] });
});
