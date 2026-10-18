import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_ATTACHMENT_BYTES,
  caretAfter,
  deferredRefs,
  deferredUrl,
  dragsFiles,
  imageMarkdown,
  imageName,
  insertion,
  pastedImages,
  placeholderFor,
  refusal,
  replacePlaceholder,
  resolveDeferred,
  uploadFailure,
} from "./attachments.ts";

const png = (name = "screenshot.png", size = 1000) => ({ name, type: "image/png", size });

test("a paste uploads image files only when it has no text", () => {
  // A screenshot, or an image copied from a page (its HTML, no text).
  assert.deepEqual(pastedImages({ files: [png()], text: "" }), [png()]);
  // A spreadsheet's cells or a document's paragraphs, with a picture of themselves.
  assert.deepEqual(pastedImages({ files: [png("image.png")], text: "a\tb\n1\t2" }), []);
  // Plain text.
  assert.deepEqual(pastedImages({ files: [], text: "hello" }), []);
  // Files that are not images are left to the browser.
  assert.deepEqual(pastedImages({ files: [{ name: "a.pdf", type: "application/pdf", size: 3 }], text: "" }), []);
  // Several images, each its own.
  assert.equal(pastedImages({ files: [png("a.png"), png("b.png")], text: "  " }).length, 2);
});

test("only a drag that carries files is taken", () => {
  assert.equal(dragsFiles(["Files"]), true);
  assert.equal(dragsFiles(["text/plain", "text/html"]), false);
});

test("what is refused before it is sent, in a plain sentence", () => {
  assert.equal(refusal(png()), null);
  assert.equal(refusal({ name: "big.png", type: "image/png", size: MAX_ATTACHMENT_BYTES + 1 }), "big.png is over 10 MB, so it wasn't attached.");
  assert.equal(refusal({ name: "logo.svg", type: "image/svg+xml", size: 10 }), "logo.svg isn't a PNG, JPEG, GIF or WebP image, so it wasn't attached.");
  assert.equal(refusal({ name: "x.png", type: "image/png", size: 0 }), "x.png is empty, so it wasn't attached.");
  assert.equal(refusal({ name: "a.jpg", type: "image/JPEG", size: 10 }), null);
});

test("a pasted image with no name is image.png", () => {
  assert.equal(imageName({ name: "", type: "image/png", size: 1 }), "image.png");
  assert.equal(imageName({ name: "", type: "image/jpeg", size: 1 }), "image.jpg");
  assert.equal(imageName({ name: "C:\\shots\\Preview 1.png", type: "image/png", size: 1 }), "Preview 1.png");
});

test("Markdown escapes the name's brackets", () => {
  assert.equal(imageMarkdown("a]b[c\\.png", "https://u/attachments/ab"), "![a\\]b\\[c\\\\.png](https://u/attachments/ab)");
});

test("each upload has a placeholder of its own", () => {
  const first = placeholderFor("image.png", "");
  assert.equal(first, "![Uploading image.png…]()");
  const second = placeholderFor("image.png", `Look:\n${first}\n`);
  assert.equal(second, "![Uploading image.png (2)…]()");
  assert.notEqual(placeholderFor("image.png", `${first}${second}`), second);
});

test("an image goes in on a line of its own", () => {
  const md = "![x](u)";
  assert.deepEqual(insertion("", 0, 0, md), { text: md, start: 0, end: 0, caret: md.length });
  assert.deepEqual(insertion("Before after", 6, 7, md), { text: `\n${md}\n`, start: 6, end: 7, caret: 7 + md.length });
  assert.deepEqual(insertion("Line\n", 5, 5, md), { text: md, start: 5, end: 5, caret: 5 + md.length });
});

test("the placeholder is swapped where it is now, keeping what was written around it", () => {
  const placeholder = placeholderFor("shot.png", "");
  const typedSince = `Before\n${placeholder}\nAfter, written while it uploaded`;
  assert.equal(replacePlaceholder(typedSince, placeholder, "![shot.png](https://u/a)"), "Before\n![shot.png](https://u/a)\nAfter, written while it uploaded");
  // A failed upload takes the placeholder and its line out.
  assert.equal(replacePlaceholder(typedSince, placeholder, ""), "Before\nAfter, written while it uploaded");
  assert.equal(replacePlaceholder(`Text\n${placeholder}`, placeholder, ""), "Text");
  // Deleted by the person: nothing changes.
  assert.equal(replacePlaceholder("They removed it", placeholder, "![x](u)"), "They removed it");
  // Two of the same name: only its own.
  const second = placeholderFor("shot.png", placeholder);
  assert.equal(replacePlaceholder(`${placeholder}\n${second}`, second, "B"), `${placeholder}\nB`);
});

test("a refusal from the service reads as a sentence", () => {
  assert.equal(uploadFailure("a.png", { code: "too_large", message: "An attachment can be at most 10 MB." }), "a.png is over 10 MB, so it wasn't attached.");
  assert.equal(uploadFailure("a.png", { code: "forbidden" }), "You can't attach images here, so a.png wasn't attached.");
  assert.equal(uploadFailure("a.png", null), "a.png didn't upload. Try again in a moment.");
});

test("deferred images get their addresses once the work item is open", () => {
  const body = `Steps:\n![a.png](${deferredUrl("k1")})\n![b.png](${deferredUrl("k2")})\nEnd`;
  assert.deepEqual([...deferredRefs(body)], ["k1", "k2"]);
  const resolved = resolveDeferred(
    body,
    new Map([
      ["k1", "https://u/attachments/1"],
      ["k2", null],
    ]),
  );
  assert.equal(resolved, "Steps:\n![a.png](https://u/attachments/1)\nEnd");
  // A ref it was not given is left alone.
  assert.equal(resolveDeferred(`![c](${deferredUrl("k3")})`, new Map()), "![c](attachment:k3)");
});

test("the caret stays in the person's writing when a placeholder is swapped", () => {
  // "ab[PLACEHOLDER]cd": the placeholder is 2..10, and becomes 20 characters.
  assert.equal(caretAfter(1, 2, 10, 20), 1);
  assert.equal(caretAfter(2, 2, 10, 20), 2);
  // Right at its end, where a paste leaves it: after the image, nothing selected.
  assert.equal(caretAfter(10, 2, 10, 20), 22);
  assert.equal(caretAfter(12, 2, 10, 20), 24);
  // Taken out (a failed upload): after it moves back.
  assert.equal(caretAfter(12, 2, 10, 0), 4);
});
