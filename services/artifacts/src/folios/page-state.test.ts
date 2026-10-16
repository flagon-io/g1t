import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("./service.ts", import.meta.url))], bundle: true, write: false, format: "esm", platform: "node",
  plugins: [{ name: "worker-host", setup(build) {
    build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "host", namespace: "host" }));
    build.onLoad({ filter: /.*/, namespace: "host" }, () => ({ contents: "export class DurableObject {}" }));
  } }],
});
const { Folios } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

test("a cold room never holds up page state; its snapshot is saved in the background", async () => {
  let resolve!: (value: Uint8Array) => void;
  const pending = new Promise<Uint8Array>((done) => { resolve = done; });
  const deferred: Promise<unknown>[] = [];
  const writes: unknown[][] = [];
  const statement = { bind: (...values: unknown[]) => { writes.push(values); return statement; }, run: async () => ({ success: true }) };
  const service = new Folios({ DB: { prepare: () => statement } }, (work: Promise<unknown>) => deferred.push(work));
  service.ready = async () => ({ state: () => pending });
  assert.equal(service.stateFor({ slug: "cold" }, { id: "folio_cold", state: null }), null);
  assert.equal(deferred.length, 1);
  assert.deepEqual(writes, []);
  const bytes = new Uint8Array([1, 2, 3]);
  resolve(bytes);
  await Promise.all(deferred);
  assert.deepEqual(writes, [[bytes, "folio_cold"]]);
});

test("saved state and trashed documents never wake the live room", () => {
  const service = new Folios({}, () => assert.fail("must not start background work"));
  assert.equal(service.stateFor({}, { state: [104, 105] }), btoa("hi"));
  assert.equal(service.stateFor({}, { state: null, trashed_at: "2026-10-15" }), null);
});
