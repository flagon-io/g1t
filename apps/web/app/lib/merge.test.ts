import assert from "node:assert/strict";
import { test } from "node:test";

import type { RepoSettings } from "@g1t/contracts";

import {
  type PullCommit,
  type TemplatePull,
  SAMPLE_PULL,
  allowedMethods,
  choicesFromSettings,
  defaultMessage,
  fillTemplate,
  isMergeMethod,
  splitMessage,
} from "./merge.ts";

// The same inputs as services/work/src/merge_message.rs's tests, which must
// give the same outputs: the settings preview and the server agree.

const commit = (message: string, email: string): PullCommit => ({ message, authorEmail: email });

const facts = (commits: PullCommit[] = [], items: number[] = []): TemplatePull => ({
  number: 12,
  title: "Add forks ",
  body: "Forks are ordinary repositories.\n",
  branch: "forks",
  headOwner: "ana",
  headRepo: "ana/g1t",
  base: "main",
  author: "ana",
  commits,
  items,
});

const asPair = (text: { title: string; message: string }) => [text.title, text.message];

test("a merge commit names where it came from by default", () => {
  assert.deepEqual(asPair(defaultMessage("merge", "default", null, facts())), ["Merge pull request #12 from ana/forks", "Add forks"]);
  assert.deepEqual(asPair(defaultMessage("merge", "pull_title", null, facts())), ["Add forks (#12)", ""]);
  assert.deepEqual(asPair(defaultMessage("merge", "pull_title_and_description", null, facts())), ["Add forks (#12)", "Forks are ordinary repositories."]);
  // Listing commits is for squashes: a merge falls back to its default.
  assert.deepEqual(defaultMessage("merge", "pull_title_and_commits", null, facts()), defaultMessage("merge", "default", null, facts()));
});

test("a squash lists its commits when it has more than one", () => {
  const one = [commit("Add forks\n\nLong story.", "ana@example.com")];
  assert.deepEqual(asPair(defaultMessage("squash", "default", null, facts(one))), ["Add forks (#12)", ""]);
  const two = [commit("Add forks\n\nLong story.", "ana@example.com"), commit("Fix the test", "bo@example.com")];
  assert.deepEqual(asPair(defaultMessage("squash", "default", null, facts(two))), ["Add forks (#12)", "* Add forks\n* Fix the test"]);
  assert.deepEqual(asPair(defaultMessage("squash", "pull_title_and_commits", null, facts(two))), [
    "Add forks (#12)",
    "Add forks\n\nLong story.\n\nFix the test",
  ]);
  assert.equal(defaultMessage("squash", "pull_title_and_description", null, facts(two)).message, "Forks are ordinary repositories.");
});

test("a template is filled in once", () => {
  const commits = [commit("One", "ana@example.com"), commit("Two", "Ana@Example.com"), commit("Three", "bo@example.com")];
  const template =
    "{title} (#{number}) into {base}\n\n{body}\nFrom {head_repo}:{branch} by {author}\n{commits}\nCloses {items}\n{co_authors}\n{unknown} {title";
  const { title, message } = defaultMessage("squash", "custom", template, facts(commits, [3, 4]));
  assert.equal(title, "Add forks (#12) into main");
  assert.equal(
    message,
    "Forks are ordinary repositories.\nFrom ana/g1t:forks by ana\n* One\n* Two\n* Three\nCloses #3, #4\nCo-authored-by: ana <ana@example.com>\nCo-authored-by: bo <bo@example.com>\n{unknown} {title",
  );
  // A value holding a placeholder is not filled in again.
  assert.equal(defaultMessage("merge", "custom", "{title}", { ...facts(), title: "{body}" }).title, "{body}");
  // A template that fills in nothing falls back to the default.
  assert.equal(defaultMessage("merge", "custom", "{body}", { ...facts(), body: "" }).title, "Merge pull request #12 from ana/forks");
  assert.deepEqual(defaultMessage("squash", "custom", "  ", facts()), defaultMessage("squash", "default", null, facts()));
  assert.deepEqual(defaultMessage("squash", "custom", null, facts()), defaultMessage("squash", "default", null, facts()));
});

test("a message splits into title and body", () => {
  assert.deepEqual(asPair(splitMessage("Title\n\n\nBody\n")), ["Title", "Body"]);
  assert.deepEqual(asPair(splitMessage(" Title ")), ["Title", ""]);
});

test("the sample pull request previews as the server writes it", () => {
  assert.deepEqual(asPair(defaultMessage("merge", "default", null, SAMPLE_PULL)), [
    "Merge pull request #128 from acme/webhook-retries",
    "Retry failed webhook deliveries",
  ]);
  const filled = fillTemplate("{title} (#{number})\n\n{body}\n\nCloses {items}\n{co_authors}\n{nope}", SAMPLE_PULL);
  assert.equal(filled.title, "Retry failed webhook deliveries (#128)");
  assert.equal(
    filled.message,
    "Deliveries that time out are retried three times, with backoff.\n\nCloses #97\nCo-authored-by: ana <ana@example.com>\nCo-authored-by: ben <ben@example.com>\n{nope}",
  );
});

test("choices from settings leave the message to the service", () => {
  const settings = {
    allowMergeCommit: true,
    allowSquashMerge: true,
    allowRebaseMerge: false,
    allowFastForward: false,
    defaultMergeMethod: "squash",
    allowAutoMerge: false,
    deleteBranchOnMerge: false,
    suggestUpdatingBranches: true,
  } as unknown as RepoSettings;
  const choices = choicesFromSettings(settings, false);
  assert.deepEqual(choices.methods, ["merge", "squash"]);
  assert.equal(choices.defaultMethod, "squash");
  assert.deepEqual(choices.messages, {});
});

test("the allowed methods follow the settings, fast-forward included", () => {
  assert.deepEqual(allowedMethods({ allowMergeCommit: false, allowSquashMerge: true, allowRebaseMerge: false, allowFastForward: true }), [
    "squash",
    "fast_forward",
  ]);
  assert.ok(isMergeMethod("fast_forward"));
  assert.ok(!isMergeMethod("octopus"));
});
