import assert from "node:assert/strict";
import { test } from "node:test";

import { type Block, type Span, blocks, inline, plainText, safeHref } from "./chat-markdown.ts";

/** Every link anywhere in parsed blocks. */
function links(list: Block[]): string[] {
  const out: string[] = [];
  const walk = (spans: Span[]) => {
    for (const span of spans) {
      if (span.t === "link") out.push(span.href);
      if ("c" in span) walk(span.c);
    }
  };
  const each = (block: Block) => {
    if (block.t === "p") block.lines.forEach(walk);
    else if (block.t === "heading") walk(block.c);
    else if (block.t === "quote") block.c.forEach(each);
    else if (block.t === "list") block.items.forEach((item) => item.forEach(each));
  };
  list.forEach(each);
  return out;
}

test("formatting: bold, italic, strikethrough and code, as people and agents write them", () => {
  assert.deepEqual(inline("**bold** __also__ *it* _it_ ~~gone~~ ~gone~ `x`"), [
    { t: "strong", c: [{ t: "text", v: "bold" }] },
    { t: "text", v: " " },
    { t: "strong", c: [{ t: "text", v: "also" }] },
    { t: "text", v: " " },
    { t: "em", c: [{ t: "text", v: "it" }] },
    { t: "text", v: " " },
    { t: "em", c: [{ t: "text", v: "it" }] },
    { t: "text", v: " " },
    { t: "del", c: [{ t: "text", v: "gone" }] },
    { t: "text", v: " " },
    { t: "del", c: [{ t: "text", v: "gone" }] },
    { t: "text", v: " " },
    { t: "code", v: "x" },
  ]);
  assert.deepEqual(inline("**_both_**"), [{ t: "strong", c: [{ t: "em", c: [{ t: "text", v: "both" }] }] }]);
  assert.deepEqual(inline("``a ` b``"), [{ t: "code", v: "a ` b" }]);
});

test("words that only look like formatting stay words", () => {
  assert.deepEqual(inline("snake_case_name and 2*3*4"), [{ t: "text", v: "snake_case_name and 2*3*4" }]);
  assert.deepEqual(inline("about ~5 min, ~/src"), [{ t: "text", v: "about ~5 min, ~/src" }]);
  assert.deepEqual(inline("\\*not\\* \\_em\\_ \\`code\\` \\@nobody"), [{ t: "text", v: "*not* _em_ `code` @nobody" }]);
  assert.deepEqual(inline("C:\\Users\\me"), [{ t: "text", v: "C:\\Users\\me" }]);
});

test("mentions, channels and references; never inside code or a link's text", () => {
  assert.deepEqual(inline("ask @reviewer about #12, g1t#3 in #web"), [
    { t: "text", v: "ask " },
    { t: "mention", name: "reviewer" },
    { t: "text", v: " about " },
    { t: "ref", repo: null, number: 12 },
    { t: "text", v: ", " },
    { t: "ref", repo: "g1t", number: 3 },
    { t: "text", v: " in " },
    { t: "channel", name: "web" },
  ]);
  assert.deepEqual(inline("`@reviewer #12`"), [{ t: "code", v: "@reviewer #12" }]);
  assert.deepEqual(inline("[ping @ana](https://x.example)"), [{ t: "link", href: "https://x.example", c: [{ t: "text", v: "ping @ana" }] }]);
  assert.deepEqual(inline("me@example.com"), [{ t: "text", v: "me@example.com" }]);
});

test("links go only to the web, mail or this site", () => {
  assert.deepEqual(inline("[docs](https://g1t.sh/docs) and https://g1t.sh/a."), [
    { t: "link", href: "https://g1t.sh/docs", c: [{ t: "text", v: "docs" }] },
    { t: "text", v: " and " },
    { t: "link", href: "https://g1t.sh/a", c: [{ t: "text", v: "https://g1t.sh/a" }] },
    { t: "text", v: "." },
  ]);
  assert.deepEqual(inline("<https://g1t.sh>"), [{ t: "link", href: "https://g1t.sh", c: [{ t: "text", v: "https://g1t.sh" }] }]);
  assert.deepEqual(inline("https://en.wikipedia.org/wiki/Foo_(bar)"), [
    { t: "link", href: "https://en.wikipedia.org/wiki/Foo_(bar)", c: [{ t: "text", v: "https://en.wikipedia.org/wiki/Foo_(bar)" }] },
  ]);
  assert.equal(safeHref("/acme/web/pull/3"), "/acme/web/pull/3");
  assert.equal(safeHref("mailto:me@example.com"), "mailto:me@example.com");
});

