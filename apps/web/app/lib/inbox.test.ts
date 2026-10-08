import assert from "node:assert/strict";
import { test } from "node:test";

import type { InboxItem } from "@g1t/contracts";

import {
  EMAIL_REASONS,
  REASON_FILTERS,
  REASON_LABEL,
  bellCount,
  emailReasonsFromForm,
  emptyFor,
  inboxReason,
  inboxTab,
  inboxView,
  markFromForm,
  needsYou,
  severityOf,
  snoozeUntil,
  subscriptionFromForm,
  subscriptionLine,
  tabCount,
  updatesLabel,
  watchFromForm,
  watchLabel,
  whenShort,
} from "./inbox.ts";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");

test("tabs read from the address, and each shows one severity", () => {
  assert.equal(inboxTab("needs"), "needs");
  assert.equal(inboxTab("nonsense"), "all");
  assert.equal(inboxTab(null), "all");
  assert.equal(severityOf("needs"), "warning");
  assert.equal(severityOf("all"), null);
  assert.equal(inboxView("done"), "done");
  assert.equal(inboxView("archive"), "inbox");
});

test("counts are what is unread under each tab", () => {
  const counts = { unread: 15, error: 3, warning: 0, success: 8, info: 4 };
  assert.equal(tabCount(counts, "all"), 15);
  assert.equal(tabCount(counts, "error"), 3);
  assert.equal(tabCount(counts, "needs"), 0);
  assert.equal(tabCount(null, "all"), 0);
});

test("the bell shows a number up to 99", () => {
  assert.equal(bellCount(0), "");
  assert.equal(bellCount(null), "");
  assert.equal(bellCount(7), "7");
  assert.equal(bellCount(140), "99+");
});

test("times are said in a few characters", () => {
  assert.equal(whenShort("2026-10-07T11:59:30.000Z", NOW), "just now");
  assert.equal(whenShort("2026-10-07T11:45:00.000Z", NOW), "15m ago");
  assert.equal(whenShort("2026-10-07T09:00:00.000Z", NOW), "3h ago");
  assert.equal(whenShort("2026-10-06T09:00:00.000Z", NOW), "Yesterday");
  assert.equal(whenShort("2026-10-03T12:00:00.000Z", NOW), "4d ago");
  assert.equal(whenShort("2026-09-20T12:00:00.000Z", NOW), "Sep 20");
});

test("a snooze is for later, by one of a few choices", () => {
  assert.equal(snoozeUntil("3h", NOW), "2026-10-07T15:00:00.000Z");
  assert.equal(snoozeUntil("week", NOW), "2026-10-14T12:00:00.000Z");
  assert.equal(snoozeUntil("forever", NOW), null);
});

test("forms ask for one mark on one item, or read for every item", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) data.set(name, value);
    return data;
  };
  assert.deepEqual(markFromForm(form({ intent: "done", id: "ntf_1" }), NOW), { mark: "done", ids: ["ntf_1"] });
  assert.deepEqual(markFromForm(form({ intent: "snooze", id: "ntf_1", for: "tomorrow" }), NOW), {
    mark: "snooze",
    ids: ["ntf_1"],
    until: "2026-10-08T12:00:00.000Z",
  });
  assert.deepEqual(markFromForm(form({ intent: "read_all", tab: "error" }), NOW), { mark: "read", all: true, severity: "error" });
  assert.deepEqual(markFromForm(form({ intent: "read_all" }), NOW), { mark: "read", all: true, severity: null });
  assert.equal(markFromForm(form({ intent: "snooze", id: "ntf_1", for: "never" }), NOW), null);
  assert.equal(markFromForm(form({ intent: "delete", id: "ntf_1" }), NOW), null);
  assert.equal(markFromForm(form({ intent: "done" }), NOW), null);
});

test("what needs you puts a waiting agent before a failure, and leaves out the rest", () => {
  const item = (id: string, severity: InboxItem["severity"], createdAt: string, readAt: string | null = null): InboxItem => ({
    id,
    reason: "agent",
    severity,
    title: id,
    body: "",
    repo: "acme/rocket",
    workspace: "acme",
    subject: "pull",
    number: 1,
    url: "/acme/rocket/pull/1",
    actor: null,
    createdAt,
    updatedAt: createdAt,
    event: null,
    count: 1,
    readAt,
    doneAt: null,
    saved: false,
    snoozedUntil: null,
  });
  const needs = needsYou(
    [
      item("failed-new", "error", "2026-10-07T11:00:00.000Z"),
      item("waiting-old", "warning", "2026-10-06T11:00:00.000Z"),
      item("waiting-new", "warning", "2026-10-07T10:00:00.000Z"),
      item("merged", "success", "2026-10-07T11:30:00.000Z"),
      item("failed-read", "error", "2026-10-07T11:40:00.000Z", "2026-10-07T11:50:00.000Z"),
    ],
    2,
  );
  assert.deepEqual(
    needs.items.map((entry) => entry.id),
    ["waiting-new", "waiting-old"],
  );
  assert.equal(needs.total, 3);
});

