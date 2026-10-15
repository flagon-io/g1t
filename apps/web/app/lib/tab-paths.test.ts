import assert from "node:assert/strict";
import { test } from "node:test";

import {
  branchSegment,
  branchesPath,
  movedTab,
  movedView,
  notificationView,
  notificationViewAt,
  notificationsAddress,
  notificationsPath,
  profilePath,
  profileTab,
  pullPath,
  pullTab,
  rulesAt,
  rulesPath,
} from "./tab-paths.ts";

const at = (address: string) => new URL(address, "https://g1t.sh");

test("a profile's tabs are paths, and its overview is the profile", () => {
  assert.equal(profilePath("ada"), "/u/ada");
  assert.equal(profilePath("ada", "overview"), "/u/ada");
  assert.equal(profilePath("ada", "pulls"), "/u/ada/pulls");
  assert.equal(profilePath("ada", "issues"), "/u/ada/issues");
  assert.equal(profilePath("ada", "stars"), "/u/ada/stars");
  // A tab it never had (GitHub's repositories) is the overview.
  assert.equal(profilePath("ada", "repositories"), "/u/ada");
  assert.equal(profileTab(undefined), "overview");
  assert.equal(profileTab("pulls"), "pulls");
  assert.equal(profileTab("Stars"), "stars");
  // The overview has one address; anything else is no page.
  assert.equal(profileTab("overview"), null);
  assert.equal(profileTab("repositories"), null);
});

test("an old profile address with ?tab= goes to the tab's path, keeping its filters", () => {
  const to = (address: string) => movedTab(at(address), (tab) => profilePath("ada", tab));
  assert.equal(to("/u/ada?tab=pulls"), "/u/ada/pulls");
  assert.equal(to("/u/ada?tab=pulls&state=merged"), "/u/ada/pulls?state=merged");
  assert.equal(to("/u/ada?state=open&tab=issues&repo=acme%2Fweb&sort=oldest"), "/u/ada/issues?state=open&repo=acme%2Fweb&sort=oldest");
  assert.equal(to("/u/ada?tab=STARS"), "/u/ada/stars");
  assert.equal(to("/u/ada?tab=overview"), "/u/ada");
  assert.equal(to("/u/ada?tab=repositories"), "/u/ada");
  // A click's data request: `_routes` is the router's, not the page's.
  assert.equal(to("/u/ada.data?tab=pulls&_routes=root,routes/user"), "/u/ada/pulls");
  // No ?tab=: nothing moved.
  assert.equal(to("/u/ada/pulls?state=open"), null);
  assert.equal(to("/u/ada"), null);
});

test("a pull request's tabs are /session and /files", () => {
  assert.equal(pullPath("/acme/web", 12), "/acme/web/pull/12");
  assert.equal(pullPath("/acme/web", 12, "conversation"), "/acme/web/pull/12");
  assert.equal(pullPath("/acme/web", 12, "session"), "/acme/web/pull/12/session");
  assert.equal(pullPath("/acme/web", 12, "changes"), "/acme/web/pull/12/files");
  assert.equal(pullPath("/acme/web", "12", "files"), "/acme/web/pull/12/files");
  assert.equal(pullPath("/acme/web", 12, "commits"), "/acme/web/pull/12");
  assert.equal(pullTab(undefined), "conversation");
  assert.equal(pullTab("files"), "changes");
  assert.equal(pullTab("session"), "session");
  assert.equal(pullTab("Files"), "changes");
  assert.equal(pullTab("changes"), null);
  assert.equal(pullTab("conversation"), null);
  assert.equal(pullTab("commits"), null);
});

