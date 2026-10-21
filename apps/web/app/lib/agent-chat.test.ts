import assert from "node:assert/strict";
import { test } from "node:test";

import { ASKED_SEPARATOR, NO_REPO, askedPart, continuation, lastRepoKey, mostUsedRepo, pickerRepos, startingRepo } from "./agent-chat.ts";

const repos = ["acme/web", "acme/api", "acme/docs"];

test("the most used repository is the one most recent sessions ran in, a tie going to the latest", () => {
  assert.equal(mostUsedRepo([{ repo: "acme/api" }, { repo: "acme/web" }, { repo: "acme/web" }], repos), "acme/web");
  assert.equal(mostUsedRepo([{ repo: "acme/api" }, { repo: "acme/web" }], repos), "acme/api", "a tie: the newest first");
  assert.equal(mostUsedRepo([{ repo: "ACME/Docs" }], repos), "acme/docs", "names compare without case, and come back as listed");
  assert.equal(mostUsedRepo([{ repo: "other/secret" }], repos), null, "only repositories the viewer may read");
  assert.equal(mostUsedRepo([], repos), null);
});

test("New starts as a conversation with g1t, unless the last one here started work in a repository", () => {
  assert.equal(startingRepo({ repos }), NO_REPO);
  assert.equal(startingRepo({ repos, remembered: NO_REPO }), NO_REPO);
  assert.equal(startingRepo({ repos, remembered: "ACME/docs" }), "acme/docs");
  assert.equal(startingRepo({ repos, remembered: "gone/repo" }), NO_REPO, "a repository no longer readable is not started in");
  assert.equal(lastRepoKey("Acme"), "g1t:agent-repo:acme");
});

test("the picker lists the page's repository, then the most used, then the rest", () => {
  const page = { path: "/acme/docs/pull/3", repo: { namespace: "acme", name: "docs" }, pull: 3 };
  assert.deepEqual(pickerRepos({ repos, page, suggested: "acme/api" }), ["acme/docs", "acme/api", "acme/web"]);
  assert.deepEqual(pickerRepos({ repos, suggested: "acme/api" }), ["acme/api", "acme/web", "acme/docs"]);
  assert.deepEqual(pickerRepos({ repos, suggested: "gone/x" }), repos);
});

test("a session's first message shows what was asked, apart from what g1t added", () => {
  assert.deepEqual(askedPart(`Why is CI slow?${ASKED_SEPARATOR}This was asked from Chat…`), { asked: "Why is CI slow?", added: "This was asked from Chat…" });
  assert.deepEqual(askedPart("Work on work item #4 of the acme workspace"), { asked: "Work on work item #4 of the acme workspace", added: null });
  assert.deepEqual(askedPart(`${ASKED_SEPARATOR}only g1t's`), { asked: `${ASKED_SEPARATOR}only g1t's`.trim(), added: null });
});

test("a follow-up to an ended session asks a new one to carry on from it", () => {
  const session = { id: "ses_1", title: "Speed up CI", branch: "ci-cache", result: "Cached the npm install.", item: null };
  const next = continuation({
    text: " Now cache cargo too ",
    session,
    links: [
      { kind: "pull", number: 8 },
      { kind: "item", number: 2 },
    ],
    url: "https://g1t.sh/acme/-/chat/sessions/ses_1",
  });
  assert.equal(next.prompt, "Now cache cargo too", "the follow-up is what was asked, as written");
  assert.equal(next.item, undefined);
  assert.match(next.instruction, /carries on from g1t session ses_1 \(“Speed up CI”\), which has ended: https:\/\/g1t\.sh\/acme\/-\/chat\/sessions\/ses_1/);
  assert.match(next.instruction, /branch `ci-cache`/);
  assert.match(next.instruction, /Its pull requests: #8\./);
  assert.match(next.instruction, /<previous_report>\nCached the npm install\.\n<\/previous_report>/);
  // On a work item, it carries on on the work item, the follow-up first.
  const onItem = continuation({ text: "And the docs", session: { ...session, item: 4, result: "x".repeat(10_000) }, links: [], url: "u" });
  assert.equal(onItem.item, 4);
  assert.equal(onItem.prompt, undefined);
  assert.ok(onItem.instruction.startsWith("And the docs\n\n"));
  assert.ok(onItem.instruction.length <= 4000, "within what an instruction may be");
});