test("every tab says something when it is empty", () => {
  assert.equal(emptyFor("all").title, "You're all caught up");
  assert.equal(emptyFor("needs").title, "Nothing needs you");
  assert.equal(emptyFor("all", "saved").title, "Nothing saved");
});

test("every reason has words, a filter and an email choice", () => {
  const reasons = Object.keys(REASON_LABEL);
  assert.equal(reasons.length, 12);
  assert.deepEqual(REASON_FILTERS.slice(1).map((entry) => entry.reason), reasons);
  assert.equal(REASON_FILTERS[0].label, "Any reason");
  assert.equal(REASON_FILTERS.find((entry) => entry.reason === "review_requested")?.label, "Review requested");
  // Every reason someone can be told for can be emailed, but a security
  // alert, which nothing sends yet.
  assert.deepEqual(
    EMAIL_REASONS.map((entry) => entry.reason).sort(),
    reasons.filter((reason) => reason !== "security_alert").sort(),
  );
  assert.equal(inboxReason("mention"), "mention");
  assert.equal(inboxReason("gossip"), null);
  assert.equal(inboxReason(null), null);
});

test("a thread says how much happened on it once more than one thing has", () => {
  assert.equal(updatesLabel(1), "");
  assert.equal(updatesLabel(null), "");
  assert.equal(updatesLabel(4), "4 updates");
});

test("watching is read from the menu, and a custom watch of nothing is the default", () => {
  const form = (fields: [string, string][]) => {
    const data = new FormData();
    for (const [name, value] of fields) data.append(name, value);
    return data;
  };
  assert.deepEqual(watchFromForm(form([["level", "all"]])), { level: "all", events: [] });
  assert.deepEqual(watchFromForm(form([["level", "custom"], ["event", "deployments"], ["event", "pulls"], ["event", "releases"]])), {
    level: "custom",
    events: ["pulls", "deployments"],
  });
  assert.deepEqual(watchFromForm(form([["level", "custom"]])), { level: "participating", events: [] });
  assert.equal(watchFromForm(form([["level", "loud"]])), null);
  assert.equal(watchLabel("all"), "Watching");
  assert.equal(watchLabel("ignore"), "Ignoring");
  assert.equal(watchLabel("participating"), "Watch");
});

test("the subscribe button says whether, and why", () => {
  const sub = (changes: object) => ({ subscribed: true, ignored: false, reason: null, repo: null, number: 7, updatedAt: null, ...changes });
  assert.equal(subscriptionLine(sub({ reason: "assign" }), "issue"), "You're subscribed because you were assigned.");
  assert.equal(subscriptionLine(sub({ reason: "author" }), "pull"), "You're subscribed because you opened this pull request, or asked g1t for it.");
  assert.match(subscriptionLine(sub({ subscribed: false }), "issue"), /still hear if you're mentioned/);
  assert.match(subscriptionLine(sub({ subscribed: false, ignored: true }), "issue"), /ignore this issue/);
  assert.match(subscriptionLine(null, "issue"), /^Subscribe/);
  const intent = (value: string) => {
    const data = new FormData();
    data.set("intent", value);
    return subscriptionFromForm(data);
  };
  assert.deepEqual(intent("subscribe"), { subscribed: true, ignored: false });
  assert.deepEqual(intent("unsubscribe"), { subscribed: false, ignored: false });
  assert.deepEqual(intent("ignore"), { subscribed: false, ignored: true });
  assert.deepEqual(intent("default"), { subscribed: null, ignored: false });
  assert.equal(intent("explode"), null);
});

test("email reasons are read from the settings form in rank order", () => {
  const data = new FormData();
  for (const value of ["mention", "nope", "agent", "mention"]) data.append("email", value);
  assert.deepEqual(emailReasonsFromForm(data), ["agent", "mention"]);
  assert.deepEqual(emailReasonsFromForm(new FormData()), []);
});
