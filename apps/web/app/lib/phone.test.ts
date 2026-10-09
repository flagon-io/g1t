import assert from "node:assert/strict";
import { test } from "node:test";

import { isPhone } from "./phone.ts";

const headers = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? null });

test("a phone is told by its client hint, else its user agent", () => {
  assert.equal(isPhone(headers({ "sec-ch-ua-mobile": "?1" })), true);
  assert.equal(isPhone(headers({ "sec-ch-ua-mobile": "?0", "user-agent": "iPhone" })), false);
  assert.equal(isPhone(headers({ "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" })), true);
  assert.equal(isPhone(headers({ "user-agent": "Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari" })), true);
  assert.equal(isPhone(headers({ "user-agent": "Mozilla/5.0 (iPad; CPU OS 18_0)" })), false);
  assert.equal(isPhone(headers({ "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)" })), false);
});
