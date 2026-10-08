import assert from "node:assert/strict";
import { test } from "node:test";

import type { Environment } from "@g1t/contracts";

import { environmentFromForm, environmentName, environmentSummary, waitWords } from "./environments.ts";

const limits = { reviewers: 6, waitMinutes: 43_200 };

function form(entries: [string, string][]): FormData {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

const base: Environment = {
  name: "production",
  reviewers: [],
  preventSelfReview: false,
  waitMinutes: 0,
  branchPolicy: "all",
  branchPatterns: [],
  adminsBypass: true,
  protected: true,
  updatedAt: null,
  updatedBy: null,
};

test("an environment's name is lowercased, and anything else is refused", () => {
  assert.equal(environmentName(" Production "), "production");
  assert.equal(environmentName("eu-west_2"), "eu-west_2");
  assert.equal(environmentName("prod env"), null);
  assert.equal(environmentName("a".repeat(41)), null);
  assert.equal(environmentName(""), null);
});

test("a form's rules: reviewers in order without blanks or repeats, patterns only for selected branches", () => {
  const read = environmentFromForm(
    form([
      ["reviewerType", "user"],
      ["reviewerName", "@alice"],
      ["reviewerType", "team"],
      ["reviewerName", "platform"],
      ["reviewerType", "user"],
      ["reviewerName", " "],
      ["reviewerType", "user"],
      ["reviewerName", "Alice"],
      ["preventSelfReview", "on"],
      ["waitMinutes", "30"],
      ["branchPolicy", "selected"],
      ["patternType", "branch"],
      ["patternName", "release/*"],
      ["patternType", "tag"],
      ["patternName", "v*"],
      ["patternType", "branch"],
      ["patternName", ""],
    ]),
    limits,
  );
  assert.deepEqual(read, {
    change: {
      reviewers: [
        { type: "user", name: "alice" },
        { type: "team", name: "platform" },
      ],
      preventSelfReview: true,
      waitMinutes: 30,
      branchPolicy: "selected",
      branchPatterns: [
        { name: "release/*", type: "branch" },
        { name: "v*", type: "tag" },
      ],
      adminsBypass: false,
    },
  });

  const all = environmentFromForm(form([["branchPolicy", "all"], ["patternName", "main"], ["adminsBypass", "on"]]), limits);
  assert.ok("change" in all);
  assert.deepEqual(all.change.branchPatterns, []);
  assert.equal(all.change.adminsBypass, true);
  assert.equal(all.change.waitMinutes, 0);
});

test("a form past the limits says what is wrong", () => {
  const many = form(Array.from({ length: 7 }, (_, i) => [["reviewerType", "user"], ["reviewerName", `u${i}`]] as [string, string][]).flat());
  assert.deepEqual(environmentFromForm(many, limits), { error: "An environment can have up to 6 reviewers." });
  assert.ok("error" in environmentFromForm(form([["waitMinutes", "43201"]]), limits));
  assert.ok("error" in environmentFromForm(form([["waitMinutes", "-1"]]), limits));
  assert.ok("error" in environmentFromForm(form([["branchPolicy", "selected"]]), limits));
});

test("an environment's rules in a few words", () => {
  assert.deepEqual(environmentSummary({ ...base, protected: false }), []);
  assert.deepEqual(environmentSummary(base), ["No reviewers, wait timer or branch limits"]);
  assert.deepEqual(
    environmentSummary({
      ...base,
      reviewers: [
        { type: "user", name: "alice" },
        { type: "team", name: "platform" },
      ],
      waitMinutes: 90,
      branchPolicy: "protected",
    }),
    ["Reviewers: alice, @platform", "Wait 1h 30m", "Protected branches only"],
  );
  assert.deepEqual(
    environmentSummary({
      ...base,
      reviewers: [
        { type: "user", name: "a" },
        { type: "user", name: "b" },
        { type: "user", name: "c" },
      ],
      branchPolicy: "selected",
      branchPatterns: [{ name: "main", type: "branch" }],
    }),
    ["3 reviewers", "1 branch and tag pattern"],
  );
  assert.equal(waitWords(1440 + 60), "1d 1h");
  assert.equal(waitWords(43_200), "30d");
});
