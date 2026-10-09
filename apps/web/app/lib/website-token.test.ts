import assert from "node:assert/strict";
import { test } from "node:test";

import type { User, Viewer } from "@g1t/contracts";

import { crossOrigin } from "./same-origin.ts";
import {
  NEEDS_SIGN_IN,
  TOKEN_REFUSED,
  alwaysNeedsSignIn,
  bearerToken,
  isNeedsSignIn,
  needsRealSignIn,
  tokenVerdict,
  websiteUser,
} from "./website-token.ts";

const ada: User = {
  id: "usr_ada",
  username: "ada",
  kind: "user",
  verified: true,
  workspaces: [{ slug: "acme", role: "owner" }],
  token: { token_id: "tok_web", scopes: ["repo:read"], website: true },
};

/** identity's `user_for_access_token`, over a few tokens. */
function lookup(tokens: Record<string, Viewer>) {
  const asked: string[] = [];
  const resolve = async (token: string) => {
    asked.push(token);
    return tokens[token] ?? null;
  };
  return Object.assign(resolve, { asked });
}

const tokens = lookup({
  g1t_web: ada,
  g1t_api_only: { ...ada, token: { token_id: "tok_api", scopes: null } },
  g1t_workspace: { ...ada, id: "wsp_1", username: "acme", kind: "workspace", token: { token_id: "tok_ws", website: true } },
  g1t_job: { ...ada, token: { token_id: "tok_job", website: true, job: { run_id: "run_1", job_id: "job_1" } } },
  g1t_agent: { ...ada, kind: "agent", token: { token_id: "tok_agent", website: true } },
});

