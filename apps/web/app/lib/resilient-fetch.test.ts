import assert from "node:assert/strict";
import test from "node:test";

import { isNetworkFailure, refreshesCurrent, retriable, retryDelay } from "./resilient-fetch.ts";
import { reconnectDelay } from "./reconnect.ts";

const ORIGIN = "https://g1t.sh";
const url = (path: string) => new URL(path, ORIGIN);

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
