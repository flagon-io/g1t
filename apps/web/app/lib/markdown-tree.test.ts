import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { rehypeAlerts, rehypeReferences } from "./markdown-plugins.ts";
import { markdownTree, renderMarkdownTree } from "./markdown-tree.ts";

// components/markdown.tsx's options: GitHub flavour, sanitized raw HTML,
// alerts and references.
const SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), ["className", /^language-./]],
  },
};
const repo = { namespace: "acme", name: "web" };
const options = {
  remarkPlugins: [remarkGfm],
  rehypePlugins: [rehypeRaw, [rehypeSanitize, SCHEMA], rehypeAlerts, [rehypeReferences, { repo }]],
} as const;

// Components that read the node they are given, as the real ones do.
const components: Components = {
  a: ({ href, children, node }) =>
    createElement("a", { href, "data-ref": String((node?.properties as { dataRef?: string } | undefined)?.dataRef ?? "") }, children),
  blockquote: ({ children, node }) =>
    createElement("blockquote", { "data-alert": String((node?.properties as { dataAlert?: string } | undefined)?.dataAlert ?? "") }, children),
  h2: ({ children }) => createElement("h2", { className: "heading" }, children),
  img: ({ src, alt }) => createElement("img", { src: typeof src === "string" ? `/raw/${src}` : undefined, alt: alt ?? "" }),
};

const root = new URL("../../../../", import.meta.url);
const SAMPLES: [string, string][] = [
  ["README.md", readFileSync(new URL("README.md", root), "utf8")],
  ["docs/PERFORMANCE.md", readFileSync(new URL("docs/PERFORMANCE.md", root), "utf8")],
  ["CONTRIBUTING.md", readFileSync(new URL("CONTRIBUTING.md", root), "utf8")],
  [
    "edge cases",
    [
      "# Title",
      "",
      "> [!WARNING]",
      "> Careful with #12, acme/api#3 and @Ana, and commit 0123456789abcdef0123456789abcdef01234567.",
      "",
      "- [x] done",
      "- [ ] not done",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "Footnote[^1] and ~~gone~~ and https://example.com.",
      "",
      "[^1]: The note.",
      "",
      '<div align="center"><img src="logo.png" alt="Logo" onerror="alert(1)"><script>alert(1)</script></div>',
      "",
      "[bad](javascript:alert(1)) [rel](./docs/x.md) [abs](/acme/web) ![pic](img/a.png)",
      "",
      "<details><summary>More</summary>",
      "",
      "Inside **details**.",
      "",
      "</details>",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "",
      '<a href="vbscript:x" title="t">raw link</a> <iframe src="https://evil"></iframe>',
    ].join("\n"),
  ],
  ["empty", ""],
];

for (const [name, source] of SAMPLES) {
  test(`${name}: the kept tree renders exactly what react-markdown renders`, () => {
    const expected = renderToStaticMarkup(createElement(ReactMarkdown, { ...options, components, children: source }));
    const tree = markdownTree(source, options as never);
    assert.equal(renderToStaticMarkup(renderMarkdownTree(tree, components)), expected);
    // Rendering does not change the tree: rendered again, it is the same.
    assert.equal(renderToStaticMarkup(renderMarkdownTree(tree, components)), expected);
  });
}
