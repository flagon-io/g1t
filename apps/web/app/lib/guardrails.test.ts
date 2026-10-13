import assert from "node:assert/strict";
import { test } from "node:test";

import { settingsFromForm } from "./guardrails.ts";

const catalog = { kinds: ["implement", "review"] as const };

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

test("an untouched form inherits everything", () => {
  assert.deepEqual(settingsFromForm(form({}), catalog), { minutes: {} });
});

test("time caps of a level's own are kept, and nothing else is sent", () => {
  const settings = settingsFromForm(
    form({
      "minutes:implement": "45",
      "minutes:review": "",
      // Fields of a page from before network settings were removed.
      restrictNetwork: "on",
      domains: "api.stripe.com",
    }),
    catalog,
  );
  assert.deepEqual(settings, { minutes: { implement: 45 } });
});

test("nonsense is passed on for the service to refuse", () => {
  const settings = settingsFromForm(form({ "minutes:implement": "soon" }), catalog);
  assert.equal(settings.minutes?.implement, 0);
});
