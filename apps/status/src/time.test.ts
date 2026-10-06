import assert from "node:assert/strict";
import { test } from "node:test";

import type { StatusIncident } from "@g1t/contracts";

import { renderIncident } from "./render.ts";
import { readZone, stampIn, timeIn, validZone, zoneAbbr } from "./time.ts";

const AT = "2026-10-06T07:25:00.000Z";

test("the reader's zone: their cookie, else Cloudflare's guess, else UTC", () => {
  assert.equal(readZone(null, "America/Los_Angeles"), "America/Los_Angeles");
  assert.equal(readZone("a=1; g1t_tz=Europe%2FBerlin", "America/Los_Angeles"), "Europe/Berlin");
  assert.equal(readZone("g1t_tz=Not%2FA_Zone", "Asia/Tokyo"), "Asia/Tokyo");
  assert.equal(readZone(null, undefined), "UTC");
  assert.equal(readZone(null, "nonsense"), "UTC");
  assert.equal(validZone("UTC"), true);
  assert.equal(validZone(42), false);
});

test("times carry their zone's abbreviation", () => {
  const d = new Date(AT);
  assert.equal(zoneAbbr(d, "UTC"), "UTC");
  assert.equal(zoneAbbr(d, "America/Los_Angeles"), "PDT");
  assert.equal(zoneAbbr(d, "Europe/Berlin"), "CEST");
  assert.equal(zoneAbbr(d, "Europe/London"), "BST");
  assert.equal(zoneAbbr(d, "Asia/Tokyo"), "UTC+9");
  assert.equal(timeIn(AT, "UTC"), "6 Oct 2026, 07:25 UTC");
  assert.equal(timeIn(AT, "America/Los_Angeles"), "6 Oct 2026, 00:25 PDT");
  assert.equal(timeIn("2026-10-06T03:13:32.776Z", "America/Los_Angeles"), "5 Oct 2026, 20:13 PDT");
  assert.equal(stampIn(AT, "Asia/Kolkata"), "6 Oct 12:55 UTC+5:30");
});

test("the status page says times in the reader's zone, with UTC in datetime and on hover", () => {
  const incident: StatusIncident = {
    id: "abc",
    title: "Pushes failing",
    impact: "down",
    status: "resolved",
    components: ["git"],
    component_impacts: [{ key: "git", impact: "major_outage" }],
    started_at: AT,
    resolved_at: "2026-10-06T08:00:00.000Z",
    url: "https://status.g1t.sh/incidents/abc",
    postmortem_published_at: null,
    updates: [{ id: "u1", at: AT, status: "investigating", text: "Looking." }],
  };
  const options = { siteUrl: "https://g1t.sh", supportUrl: "https://g1t.sh/support", ogImage: "", selfUrl: "https://status.g1t.sh/incidents/abc", now: new Date(AT) };
  const local = renderIncident(incident, null, new Map([["git", "Git"]]), { ...options, zone: "America/Los_Angeles" });
  assert.match(local, /<time datetime="2026-10-06T07:25:00.000Z" title="6 Oct 2026, 07:25 UTC">6 Oct 2026, 00:25 PDT<\/time>/);
  const utc = renderIncident(incident, null, new Map([["git", "Git"]]), options);
  assert.match(utc, />6 Oct 2026, 07:25 UTC<\/time>/, "one page's zone does not leak into the next");
});
