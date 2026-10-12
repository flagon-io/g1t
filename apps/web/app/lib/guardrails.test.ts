import assert from "node:assert/strict";
import { test } from "node:test";

import { capShare, formatCap, lines, settingsFromForm, tri, workflowDomainLine, workflowDomains } from "./guardrails.ts";

const catalog = {
  registries: ["npm", "pypi", "crates"],
  kinds: ["implement", "review"] as const,
};

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

test("workflow-only domains are read one per line, and written back the same way", () => {
  const read = workflowDomains(
    " api.cloudflare.com | deploy.yml | production \n\n*.example.com\nhooks.example.com | | staging, production\nci.example.com | ci.yml, release.yml\n | deploy.yml",
  );
  assert.deepEqual(read, [
    { domain: "api.cloudflare.com", workflows: ["deploy.yml"], environments: ["production"] },
    { domain: "*.example.com", workflows: [], environments: [] },
    { domain: "hooks.example.com", workflows: [], environments: ["staging", "production"] },
    { domain: "ci.example.com", workflows: ["ci.yml", "release.yml"], environments: [] },
  ]);
  assert.deepEqual(read.map(workflowDomainLine), [
    "api.cloudflare.com | deploy.yml | production",
    "*.example.com",
    "hooks.example.com |  | staging, production",
    "ci.example.com | ci.yml, release.yml",
  ]);
  const settings = settingsFromForm(form({ workflowDomains: "api.cloudflare.com | deploy.yml | production" }), catalog);
  assert.deepEqual(settings.workflowDomains, [{ domain: "api.cloudflare.com", workflows: ["deploy.yml"], environments: ["production"] }]);
});

test("an untouched form inherits everything", () => {
  const settings = settingsFromForm(form({ restrictNetwork: "inherit", registries: "inherit" }), catalog);
  assert.equal(settings.restrictNetwork, null);
  assert.equal(settings.registries, null);
  assert.deepEqual(settings.minutes, {});
  assert.deepEqual(settings.domains, []);
});

test("choices of a level's own are kept", () => {
  const settings = settingsFromForm(
    form({
      restrictNetwork: "off",
      registries: "custom",
      "registry:npm": "on",
      "registry:crates": "on",
      "minutes:implement": "45",
      "minutes:review": "",
      domains: "api.stripe.com\n\n api.stripe.com \r\n*.example.com",
    }),
    catalog,
  );
  assert.equal(settings.restrictNetwork, false);
  assert.deepEqual(settings.registries, ["npm", "crates"]);
  assert.deepEqual(settings.minutes, { implement: 45 });
  assert.deepEqual(settings.domains, ["api.stripe.com", "*.example.com"]);
});

test("nonsense is passed on for the service to refuse", () => {
  const settings = settingsFromForm(form({ "minutes:implement": "soon" }), catalog);
  assert.equal(settings.minutes?.implement, 0);
});

test("a cap reads as dollars, or no cap", () => {
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
