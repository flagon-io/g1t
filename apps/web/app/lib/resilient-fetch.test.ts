import assert from "node:assert/strict";
import test from "node:test";

import { PATIENCE_MS, REFRESH_PATIENCE_MS, installResilientFetch, isNetworkFailure, keepTrying, refreshesCurrent, retriable, retryDelay, watchBuildNavigation } from "./resilient-fetch.ts";
import { reconnectDelay } from "./reconnect.ts";

const ORIGIN = "https://g1t.sh";
const url = (path: string) => new URL(path, ORIGIN);

test("only an active navigation carries its build; fetchers, refreshes and writes never force a document switch", async () => {
  const calls: Headers[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  let late: Promise<Response> | undefined;
  const browser = { location: new URL("https://g1t.sh/edit"), fetch: async (_input: unknown, init?: RequestInit) => { calls.push(new Headers(init?.headers)); return late ?? new Response(null); } };
  Object.defineProperty(globalThis, "window", { value: browser, configurable: true });
  let destination: { pathname: string; search: string } | undefined;
  const stop = watchBuildNavigation(() => destination);
  try {
    installResilientFetch("old-build");
    await browser.fetch("/notifications.data");
    destination = { pathname: "/next", search: "?tab=one" };
    await browser.fetch("/next.data?tab=one&_routes=root");
    await browser.fetch("/unrelated.data");
    await browser.fetch("/next.data?tab=one", { method: "POST" });
    await browser.fetch("/edit.data");
    await browser.fetch("https://external.example/next.data?tab=one");
    assert.deepEqual(calls.map((headers) => headers.get("x-g1t-build")), [null, "old-build", null, null, null, null]);
    for (const path of ["/next.data?tab=one", "/__manifest?paths=/next"]) {
      let finish!: (response: Response) => void;
      late = new Promise<Response>((resolve) => { finish = resolve; });
      const controller = new AbortController();
      const abandoned = browser.fetch(path, { signal: controller.signal });
      // A transport can finish after the second click canceled the first.
      controller.abort();
      const rejected = assert.rejects(abandoned, { name: "AbortError" });
      finish(new Response(null, { status: 204, headers: { "X-Remix-Reload-Document": "true" } }));
      await rejected;
      late = undefined;
      assert.equal((await browser.fetch("/newer.data")).status, 200);
    }
  } finally {
    stop();
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("a request that got no answer, in each browser's words, is a network failure", () => {
  assert.equal(isNetworkFailure(new TypeError("Failed to fetch")), true);
  assert.equal(isNetworkFailure(new TypeError("NetworkError when attempting to fetch resource.")), true);
  assert.equal(isNetworkFailure(new TypeError("Load failed")), true);
});

test("a stale build, an abort or a server's error is not", () => {
  assert.equal(isNetworkFailure(new TypeError("Failed to fetch dynamically imported module: https://g1t.sh/assets/a.js")), false);
  assert.equal(isNetworkFailure(new DOMException("The user aborted a request.", "AbortError")), false);
  assert.equal(isNetworkFailure(new Error("Failed to fetch")), false);
  assert.equal(isNetworkFailure({ status: 500 }), false);
});

test("only the router's own reads are sent again", () => {
  assert.equal(retriable(url("/flagon-io/g1t/settings/repository.data?_routes=root"), "GET", ORIGIN), true);
  assert.equal(retriable(url("/__manifest?p=/a"), "get", ORIGIN), true);
  assert.equal(retriable(url("/flagon-io/g1t/settings/repository.data"), "POST", ORIGIN), false);
  assert.equal(retriable(url("/-/notify"), "GET", ORIGIN), false);
  assert.equal(retriable(new URL("https://otel.g1t.sh/x.data"), "GET", ORIGIN), false);
});

test("a read for the page already showing is a refresh; one for another page is a navigation", () => {
  const here = { pathname: "/flagon-io/g1t/settings/repository", search: "" };
  assert.equal(refreshesCurrent(url("/flagon-io/g1t/settings/repository.data?_routes=root,routes/repo/layout"), here), true);
  assert.equal(refreshesCurrent(url("/flagon-io/g1t/issues.data"), here), false);
  assert.equal(refreshesCurrent(url("/_root.data"), { pathname: "/", search: "" }), true);
  assert.equal(refreshesCurrent(url("/a.data?tab=open&_routes=x"), { pathname: "/a", search: "?tab=open" }), true);
  assert.equal(refreshesCurrent(url("/a.data?tab=closed"), { pathname: "/a", search: "?tab=open" }), false);
});

test("retries come quickly at first, then settle", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(retryDelay), [250, 500, 1000, 2000, 4000, 5000]);
  assert.deepEqual([1, 2, 3, 4, 8].map(reconnectDelay), [3000, 6000, 12000, 24000, 30000]);
});

test("a refresh waits out the browser being offline, however long", () => {
  assert.equal(keepTrying({ refresh: true, elapsedMs: 60 * 60_000, onlineMs: 0, erroring: false }, 5000), true);
});

test("a network that is up and never answers is no blip: a refresh gives up, and so does a click", () => {
  assert.equal(keepTrying({ refresh: true, elapsedMs: 0, onlineMs: REFRESH_PATIENCE_MS - 5000, erroring: false }, 5000), true);
  assert.equal(keepTrying({ refresh: true, elapsedMs: 0, onlineMs: REFRESH_PATIENCE_MS - 4000, erroring: false }, 5000), false);
  assert.equal(keepTrying({ refresh: false, elapsedMs: PATIENCE_MS - 4000, onlineMs: 0, erroring: false }, 5000), false);
});

test("while the error page tries on its own, a read is tried once", () => {
  assert.equal(keepTrying({ refresh: true, elapsedMs: 0, onlineMs: 0, erroring: true }, 250), false);
});
