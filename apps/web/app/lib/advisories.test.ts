import assert from "node:assert/strict";
import { test } from "node:test";

import { advisoryFromForm, advisoryStanding, parseAdvisoryState, parseReportState, parseSeverity, reportFromForm } from "./advisories.ts";

const form = (fields: Record<string, string>): FormData => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

test("an advisory form is checked and cleaned", () => {
  const input = advisoryFromForm(
    form({
      title: "  Path traversal in the archive reader ",
      description: "Details",
      severity: "high",
      cveId: "cve-2026-12345",
      cvssScore: "8.1",
      credits: "@ana, bo\n\ncy",
      package: "@flagon/hello",
      affectedVersions: ">= 1.2.0, < 1.4.1",
    }),
  );
  assert.ok(typeof input !== "string");
  assert.equal(input.title, "Path traversal in the archive reader");
  assert.equal(input.cveId, "CVE-2026-12345");
  assert.equal(input.cvssScore, 8.1);
  assert.deepEqual(input.credits, ["ana", "bo", "cy"]);
  assert.equal(input.ecosystem, null);
  assert.equal(advisoryFromForm(form({ title: " ", severity: "high" })), "Give the advisory a title.");
  assert.equal(advisoryFromForm(form({ title: "x", severity: "severe" })), "Choose a severity.");
  assert.equal(advisoryFromForm(form({ title: "x", severity: "low", cvssScore: "11" })), "A CVSS score is 0 to 10.");
  assert.equal(advisoryFromForm(form({ title: "x", severity: "low", cveId: "CVE-1" })), "A CVE id looks like CVE-2026-12345.");
});

test("a report needs a title and a description, and an email when signed out", () => {
  const signedIn = reportFromForm(form({ title: "XSS in the search box", description: "Type <script> into…", severity: "medium" }), true);
  assert.ok(typeof signedIn !== "string");
  assert.equal(signedIn.severity, "medium");
  assert.equal(signedIn.email, null);
  assert.equal(reportFromForm(form({ title: "XSS", description: "…" }), false), "Give an email address the maintainers can answer at, or sign in.");
  assert.equal(reportFromForm(form({ title: "XSS", description: "…", email: "not an address" }), false), "Give an email address the maintainers can answer at, or sign in.");
  const signedOut = reportFromForm(form({ title: "XSS", description: "…", email: "finder@example.com", severity: "nope" }), false);
  assert.ok(typeof signedOut !== "string");
  assert.equal(signedOut.email, "finder@example.com");
  assert.equal(signedOut.severity, null);
  assert.equal(reportFromForm(form({ title: "", description: "…" }), true), "Give the report a title: one line on what you found.");
  assert.equal(reportFromForm(form({ title: "x", description: " " }), true), "Describe the vulnerability: what is affected and how to reproduce it.");
});

test("states and severities parse only to what is known", () => {
  assert.equal(parseSeverity("critical"), "critical");
  assert.equal(parseSeverity("severe"), null);
  assert.equal(parseAdvisoryState("withdrawn"), "withdrawn");
  assert.equal(parseAdvisoryState("gone"), null);
  assert.equal(parseReportState("new"), "new");
  assert.deepEqual(advisoryStanding({ state: "draft", createdBy: "ana" }), { verb: "Drafted by ana", at: null });
  assert.deepEqual(advisoryStanding({ state: "published", createdBy: "ana", publishedAt: "2026-10-07T15:02:40.000Z" }), { verb: "Published", at: "2026-10-07T15:02:40.000Z" });
  assert.deepEqual(advisoryStanding({ state: "withdrawn", createdBy: "ana", withdrawnAt: "2026-10-08T00:00:00.000Z" }), { verb: "Withdrawn", at: "2026-10-08T00:00:00.000Z" });
});
