import assert from "node:assert/strict";
import { test } from "node:test";
import { oauthCallback } from "./oauth-callback.ts";

test("successful and denied OAuth callbacks carry the exact configured issuer and state", () => {
  for (const issuer of ["https://api.g1t.sh", "https://api.example/custom"]) {
    for (const outcome of [{ code: "one-use-code" }, { error: "access_denied" }]) {
      const url = new URL(oauthCallback("http://localhost:8765/callback?keep=1&iss=wrong&code=old&error=old", { ...outcome, state: "state & value" } as Record<string, string>, issuer));
      assert.deepEqual(url.searchParams.getAll("iss"), [issuer]);
      assert.equal(url.searchParams.get("state"), "state & value");
      assert.equal(url.searchParams.get("keep"), "1");
      assert.equal(url.searchParams.get("code"), outcome.code ?? null);
      assert.equal(url.searchParams.get("error"), outcome.error ?? null);
    }
  }
});
