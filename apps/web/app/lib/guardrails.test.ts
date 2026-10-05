import assert from "node:assert/strict";
import { test } from "node:test";

import { capShare, formatCap, lines, settingsFromForm, tri } from "./guardrails.ts";

const catalog = {
  registries: ["npm", "pypi", "crates"],
  rules: ["force_push", "sudo"],
  kinds: ["implement", "review"] as const,
};

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

test("an untouched form inherits everything", () => {
  const settings = settingsFromForm(form({ restrictNetwork: "inherit", registries: "inherit" }), catalog);
  assert.equal(settings.restrictNetwork, null);
  assert.equal(settings.registries, null);
  assert.deepEqual(settings.rules, {});
  assert.deepEqual(settings.minutes, {});
  assert.equal(settings.budgetUsd, null);
  assert.deepEqual(settings.domains, []);
});

test("choices of a level's own are kept", () => {
  const settings = settingsFromForm(
    form({
      restrictNetwork: "off",
      registries: "custom",
      "registry:npm": "on",
      "registry:crates": "on",
      "rule:sudo": "off",
      "rule:force_push": "on",
      budgetUsd: "$2.50",
      "minutes:implement": "45",
      "minutes:review": "",
      domains: "api.stripe.com\n\n api.stripe.com \r\n*.example.com",
      deny: "Bash(terraform apply:*)\nkubectl",
    }),
    catalog,
  );
  assert.equal(settings.restrictNetwork, false);
  assert.deepEqual(settings.registries, ["npm", "crates"]);
  assert.deepEqual(settings.rules, { force_push: true, sudo: false });
  assert.equal(settings.budgetUsd, 2.5);
  assert.deepEqual(settings.minutes, { implement: 45 });
  assert.deepEqual(settings.domains, ["api.stripe.com", "*.example.com"]);
  assert.deepEqual(settings.deny, ["Bash(terraform apply:*)", "kubectl"]);
});

test("nonsense is passed on for the service to refuse", () => {
  const settings = settingsFromForm(form({ budgetUsd: "lots", "minutes:implement": "soon" }), catalog);
  assert.equal(settings.budgetUsd, -1);
  assert.equal(settings.minutes?.implement, 0);
});

test("zero dollars means no cap", () => {
  assert.equal(settingsFromForm(form({ budgetUsd: "0" }), catalog).budgetUsd, 0);
  assert.equal(formatCap(null), "no cap");
  assert.equal(formatCap(5), "$5.00");
});

test("helpers", () => {
  assert.equal(tri(undefined), "inherit");
  assert.equal(tri(false), "off");
  assert.deepEqual(lines(" a \nb\na"), ["a", "b"]);
  assert.equal(capShare(1, 4), 0.25);
  assert.equal(capShare(9, 4), 1);
  assert.equal(capShare(1, null), null);
});
