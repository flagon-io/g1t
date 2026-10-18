import assert from "node:assert/strict";
import { test } from "node:test";

import { DANGEROUS_SCOPES, OAUTH_DEFAULT_SCOPES, SCOPES, SCOPE_GROUPS } from "@g1t/contracts/scopes";

import {
  accessSummary,
  consentedScopes,
  describeExpiry,
  everyScope,
  grantFromForm,
  impliedBy,
  matchingPreset,
  normalizeScopes,
  requestedScopes,
  scopesFromForm,
} from "./token-scopes.ts";

function form(fields: Record<string, string | string[]>) {
  return {
    get: (name: string) => {
      const value = fields[name];
      return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
    },
    getAll: (name: string) => {
      const value = fields[name];
      return value === undefined ? [] : Array.isArray(value) ? value : [value];
    },
  };
}

test("every scope is on the checklist exactly once, admin ones under Dangerous", () => {
  const listed = [...SCOPE_GROUPS.flatMap((group) => group.scopes), ...DANGEROUS_SCOPES];
  assert.deepEqual([...listed].sort(), SCOPES.map((row) => row.scope).sort());
  assert.equal(new Set(listed).size, listed.length);
  assert.ok(DANGEROUS_SCOPES.every((scope) => scope.endsWith(":admin") || scope.endsWith(":delete")));
});

test("ticked boxes store the highest level of each resource", () => {
  const parsed = scopesFromForm(
    form({ scope: ["work:read", "work:write", "code:read", "agents:run", "memory:write", "bogus:read"] }),
  );
  assert.deepEqual(parsed, { ok: true, value: ["code:read", "work:write"] });
  assert.deepEqual(normalizeScopes(["repo:read", "repo:admin", "repo:write"]), ["repo:admin"]);
});

test("full access is null, and nothing ticked is refused", () => {
  assert.deepEqual(scopesFromForm(form({ preset: "full", scope: "work:read" })), { ok: true, value: null });
  assert.equal(scopesFromForm(form({ preset: "full" }), { allowFull: false }).ok, false);
  assert.equal(scopesFromForm(form({ preset: "custom" })).ok, false);
  assert.deepEqual(grantFromForm(form({ scope: "observability:read" })), { ok: true, value: { scopes: ["observability:read"] } });
});

test("a higher level ticks the lower ones of its resource only", () => {
  assert.equal(impliedBy(["work:write"], "work:read"), "work:write");
  assert.equal(impliedBy(["repo:admin"], "repo:write"), "repo:admin");
  assert.equal(impliedBy(["work:write"], "work:write"), null);
  assert.equal(impliedBy(["work:write"], "pull_requests:read"), null);
  assert.equal(impliedBy(["code:read"], "code:write"), null);
});

test("full access ticks the top level of everything", () => {
  const all = everyScope();
  assert.ok(all.includes("repo:admin"));
  assert.ok(!all.includes("agents:run"), "retired");
  assert.ok(!all.some((scope) => scope.startsWith("memory:")), "retired");
  assert.ok(all.includes("code:write"));
  assert.ok(!all.includes("code:read"));
});

test("presets are recognised however their scopes are written", () => {
  assert.equal(matchingPreset(null), "full");
  assert.equal(matchingPreset(["repo:read", "code:write", "packages:write", "workflows:write", "checks:write", "deployments:write"]), "ci");
  assert.equal(matchingPreset([...OAUTH_DEFAULT_SCOPES]), "agent");
  assert.equal(matchingPreset(["work:read"]), null);
});

test("a token's access reads plainly", () => {
  assert.equal(accessSummary({ scopes: null, legacy: true }), "Legacy · full access");
  assert.equal(accessSummary({ scopes: null, legacy: false }), "Full access");
  assert.equal(accessSummary({ scopes: ["code:read", "code:write", "packages:write", "workflows:write", "checks:write", "deployments:write", "repo:read"], legacy: false }), "CI");
  assert.equal(accessSummary({ scopes: ["work:read", "work:write", "pull_requests:read"], legacy: false }), "2 scopes");
  assert.equal(accessSummary({ scopes: [], legacy: false }), "No scopes");
});

test("an application asking for nothing usable gets the default set, never admin", () => {
  assert.deepEqual(requestedScopes(null), OAUTH_DEFAULT_SCOPES);
  assert.deepEqual(requestedScopes("openid profile *"), OAUTH_DEFAULT_SCOPES);
  assert.ok(!requestedScopes("").some((scope) => scope.endsWith(":admin")));
  assert.deepEqual(requestedScopes("work:write nonsense repo:read"), ["repo:read", "work:write"]);
});

test("consent keeps only what was asked for", () => {
  const requested = requestedScopes("repo:read work:read work:write");
  assert.deepEqual(consentedScopes(form({ scope: ["work:write", "repo:admin", "secrets:admin"] }), requested), ["work:write"]);
  assert.deepEqual(consentedScopes(form({ scope: ["work:read", "repo:read"] }), requested), ["repo:read", "work:read"]);
  assert.deepEqual(consentedScopes(form({}), requested), []);
});

test("expiry words", () => {
  const now = Date.parse("2026-10-05T00:00:00Z");
  assert.equal(describeExpiry(null, now), "No expiry");
  assert.equal(describeExpiry("2026-10-04T00:00:00Z", now), "Expired");
  assert.equal(describeExpiry("2026-10-12T00:00:00Z", now), "Expires in 7 days");
  assert.equal(describeExpiry("2026-10-05T01:00:00Z", now), "Expires in 1 hour");
  assert.equal(describeExpiry("2027-01-03T00:00:00Z", now), "Expires in 3 months");
});
