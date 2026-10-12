import assert from "node:assert/strict";
import { test } from "node:test";

import { threadLink } from "./write-up.ts";

test("a thread's link is its conversation with ?thread=", () => {
  assert.equal(threadLink("https://g1t.sh/", "/acme/-/chat/launch", "msg_1"), "https://g1t.sh/acme/-/chat/launch?thread=msg_1");
  assert.equal(threadLink("https://g1t.sh", "/acme/-/chat/dm/chn_1", "a b"), "https://g1t.sh/acme/-/chat/dm/chn_1?thread=a%20b");
});
