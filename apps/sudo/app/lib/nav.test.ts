import assert from "node:assert/strict";
import { test } from "node:test";

import { NAV, countFor, holdsCurrent, isCurrent, navItems, soonFor, soonItems } from "./nav.ts";

test("the sidebar: two top-level links, then sections that fold", () => {
  assert.deepEqual(
    NAV.map((group) => group.title),
    [null, "Customers", "Spend", "Revenue", "Platform", "Support", "Team"],
  );
  assert.deepEqual(NAV[0].items.map((item) => item.to), ["/", "/reach-out"]);
});

test("no section holds a single page, and every section has an icon", () => {
  for (const group of NAV.filter((group) => group.title)) {
    assert.ok(group.items.length >= 2, `${group.title} has more than one page`);
    assert.ok(group.icon, `${group.title} has an icon`);
  }
});

test("the section holding the current page is the one drawn open", () => {
  const open = (path: string) => NAV.filter((group) => group.title && holdsCurrent(group, path)).map((group) => group.title);
  assert.deepEqual(open("/workspaces/acme"), ["Customers"]);
  assert.deepEqual(open("/stripe"), ["Platform"]);
  assert.deepEqual(open("/overages"), ["Spend"]);
  assert.deepEqual(open("/audit"), ["Team"]);
  assert.deepEqual(open("/"), []);
  assert.deepEqual(open("/reach-out"), []);
});

test("every item has its own path, a label and a line about it", () => {
  const paths = navItems().map((item) => item.to);
  assert.equal(new Set(paths).size, paths.length);
  for (const item of navItems()) {
    assert.match(item.to, /^\/[a-z-]*$/, item.label);
    assert.ok(item.label.length > 0);
    assert.ok(item.about.length > 10, `${item.label} says what it is`);
  }
});

test("the built pages are not marked soon", () => {
  const built = navItems().filter((item) => !item.soon).map((item) => item.to);
  assert.deepEqual(built, ["/", "/reach-out", "/workspaces", "/enterprises", "/invites", "/requests", "/overages", "/velocity", "/invoices", "/stripe", "/abuse", "/incidents", "/audit"]);
});

test("every soon page says what it will do, why, and what it will have", () => {
  const soon = soonItems();
  assert.ok(soon.length >= 9);
  for (const item of soon) {
    assert.ok(item.soon.summary.length >= 1 && item.soon.summary.length <= 4, item.label);
    assert.ok(item.soon.plans.length >= 3 && item.soon.plans.length <= 6, item.label);
    if (item.soon.meanwhile?.to) assert.match(item.soon.meanwhile.to, /^\//);
  }
});

test("view as customer promises an audit and a time limit", () => {
  const page = soonFor("/view-as");
  assert.ok(page);
  const words = page.soon.summary.join(" ");
  assert.match(words, /audited/);
  assert.match(words, /time-limited/);
});

test("soonFor finds a placeholder by its path, and nothing else", () => {
  assert.equal(soonFor("/prices")?.label, "Plans & prices");
  assert.equal(soonFor("/prices/")?.label, "Plans & prices");
  assert.equal(soonFor("/invoices"), null);
  assert.equal(soonFor("/workspaces"), null);
  assert.equal(soonFor("/nope"), null);
});

test("isCurrent: an item stays lit on the pages beneath it; / only on itself", () => {
  const overview = { to: "/" };
  const workspaces = { to: "/workspaces" };
  assert.ok(isCurrent(overview, "/"));
  assert.ok(!isCurrent(overview, "/workspaces"));
  assert.ok(isCurrent(workspaces, "/workspaces"));
  assert.ok(isCurrent(workspaces, "/workspaces/acme"));
  assert.ok(isCurrent(workspaces, "/workspaces/"));
  assert.ok(!isCurrent(workspaces, "/workspaces-old"));
  assert.ok(isCurrent({ to: "/x", also: ["/y"] }, "/y/z"));
});

test("requests waiting show beside Invites, and on Customers while it is folded", () => {
  const invites = navItems().find((item) => item.to === "/invites")!;
  assert.equal(invites.count, "waitlist");
  assert.equal(countFor([invites], { waitlist: 4 }), 4);
  assert.equal(countFor([invites], {}), 0);
  const customers = NAV.find((group) => group.title === "Customers")!;
  assert.equal(countFor(customers.items, { waitlist: 4 }), 4);
  assert.equal(countFor(NAV.find((group) => group.title === "Team")!.items, { waitlist: 4 }), 0);
});
