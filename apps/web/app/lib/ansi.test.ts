import assert from "node:assert/strict";
import { test } from "node:test";

import { markSpans, paletteRgb, parseAnsi, spanLook, stripAnsi } from "./ansi.ts";

const E = "\u001b";

test("plain text is one unstyled span", () => {
  assert.deepEqual(parseAnsi("cargo build"), [{ text: "cargo build", style: {} }]);
  assert.deepEqual(parseAnsi(""), []);
});

test("SGR codes style the text after them until a reset", () => {
  assert.deepEqual(parseAnsi(`${E}[1m${E}[32mCompiling${E}[0m g1t v0.2.0`), [
    { text: "Compiling", style: { bold: true, fg: { palette: 2 } } },
    { text: " g1t v0.2.0", style: {} },
  ]);
  // Several in one sequence, an empty one resetting, and the switches off.
  assert.deepEqual(parseAnsi(`${E}[2;3;4;9mx${E}[22;23my${E}[24;29mz${E}[mw`), [
    { text: "x", style: { dim: true, italic: true, underline: true, strike: true } },
    { text: "y", style: { underline: true, strike: true } },
    // The same look, one span.
    { text: "zw", style: {} },
  ]);
  // Bright colours, backgrounds, and the defaults back.
  assert.deepEqual(parseAnsi(`${E}[91;104mhot${E}[39mbg${E}[49mnone`), [
    { text: "hot", style: { fg: { palette: 9 }, bg: { palette: 12 } } },
    { text: "bg", style: { bg: { palette: 12 } } },
    { text: "none", style: {} },
  ]);
  assert.deepEqual(parseAnsi(`${E}[7minverse${E}[27m`), [{ text: "inverse", style: { inverse: true } }]);
});

test("256 colours and 24-bit colours, in both of their forms", () => {
  assert.deepEqual(parseAnsi(`${E}[38;5;208morange${E}[48;5;3mon`), [
    { text: "orange", style: { fg: { palette: 208 } } },
    { text: "on", style: { fg: { palette: 208 }, bg: { palette: 3 } } },
  ]);
  assert.deepEqual(parseAnsi(`${E}[38;2;255;100;0mrgb${E}[0m`), [{ text: "rgb", style: { fg: { rgb: [255, 100, 0] } } }]);
  assert.deepEqual(parseAnsi(`${E}[38:2::10:20:30mitu${E}[48:5:17mbg`), [
    { text: "itu", style: { fg: { rgb: [10, 20, 30] } } },
    { text: "bg", style: { fg: { rgb: [10, 20, 30] }, bg: { palette: 17 } } },
  ]);
  // A colour out of range is left alone, and what follows still reads.
  assert.deepEqual(parseAnsi(`${E}[38;5;999;1mx`), [{ text: "x", style: { bold: true } }]);
  assert.deepEqual(paletteRgb(16), [0, 0, 0]);
  assert.deepEqual(paletteRgb(196), [255, 0, 0]);
  assert.deepEqual(paletteRgb(232), [8, 8, 8]);
  assert.deepEqual(paletteRgb(255), [238, 238, 238]);
});

test("every other escape is dropped, and a link keeps its text", () => {
  // Moving the cursor and clearing the line, as progress bars do.
  assert.equal(stripAnsi(`${E}[2K${E}[1G  Downloading${E}[?25l done${E}[?25h`), "  Downloading done");
  // An OSC 8 hyperlink, closed with BEL and with ESC \.
  assert.equal(stripAnsi(`see ${E}]8;;https://g1t.sh${E}\\the docs${E}]8;;${E}\\ now`), "see the docs now");
  assert.equal(stripAnsi(`${E}]0;title\u0007after`), "after");
  // A character set, a two-character escape, a bell and a backspace.
  assert.equal(stripAnsi(`${E}(Bplain${E}7 kept\u0007\u0008`), "plain kept");
  // A tab stays; a sequence cut off at the end of the line goes.
  assert.equal(stripAnsi(`a\tb${E}[3`), "a\tb");
  assert.equal(stripAnsi(`end${E}`), "end");
  assert.equal(stripAnsi("no escapes"), "no escapes");
});

test("the 16 colours are theme classes; the rest are inline colours", () => {
  assert.deepEqual(spanLook({ bold: true, fg: { palette: 1 }, bg: { palette: 15 } }), { className: "ansi-fg-1 ansi-bg-15 font-bold", style: undefined });
  assert.deepEqual(spanLook({ fg: { palette: 196 }, bg: { rgb: [1, 2, 3] } }), {
    className: "",
    style: { color: "rgb(255, 0, 0)", backgroundColor: "rgb(1, 2, 3)" },
  });
  assert.deepEqual(spanLook({ inverse: true, fg: { palette: 4 } }), { className: "ansi-fg-inverse ansi-bg-4", style: undefined });
  assert.equal(spanLook({ dim: true, italic: true, underline: true }).className, "opacity-70 italic underline");
  assert.equal(spanLook({}).className, "");
});

test("a search marks its matches across spans, colours kept", () => {
  const spans = parseAnsi(`${E}[32mtest${E}[0m result: ok. Test`);
  assert.deepEqual(markSpans(spans, "T R"), [
    { text: "tes", style: { fg: { palette: 2 } }, match: false },
    { text: "t", style: { fg: { palette: 2 } }, match: true },
    { text: " r", style: {}, match: true },
    { text: "esult: ok. Test", style: {}, match: false },
  ]);
  assert.deepEqual(
    markSpans(spans, "test").map((span) => [span.text, span.match]),
    [
      ["test", true],
      [" result: ok. ", false],
      ["Test", true],
    ],
  );
  assert.deepEqual(
    markSpans(spans, "  "),
    spans.map((span) => ({ ...span, match: false })),
  );
});
