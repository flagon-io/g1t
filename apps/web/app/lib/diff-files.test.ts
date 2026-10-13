import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { FileDiff } from "@g1t/contracts";

import { forgetFiles, loadFile, peekFile } from "./diff-files.ts";

const SOURCE = "/acme/web/diff-files.json?base=&head=" + "b".repeat(40);

const file = (path: string): FileDiff => ({ path, status: "modified", additions: 1, deletions: 0, binary: false, hunks: [] });

/** A stand-in for fetch that answers with the paths asked for, and notes each address. */
function server(fail = false) {
  const asked: string[] = [];
  const fetcher = (async (url: string) => {
    asked.push(url);
    if (fail) return new Response("no", { status: 500 });
    const paths = new URL(url, "https://g1t.test").searchParams.getAll("path").filter((path) => path !== "gone.ts");
    return Response.json({ files: paths.map(file) });
  }) as typeof fetch;
  return { asked, fetcher };
}

afterEach(forgetFiles);

test("files asked for together are fetched in one request, and once", async () => {
  const { asked, fetcher } = server();
  const [a, b, gone] = await Promise.all([
    loadFile(SOURCE, "src/a.ts", { fetcher }),
    loadFile(SOURCE, "src/b c.ts", { fetcher }),
    loadFile(SOURCE, "gone.ts", { fetcher }),
  ]);
  assert.equal(asked.length, 1);
  assert.ok(asked[0]!.startsWith(SOURCE + "&path=src%2Fa.ts&path=src%2Fb%20c.ts"));
  assert.equal(a?.path, "src/a.ts");
  assert.equal(b?.path, "src/b c.ts");
  // No longer in the change: null, not an error.
  assert.equal(gone, null);
  // Asked again, or drawn again after a refresh: from what was fetched.
  assert.equal(await loadFile(SOURCE, "src/a.ts", { fetcher }), a);
  assert.equal(peekFile(SOURCE, "src/a.ts"), a);
  assert.equal(peekFile(SOURCE, "never.ts"), undefined);
  assert.equal(asked.length, 1);
});

test("many files at once go 20 to a request", async () => {
  const { asked, fetcher } = server();
  await Promise.all(Array.from({ length: 45 }, (_, n) => loadFile(SOURCE, `f${n}`, { fetcher })));
  assert.equal(asked.length, 3);
});

test("the files after one come with it, and are not asked for again", async () => {
  const { asked, fetcher } = server();
  await loadFile(SOURCE, "a", { also: ["b", "c"], fetcher });
  assert.equal(asked.length, 1);
  assert.ok(asked[0]!.endsWith("&path=b&path=c&path=a"));
  assert.equal(peekFile(SOURCE, "c")?.path, "c");
  // Reached later, they are there; one already fetched is not asked for again.
  assert.equal((await loadFile(SOURCE, "c", { also: ["a", "d"], fetcher }))?.path, "c");
  await loadFile(SOURCE, "d", { fetcher });
  assert.equal(asked.length, 2);
  assert.ok(asked[1]!.endsWith("?base=&head=" + "b".repeat(40) + "&path=d"));
});

test("a failed fetch is an error, and is tried again when asked again", async () => {
  const failing = server(true);
  await assert.rejects(loadFile(SOURCE, "src/a.ts", { fetcher: failing.fetcher }));
  assert.equal(peekFile(SOURCE, "src/a.ts"), undefined);
  const working = server();
  assert.equal((await loadFile(SOURCE, "src/a.ts", { fetcher: working.fetcher }))?.path, "src/a.ts");
  assert.equal(working.asked.length, 1);
});
