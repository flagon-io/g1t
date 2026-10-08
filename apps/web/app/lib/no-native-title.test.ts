import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Hover hints are the site's tooltip (components/ui/hint.tsx, or Tooltip
// from components/ui/tooltip.tsx), never the browser's `title`: it looks
// foreign, waits a second and a half, and never shows on a touch screen or
// to the keyboard. This fails on a `title` on an HTML element, or on a
// component that hands its props to one.

/** Components that pass `title` on to an HTML element. */
const FORWARDS = ["Link", "NavLink", "Button", "ButtonLink", "SubmitButton", "Badge", "Switch", "Input", "Textarea", "TabLink"];

/**
 * Where a native `title` is right. `file:line`, with the reason. An SVG's
 * `<title>` child is an element, not an attribute, and needs no entry.
 */
const ALLOWED: Record<string, string> = {};

const APP = fileURLToPath(new URL("..", import.meta.url));

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (entry.name.endsWith(".tsx")) yield path;
  }
}

/** Each opening tag of an HTML element or a forwarding component with a `title` attribute. */
function nativeTitles(source: string): { tag: string; line: number }[] {
  const found: { tag: string; line: number }[] = [];
  const opening = new RegExp(`<([a-z][a-z0-9]*|${FORWARDS.join("|")})(?=[\\s/>])`, "g");
  for (let match = opening.exec(source); match; match = opening.exec(source)) {
    // The tag's attributes, up to its closing `>`, with every {...} left out.
    let attributes = "";
    let depth = 0;
    let quote: string | null = null;
    for (let i = match.index + match[0].length; i < source.length; i++) {
      const c = source[i];
      if (quote) {
        if (c === quote) quote = null;
        if (depth === 0) attributes += c;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
      if (depth === 0) attributes += c;
    }
    if (/(^|\s)title=/.test(attributes)) {
      found.push({ tag: match[1], line: source.slice(0, match.index).split("\n").length });
    }
  }
  return found;
}

test("finds a title on an element, not on a component's own prop or inside an expression", () => {
  const hits = nativeTitles(
    [
      `<span title="x">a</span>`,
      `<Section title="Heading">`,
      `<div\n  className="a"\n  title={label}\n>`,
      `<Link to="/" title={x}>`,
      `<button onClick={() => open({ title: "x" })}>`,
      `<p className={cn("a", b && "title=")}>`,
    ].join("\n"),
  );
  assert.deepEqual(hits, [
    { tag: "span", line: 1 },
    { tag: "div", line: 3 },
    { tag: "Link", line: 7 },
  ]);
});

test("no native title hints in apps/web", () => {
  const offenders: string[] = [];
  for (const file of sources(APP)) {
    const name = relative(APP, file).replaceAll("\\", "/");
    for (const { tag, line } of nativeTitles(readFileSync(file, "utf8"))) {
      if (!ALLOWED[`${name}:${line}`]) offenders.push(`app/${name}:${line} <${tag} title=…>`);
    }
  }
  assert.deepEqual(offenders, [], "Use <Hint label=…> from components/ui/hint.tsx in place of a native title.");
});
