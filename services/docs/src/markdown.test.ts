import assert from "node:assert/strict";
import { test } from "node:test";

import * as Y from "yjs";

import { parseInline, parseMarkdown, seed } from "./blocks.ts";
import { bodyCitations } from "./citations.ts";
import { citationNodes, documentMarkdown, excerpt, mentionedIds, outline, searchText, topContainers } from "./markdown.ts";

function docFrom(markdown: string) {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("document-store");
  seed(doc, fragment, markdown);
  return { doc, fragment };
}

const SAMPLE = `# Release plan

Ship **v2** on _Thursday_ with ~~no~~ \`zero\` downtime. See [the runbook](https://g1t.sh/x).

## Steps

1. Freeze main
2. Tag the release
   - with a signed tag
3. Deploy

- [x] Write notes
- [ ] Tell #support

> [!WARNING]
> Migrations run first.

> Quotes stay quotes.

\`\`\`ts
const a = 1;
\`\`\`

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`

$$
E = mc^2
$$

| Step | Owner |
| --- | --- |
| Tag | Ana |

---

![Diagram](https://g1tusercontent.com/docs/x.png)

<details>
<summary>More</summary>

Hidden text.

</details>
`;

test("Markdown survives a trip through the document", () => {
  const { fragment } = docFrom(SAMPLE);
  assert.equal(documentMarkdown(fragment), SAMPLE);
});

test("the document has BlockNote's shape: a group of containers with ids", () => {
  const { fragment } = docFrom("# Title\n\nText");
  const group = fragment.get(0) as Y.XmlElement;
  assert.equal(group.nodeName, "blockGroup");
  const tops = topContainers(fragment);
  assert.equal(tops.length, 2);
  assert.match(String(tops[0]!.getAttribute("id")), /^[0-9a-f-]{36}$/);
  const heading = tops[0]!.get(0) as Y.XmlElement;
  assert.equal(heading.nodeName, "heading");
  assert.equal(heading.getAttribute("level"), 1 as unknown as string);
  assert.equal(heading.getAttribute("textAlignment"), "left");
});

test("marks are stored as y-prosemirror stores them", () => {
  const { fragment } = docFrom("a **b** [c](https://x.y)");
  const paragraph = topContainers(fragment)[0]!.get(0) as Y.XmlElement;
  const text = paragraph.get(0) as Y.XmlText;
  assert.deepEqual(text.toDelta(), [{ insert: "a " }, { insert: "b", attributes: { bold: {} } }, { insert: " " }, { insert: "c", attributes: { link: { href: "https://x.y" } } }]);
});

test("nested list items become children", () => {
  const specs = parseMarkdown("- one\n  - two\n    - three\n- four");
  assert.equal(specs.length, 2);
  assert.equal(specs[0]!.children![0]!.children![0]!.type, "bulletListItem");
});

test("snake_case and URLs are not italicized", () => {
  assert.deepEqual(parseInline("set max_retry_count to 3"), [{ text: "set max_retry_count to 3" }]);
});

test("the outline names each top-level block for agents", () => {
  const { fragment } = docFrom("# A\n\npara\n\n- x\n  - y");
  const blocks = outline(fragment);
  assert.deepEqual(
    blocks.map((b) => [b.type, b.level, b.markdown]),
    [
      ["heading", 1, "# A"],
      ["paragraph", null, "para"],
      ["bulletListItem", null, "- x\n  - y"],
    ],
  );
});

test("mentions are found by id; search text drops markup", () => {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("document-store");
  seed(doc, fragment, "hello");
  doc.transact(() => {
    const paragraph = topContainers(fragment)[0]!.get(0) as Y.XmlElement;
    const mention = new Y.XmlElement("mention");
    mention.setAttribute("kind", "user");
    mention.setAttribute("id", "usr_1");
    mention.setAttribute("name", "ana");
    paragraph.insert(paragraph.length, [mention]);
  });
  assert.deepEqual(mentionedIds(fragment), { users: ["usr_1"], agents: [] });
  assert.equal(documentMarkdown(fragment), "hello@ana\n");
  assert.equal(searchText("## Steps\n\n- [x] **Ship** [it](https://x)"), "Steps\n Ship it");
  assert.equal(excerpt("# T\n\n" + "word ".repeat(100), 20).length, 20);
});

test("a citation chip is a link to the code, and is found as a citation", () => {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("document-store");
  seed(doc, fragment, "Exports run in ");
  doc.transact(() => {
    const paragraph = topContainers(fragment)[0]!.get(0) as Y.XmlElement;
    const chip = new Y.XmlElement("citation");
    chip.setAttribute("repo", "acme/web");
    chip.setAttribute("path", "src/export.ts");
    chip.setAttribute("kind", "symbol");
    chip.setAttribute("label", "exportCsv");
    chip.setAttribute("ref", "abc1234");
    paragraph.insert(paragraph.length, [chip]);
  });
  const markdown = documentMarkdown(fragment);
  assert.equal(markdown, "Exports run in [`exportCsv`](/acme/web/blob/abc1234/src/export.ts)\n");
  const found = bodyCitations(citationNodes(fragment), markdown);
  assert.deepEqual(
    found.map((c) => [c.repo, c.path, c.kind, c.label]),
    [["acme/web", "src/export.ts", "symbol", "exportCsv"]],
  );
});