test("an old pull request address with ?tab= goes to the tab's path, keeping the rest", () => {
  const to = (address: string) => movedTab(at(address), (tab) => pullPath("/acme/web", "12", tab));
  assert.equal(to("/acme/web/pull/12?tab=changes"), "/acme/web/pull/12/files");
  assert.equal(to("/acme/web/pull/12?tab=session"), "/acme/web/pull/12/session");
  assert.equal(to("/acme/web/pull/12?tab=conversation"), "/acme/web/pull/12");
  assert.equal(to("/acme/web/pull/12?tab=files"), "/acme/web/pull/12/files");
  assert.equal(to("/acme/web/pull/12?tab=changes&w=1"), "/acme/web/pull/12/files?w=1");
  assert.equal(to("/acme/web/pull/12"), null);
});

test("the Branches page's tabs are paths", () => {
  assert.equal(branchesPath("/acme/web"), "/acme/web/branches");
  assert.equal(branchesPath("/acme/web", "stale"), "/acme/web/branches/stale");
  assert.equal(branchesPath("/acme/web", "nope"), "/acme/web/branches");
  assert.equal(branchSegment(undefined), "overview");
  assert.equal(branchSegment("yours"), "yours");
  assert.equal(branchSegment("overview"), null);
  assert.equal(branchSegment("main"), null);
  const to = (address: string) => movedTab(at(address), (tab) => branchesPath("/acme/web", tab));
  assert.equal(to("/acme/web/branches?tab=stale&q=fix"), "/acme/web/branches/stale?q=fix");
  assert.equal(to("/acme/web/branches?tab=overview"), "/acme/web/branches");
});

test("rules' Insights is a path, for a repository and a workspace", () => {
  assert.equal(rulesPath("/acme/web/settings/rules"), "/acme/web/settings/rules");
  assert.equal(rulesPath("/acme/web/settings/rules", "insights"), "/acme/web/settings/rules/insights");
  assert.equal(rulesPath("/acme/-/rules", "insights"), "/acme/-/rules/insights");
  assert.equal(rulesAt("/acme/web/settings/rules/insights"), "insights");
  assert.equal(rulesAt("/acme/web/settings/rules/insights.data"), "insights");
  assert.equal(rulesAt("/acme/-/rules/insights"), "insights");
  assert.equal(rulesAt("/acme/web/settings/rules"), "rulesets");
  assert.equal(rulesAt("/acme/web/settings/rules.data"), "rulesets");
  const to = (address: string) => movedTab(at(address), (tab) => rulesPath("/acme/web/settings/rules", tab));
  assert.equal(to("/acme/web/settings/rules?tab=insights&before=abc"), "/acme/web/settings/rules/insights?before=abc");
  assert.equal(to("/acme/web/settings/rules?tab=rulesets&branch=main"), "/acme/web/settings/rules?branch=main");
});

test("notifications' Saved and Done are paths; the severity tabs and reasons narrow them", () => {
  assert.equal(notificationsPath(), "/notifications");
  assert.equal(notificationsPath("saved"), "/notifications/saved");
  assert.equal(notificationsPath("done"), "/notifications/done");
  assert.equal(notificationsPath("nope"), "/notifications");
  assert.equal(notificationView(undefined), "inbox");
  assert.equal(notificationView("done"), "done");
  assert.equal(notificationView("inbox"), null);
  assert.equal(notificationViewAt("/notifications/saved"), "saved");
  assert.equal(notificationViewAt("/notifications"), "inbox");
  assert.equal(notificationsAddress({ view: "done", tab: "needs", reason: "mention" }), "/notifications/done?tab=needs&reason=mention");
  assert.equal(notificationsAddress({ view: "inbox", tab: "all", reason: null, before: null }), "/notifications");
  assert.equal(notificationsAddress({ view: null, before: "c1" }), "/notifications?before=c1");
  assert.equal(movedView(at("/notifications?view=done&reason=mention")), "/notifications/done?reason=mention");
  assert.equal(movedView(at("/notifications?view=inbox&tab=needs")), "/notifications?tab=needs");
  assert.equal(movedView(at("/notifications?tab=needs")), null);
});
