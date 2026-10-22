import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * A section a loader defers (`<Await>`) that fails, or outlasts the page's
 * stream ("Server Timeout"), takes the whole page to its error page unless
 * it says what to show instead. Every one says so: `errorElement`, usually
 * `<Unavailable>` with its Try again (components/boundary.tsx), or `null`
 * where another part of the page already says it.
 */

const APP = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".tsx") && !path.endsWith(".test.tsx") ? [path] : [];
  });
}

/** The opening tag of each `<Await` in `text`, braces and all. */
export function awaitTags(text: string): { line: number; tag: string }[] {
  const tags: { line: number; tag: string }[] = [];
  for (const match of text.matchAll(/<Await(?=[\s>])/g)) {
    let depth = 0;
    let end = match.index! + match[0].length;
    for (; end < text.length; end++) {
      const char = text[end];
      if (char === "{") depth++;
      else if (char === "}") depth--;
      else if (char === ">" && depth === 0) break;
    }
    tags.push({ line: text.slice(0, match.index).split("\n").length, tag: text.slice(match.index, end + 1) });
  }
  return tags;
}

test("the tag reader finds each opening tag whole", () => {
  const text = 'a\n<Await resolve={x} errorElement={<Card title="a">b</Card>}>\n{(v) => v}</Await>\n// `<Await>` in a comment';
  const tags = awaitTags(text);
  assert.equal(tags.length, 2);
  assert.equal(tags[0]!.line, 2);
  assert.match(tags[0]!.tag, /errorElement/);
});

test("every deferred section says what to show if it fails", () => {
  const missing = sources(APP).flatMap((path) =>
    awaitTags(readFileSync(path, "utf8"))
      // A mention in a comment (`<Await>`) is no tag: a real one always has `resolve`.
      .filter(({ tag }) => tag !== "<Await>")
      .filter(({ tag }) => !/\berrorElement=/.test(tag))
      .map(({ line }) => `${relative(APP, path)}:${line}`),
  );
  assert.deepEqual(missing, [], "Give each <Await> an errorElement: <Unavailable what=… />, or null where the page says it elsewhere");
});
