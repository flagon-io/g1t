import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILD_HEADER, needsBuildRefresh } from "./build-version.ts";

test("old navigation reads switch builds before loaders; writes and ordinary documents do not", () => {
  const request = (path: string, method = "GET", build = "old") => new Request(`https://g1t.sh${path}`, { method, headers: { [BUILD_HEADER]: build } });
  assert.equal(needsBuildRefresh(request("/flagon-io/-/home.data"), "new"), true);
  assert.equal(needsBuildRefresh(request("/flagon-io/-/home.data", "GET", "new"), "new"), false);
  assert.equal(needsBuildRefresh(request("/flagon-io/-/home.data", "POST"), "new"), false);
  assert.equal(needsBuildRefresh(request("/flagon-io/-/home"), "new"), false);
  assert.equal(needsBuildRefresh(new Request("https://g1t.sh/a.data"), "new"), false);
});
