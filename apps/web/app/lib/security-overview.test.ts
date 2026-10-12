import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type OverviewFacts,
  POLICY_PATHS,
  overviewRows,
  rowsIn,
  securityPolicyBranch,
  securityPolicyPullBody,
  securityPolicyTemplate,
} from "./security-overview.ts";

const facts = (over: Partial<OverviewFacts> = {}): OverviewFacts => ({
  base: "/acme/rocket",
  policyPath: null,
  reporting: false,
  advisories: 0,
  upkeep: true,
  codeScanning: { configured: false, analyses: 0, entitled: true },
  historyAlerts: true,
  canManage: true,
  canPush: true,
  ...over,
});

test("every feature is one row with a status word and one thing to do", () => {
  const rows = overviewRows(facts());
  assert.deepEqual(
    rows.map((row) => [row.key, row.status]),
    [
      ["policy", "needs_setup"],
      ["advisories", "enabled"],
      ["reporting", "disabled"],
      ["dependency_alerts", "enabled"],
      ["security_updates", "enabled"],
      ["code_scanning", "needs_setup"],
      ["secret_scanning", "enabled"],
      ["code_quality", "coming"],
    ],
  );
  // No policy: a pull request adds one, for someone who can push.
  assert.deepEqual(rows[0].action, { kind: "post", label: "Set up a security policy", action: "/acme/rocket/security/policy/setup", pending: "Opening a pull request…" });
  // Code scanning not set up: the starter workflow, for an admin on an entitled repository.
  assert.equal(rows[5].action?.kind, "post");
  // Switches are for admins; the words say what they switch.
  assert.deepEqual(rows[2].action, { kind: "switch", label: "Private vulnerability reporting", intent: "reporting", on: false });
  assert.deepEqual(rows[4].action, { kind: "switch", label: "Security updates", intent: "upkeep", on: true });
  // Code quality is honest about not being there.
  assert.equal(rows[7].action, null);
  assert.equal(rowsIn(rows, "findings").length, 5);
  assert.equal(rowsIn(rows, "reporting").length, 2);
});

test("what is on reads as enabled, with a link to it", () => {
  const rows = overviewRows(facts({ policyPath: "SECURITY.md", reporting: true, advisories: 2, codeScanning: { configured: true, analyses: 3, entitled: true } }));
  assert.equal(rows[0].status, "enabled");
  assert.deepEqual(rows[0].action, { kind: "link", label: "View policy", to: "/acme/rocket/blob/HEAD/SECURITY.md" });
  assert.equal(rows[1].about, "2 published advisories tell people who depend on this repository what to do.");
  assert.equal(rows[2].status, "enabled");
  assert.equal(rows[5].status, "enabled");
  assert.deepEqual(rows[5].action, { kind: "link", label: "View alerts", to: "/acme/rocket/security/code-scanning" });
});

test("someone who cannot change settings sees the rows without the switches", () => {
  const rows = overviewRows(facts({ canManage: false, canPush: false, codeScanning: { configured: false, analyses: 0, entitled: false } }));
  assert.equal(rows[0].action, null);
  assert.equal(rows[2].action, null);
  assert.equal(rows[4].action, null);
  // Code scanning on a private repository without the plan: a page that says so, not a form.
  assert.deepEqual(rows[5].action, { kind: "link", label: "Learn more", to: "/acme/rocket/security/code-scanning" });
  assert.match(rows[5].hint ?? "", /g1t plan/);
  assert.equal(rows[6].hint, "Push protection is always on.");
  assert.match(overviewRows(facts({ historyAlerts: false }))[6].about, /history are off/);
});

test("the policy template says how to report and names the private form when it is on", () => {
  const withForm = securityPolicyTemplate("acme/rocket", true, "/acme/rocket");
  assert.match(withForm, /^# Security policy/);
  assert.match(withForm, /https:\/\/g1t\.sh\/acme\/rocket\/security\/report/);
  assert.match(withForm, /## Supported versions/);
  const without = securityPolicyTemplate("acme/rocket", false, "/acme/rocket");
  assert.doesNotMatch(without, /security\/report/);
  assert.match(without, /Email the maintainers/);
  assert.match(securityPolicyPullBody("SECURITY.md"), /`SECURITY\.md`/);
  assert.equal(securityPolicyBranch([]), "add-security-policy");
  assert.equal(securityPolicyBranch(["add-security-policy", "add-security-policy-2"]), "add-security-policy-3");
  assert.equal(POLICY_PATHS[0], "SECURITY.md");
});