function request(path: string, init: { method?: string; headers?: Record<string, string>; body?: BodyInit } = {}): Request {
  return new Request(`https://g1t.sh${path}`, init);
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test("a token with the website permission signs the request in as its owner", async () => {
  for (const path of ["/", "/acme/rocket", "/acme/rocket/pull/1.data", "/settings/profile"]) {
    const verdict = await tokenVerdict(request(path, { headers: bearer("g1t_web") }), tokens);
    assert.equal(verdict.kind, "signed-in", path);
    assert.equal(verdict.kind === "signed-in" && verdict.user.username, "ada");
  }
  // A form post too, which a token's request needs no CSRF token for.
  const post = request("/acme/rocket/issues/new", { method: "POST", headers: { ...bearer("g1t_web"), origin: "https://g1t.sh" }, body: new URLSearchParams({ title: "x" }) });
  assert.equal((await tokenVerdict(post, tokens)).kind, "signed-in");
});

test("a token without the website permission is no one: a page loads signed out, data and posts get a 401", async () => {
  for (const token of ["g1t_api_only", "g1t_workspace", "g1t_job", "g1t_agent"]) {
    assert.deepEqual(await tokenVerdict(request("/acme/rocket", { headers: bearer(token) }), tokens), { kind: "signed-out" }, token);
    assert.deepEqual(await tokenVerdict(request("/acme/rocket.data", { headers: bearer(token) }), tokens), { kind: "refused", status: 401, body: TOKEN_REFUSED }, token);
    const post = request("/acme/rocket/issues/new", { method: "POST", headers: bearer(token), body: new URLSearchParams({ title: "x" }) });
    assert.equal((await tokenVerdict(post, tokens)).kind, "refused", token);
  }
  assert.match(TOKEN_REFUSED, /Use the website as you/);
});

test("a revoked, expired or made-up token is refused, and nothing else is tried", async () => {
  // identity answers null for a token deleted, expired or never made.
  assert.equal((await tokenVerdict(request("/_root.data", { headers: bearer("g1t_deleted") }), tokens)).kind, "refused");
  assert.equal((await tokenVerdict(request("/", { headers: bearer("g1t_deleted") }), tokens)).kind, "signed-out");
  // Not a g1t token at all: identity is not asked.
  const before = tokens.asked.length;
  assert.equal((await tokenVerdict(request("/x.data", { headers: bearer("not-a-token") }), tokens)).kind, "refused");
  assert.equal(tokens.asked.length, before);
});

test("tokens are read from the Authorization header only, never a query string or a cookie", async () => {
  assert.deepEqual(await tokenVerdict(request("/?access_token=g1t_web&token=g1t_web"), tokens), { kind: "none" });
  assert.deepEqual(await tokenVerdict(request("/", { headers: { cookie: "g1t_session=g1t_web; token=g1t_web" } }), tokens), { kind: "none" });
  assert.equal(bearerToken(request("/", { headers: { authorization: "Basic " + btoa("ada:g1t_web") } })), null);
  assert.equal(bearerToken(request("/", { headers: { authorization: "bearer  g1t_web " } })), "g1t_web");
  assert.equal(bearerToken(request("/", { headers: { authorization: "Bearer a b" } })), null);
});

test("what needs a real sign-in is refused with a token, whatever the method", async () => {
  for (const path of [
    "/settings/tokens",
    "/settings/tokens/new",
    "/settings/tokens/tok_1.data",
    "/settings/two-factor",
    "/settings/emails",
    "/settings/keys",
    "/settings/account",
    "/settings/applications",
    "/settings/github",
    "/device",
    "/oauth/authorize",
    "/auth/github/callback",
    "/acme/-/tokens",
    "/acme/-/tokens/new.data",
    "/acme/-/personal-access-tokens",
    // As routes match them: any case, encoded, doubled or trailing slashes.
    "/Settings/Tokens",
    "/settings/%74okens",
    "//settings//two-factor/",
  ]) {
    assert.ok(alwaysNeedsSignIn(path), path);
    const verdict = await tokenVerdict(request(path, { headers: bearer("g1t_web") }), tokens);
    assert.deepEqual(verdict, { kind: "refused", status: 403, body: NEEDS_SIGN_IN }, path);
  }
  for (const path of ["/settings/profile", "/settings/notifications", "/settings/security-log", "/acme/-/settings", "/acme/-/billing", "/acme/rocket/settings"]) {
    assert.ok(!alwaysNeedsSignIn(path), path);
  }
  assert.ok(isNeedsSignIn(NEEDS_SIGN_IN));
  assert.ok(!isNeedsSignIn("Not found"));
});

test("deleting or giving away a workspace and payment methods are refused; other changes there are not", async () => {
  const post = (path: string, fields: Record<string, string>) =>
    request(path, { method: "POST", headers: bearer("g1t_web"), body: new URLSearchParams(fields) });
  for (const [path, fields] of [
    ["/acme/-/settings.data", { intent: "delete" }],
    ["/acme/-/people", { action: "transfer", member: "bob" }],
    ["/acme/-/billing.data", { intent: "portal" }],
    ["/acme/-/billing", { intent: "card-check" }],
    ["/acme/-/billing", { intent: "subscribe" }],
    ["/acme/-/billing", { intent: "buy-ai-credit", amount: "10" }],
  ] as const) {
    assert.equal((await tokenVerdict(post(path, fields), tokens)).kind, "refused", `${path} ${JSON.stringify(fields)}`);
  }
  for (const [path, fields] of [
    ["/acme/-/settings", { intent: "rename", slug: "acme2" }],
    ["/acme/-/people", { action: "role", member: "bob", role: "member" }],
    ["/acme/-/billing", { intent: "budget" }],
  ] as const) {
    assert.equal((await tokenVerdict(post(path, fields), tokens)).kind, "signed-in", `${path} ${JSON.stringify(fields)}`);
  }
  // Looking at those pages is fine.
  assert.ok(!needsRealSignIn("/acme/-/billing", "GET", null));
  assert.ok(!needsRealSignIn("/acme/-/settings", "POST", null));
  // A multipart post is read too.
  const multipart = new FormData();
  multipart.set("intent", "delete");
  const deleting = request("/acme/-/settings", { method: "POST", headers: bearer("g1t_web"), body: multipart });
  assert.equal((await tokenVerdict(deleting, tokens)).kind, "refused");
  // The action still reads the same body afterwards.
  assert.equal((await deleting.formData()).get("intent"), "delete");
});

test("only a person's own token with the permission is a website user", () => {
  assert.equal(websiteUser(ada)?.username, "ada");
  assert.equal(websiteUser(null), null);
  assert.equal(websiteUser({ ...ada, token: undefined }), null, "a session's user is not a token's");
  assert.equal(websiteUser({ ...ada, token: { token_id: "t", website: false } }), null);
  assert.equal(websiteUser({ ...ada, token: { token_id: "t", website: true, deploy_key: "key_1" } }), null);
  assert.equal(websiteUser({ ...ada, acting: { agent: "g1t" } as unknown as User["acting"] }), null);
});

test("cross-site form posts are refused for a session cookie and a token alike", () => {
  const post = (headers: Record<string, string>) => request("/acme/rocket/issues/new", { method: "POST", headers });
  assert.ok(crossOrigin(post({ cookie: "g1t_session=" + "a".repeat(64), origin: "https://evil.example" })));
  assert.ok(crossOrigin(post({ ...bearer("g1t_web"), origin: "https://evil.example" })));
  assert.ok(crossOrigin(post({ cookie: "g1t_session=" + "a".repeat(64), origin: "null" })));
  assert.ok(!crossOrigin(post({ cookie: "g1t_session=" + "a".repeat(64), origin: "https://g1t.sh" })));
  assert.ok(!crossOrigin(post(bearer("g1t_web"))), "automation that sends no Origin is not another site");
});