test("XSS: script links, raw HTML and nested tricks are text", () => {
  const evil = [
    "[x](javascript:alert(1))",
    "[x](JaVaScRiPt:alert(1))",
    "[x](  javascript:alert(1))",
    "[x](java\tscript:alert(1))",
    "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    "[x](vbscript:msgbox(1))",
    "[x](//evil.example)",
    "[x](/\\evil.example)",
    "[x](<javascript:alert(1)>)",
    "![x](javascript:alert(1))",
    "<javascript:alert(1)>",
    "[**[x](javascript:alert(1))**](javascript:alert(2))",
    "[a](https://ok.example)[b](javascript:alert(1))",
    "javascript:alert(1)",
  ];
  for (const text of evil) {
    for (const href of links(blocks(text))) assert.ok(/^(https?:\/\/|mailto:|\/(?![/\\]))/i.test(href), `${text} linked to ${href}`);
  }
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("//evil.example"), null);
  assert.equal(safeHref("/\\evil.example"), null);
  assert.equal(safeHref("https://ok.example/\u0000x"), null);
  assert.equal(safeHref("https://ok.example\\@evil.example"), null);

  // HTML is never markup: it comes through as the text it is.
  const html = blocks('<img src=x onerror="alert(1)"><script>alert(1)</script>\n<a href="javascript:alert(1)">x</a>');
  assert.deepEqual(html, [
    {
      t: "p",
      lines: [[{ t: "text", v: '<img src=x onerror="alert(1)"><script>alert(1)</script>' }], [{ t: "text", v: '<a href="javascript:alert(1)">x</a>' }]],
    },
  ]);
  // An image is a link to it, never an image.
  assert.deepEqual(inline("![logo](https://x.example/a.png)"), [{ t: "link", href: "https://x.example/a.png", c: [{ t: "text", v: "logo" }] }]);
});

test("blocks: paragraphs keep their line breaks; code, lists, quotes, headings and rules", () => {
  const parsed = blocks("Plan:\n- one\n- two\n\n```ts\nconst a = 1;\n```\n> quoted\nlast");
  assert.deepEqual(
    parsed.map((block) => block.t),
    ["p", "list", "code", "quote", "p"],
  );
  assert.deepEqual(parsed[2], { t: "code", lang: "ts", v: "const a = 1;" });
  assert.deepEqual(blocks("a\nb"), [{ t: "p", lines: [[{ t: "text", v: "a" }], [{ t: "text", v: "b" }]] }]);
  assert.deepEqual(blocks("## Summary\n---\n#general"), [
    { t: "heading", level: 2, c: [{ t: "text", v: "Summary" }] },
    { t: "hr" },
    { t: "p", lines: [[{ t: "channel", name: "general" }]] },
  ]);
  // A fence inside a fence, with a longer fence around it.
  assert.deepEqual(blocks("````md\n```\ninner\n```\n````"), [{ t: "code", lang: "md", v: "```\ninner\n```" }]);
  // An unclosed fence runs to the end.
  assert.deepEqual(blocks("```\nopen"), [{ t: "code", lang: null, v: "open" }]);
});

test("lists: numbered from where they start, nested by indenting, items with more than a line", () => {
  const [list] = blocks("3. three\n4. four\n   - deeper\n     more\n5. five");
  assert.equal(list!.t, "list");
  if (list!.t !== "list") return;
  assert.equal(list.ordered, true);
  assert.equal(list.start, 3);
  assert.equal(list.items.length, 3);
  const nested = list.items[1]![1]!;
  assert.equal(nested.t, "list");
  if (nested.t === "list") assert.deepEqual(nested.items[0], [{ t: "p", lines: [[{ t: "text", v: "deeper" }], [{ t: "text", v: "more" }]] }]);
  // A year at the start of a line is not a list.
  assert.deepEqual(blocks("We grew in\n2019. Then again.").map((b) => b.t), ["p"]);
  // Blank lines between items keep one list.
  assert.equal(blocks("- a\n\n- b").length, 1);
  // A quote holds blocks of its own.
  const [quote] = blocks("> - a\n> - b");
  assert.ok(quote!.t === "quote" && quote.c[0]!.t === "list");
});

test("deep nesting is bounded", () => {
  const deep = blocks(">".repeat(200) + " x");
  assert.equal(deep.length, 1);
  const list = blocks(Array.from({ length: 50 }, (_, i) => `${"  ".repeat(i)}- ${i}`).join("\n"));
  assert.equal(list.length, 1);
});

test("plain text: the words without the marks, for previews", () => {
  assert.equal(plainText("**bold**  and `code`\n\nnext [link](https://x.example)"), "bold and code next link");
  assert.equal(plainText("## Release\n- one\n- **two**\n\n> said\n---\n1. first"), "Release one two said 1. first");
  assert.equal(plainText("ping @ana in #web about g1t#3, snake_case_name"), "ping @ana in #web about g1t#3, snake_case_name");
  assert.equal(plainText("\\*literal\\* ~~gone~~ ![logo](https://x.example/a.png)"), "*literal* gone logo");
  assert.equal(plainText("```ts\nconst a = 1;\n```"), "const a = 1;");
  assert.equal(plainText("<b>hi</b>"), "<b>hi</b>");
  assert.equal(plainText("x".repeat(300), 140).length, 140);
  assert.ok(plainText("x".repeat(300), 140).endsWith("…"));
});
