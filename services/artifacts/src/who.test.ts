import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

import type { WhoEnv } from "./who.ts";

// Resolve the contracts package's bundler-style imports as production does.
const bundle = await build({ entryPoints: [fileURLToPath(new URL("./who.ts", import.meta.url))], bundle: true, write: false, format: "esm", platform: "node" });
const { Who, forgetKept }: typeof import("./who.ts") = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function environment(read: () => Promise<Response>): WhoEnv {
  const statement = { bind: () => statement, run: async () => ({ success: true }) };
  return { IDENTITY: { fetch: read }, DB: { prepare: () => statement } as unknown as D1Database };
}

test("a cold request cannot make another request wait on its workspace I/O", async () => {
  forgetKept();
  const first = deferred<Response>();
  let calls = 0;
  const workspace = { id: "ws_cold", slug: "cold" };
  const env = environment(async () => (++calls === 1 ? first.promise : Response.json(workspace)));
  const one = new Who(env);
  const pending = one.workspace("cold");
  assert.equal(one.workspace("cold"), pending, "deduplicate within one request");
  const two = new Who(env).workspace("cold");
  assert.equal(calls, 2, "independent requests must start independent I/O on a miss");
  assert.deepEqual(await two, workspace, "request two completes while request one is still pending");
  first.resolve(Response.json(null));
  assert.equal(await pending, null);
  assert.deepEqual(await new Who(env).workspace("cold"), workspace);
  assert.equal(calls, 2, "a late miss must not evict a successful cached answer");
});

test("failed workspace reads are retried by the next request", async () => {
  forgetKept();
  let calls = 0;
  const env = environment(async () => {
    if (++calls === 1) throw new Error("connection lost");
    return Response.json({ id: "ws_retry", slug: "retry" });
  });
  assert.equal(await new Who(env).workspace("retry"), null);
  assert.equal((await new Who(env).workspace("retry"))?.id, "ws_retry");
  assert.equal(calls, 2);
});
