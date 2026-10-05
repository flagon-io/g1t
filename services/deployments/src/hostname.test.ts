import assert from "node:assert/strict";
import { test } from "node:test";

import { apexOf, checkHostname, isApex, recordName, twinOf } from "./hostname.ts";
import { recordsOf, statusOf } from "./custom-hostnames.ts";

const host = (input: string) => {
  const checked = checkHostname(input);
  return checked.ok ? checked.hostname : null;
};

test("hostnames are lowercased and cleaned of what people paste", () => {
  assert.equal(host("Aut10dmain.IO"), "aut10dmain.io");
  assert.equal(host("  https://www.example.com/some/path?x=1 "), "www.example.com");
  assert.equal(host("example.com."), "example.com");
});

test("international names become punycode", () => {
  assert.equal(host("bücher.example"), "xn--bcher-kva.example");
});

test("what is not a hostname g1t can serve is refused", () => {
  for (const bad of [
    "",
    "localhost",
    "*.example.com",
    "example.com:8080",
    "1.2.3.4",
    "user@example.com",
    "-bad.example.com",
    "bad-.example.com",
    `${"a".repeat(64)}.com`,
    `${"a.".repeat(130)}com`,
    "exa mple.com",
  ]) {
    assert.equal(checkHostname(bad).ok, false, bad);
  }
});

test("g1t's own domains are refused", () => {
  for (const own of ["g1t.page", "web-acme.g1t.page", "domains.g1t.page", "g1t.sh", "docs.g1t.sh"]) {
    const checked = checkHostname(own);
    assert.equal(checked.ok, false, own);
  }
  assert.equal(host("notg1t.page"), "notg1t.page");
});

test("apex and www twins", () => {
  assert.equal(isApex("example.com"), true);
  assert.equal(isApex("www.example.com"), false);
  assert.equal(isApex("example.co.uk"), true);
  assert.equal(apexOf("app.shop.example.co.uk"), "example.co.uk");
  assert.equal(twinOf("example.com"), "www.example.com");
  assert.equal(twinOf("www.example.com"), "example.com");
  assert.equal(twinOf("app.example.com"), null);
  assert.equal(twinOf("www.app.example.com"), null);
  assert.equal(recordName("example.com"), "@");
  assert.equal(recordName("www.example.com"), "www");
});

test("Cloudflare's states become a domain's", () => {
  assert.equal(statusOf({ id: "1", hostname: "a.com", status: "pending", ssl: { status: "pending_validation" } }).status, "pending");
  assert.equal(statusOf({ id: "1", hostname: "a.com", status: "active", ssl: { status: "pending_validation" } }).status, "verifying");
  assert.equal(statusOf({ id: "1", hostname: "a.com", status: "active", ssl: { status: "active" } }).status, "active");
  assert.equal(statusOf({ id: "1", hostname: "a.com", status: "blocked" }).status, "failed");
  assert.equal(statusOf({ id: "1", hostname: "a.com", status: "pending", ssl: { status: "validation_timed_out" } }).status, "failed");
});

test("the records Cloudflare asks for are listed", () => {
  const records = recordsOf({
    id: "1",
    hostname: "a.com",
    status: "pending",
    ownership_verification: { type: "txt", name: "_cf-custom-hostname.a.com", value: "abc" },
    ssl: { validation_records: [{ txt_name: "_acme-challenge.a.com", txt_value: "xyz" }, { http_url: "http://a.com/.well-known/x", http_body: "b" }] },
  });
  assert.deepEqual(
    records.map((r) => `${r.type} ${r.name} ${r.value}`),
    ["TXT _cf-custom-hostname.a.com abc", "TXT _acme-challenge.a.com xyz"],
  );
});
