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
  scopedRoute,
  scopedUser,
  socketUser,
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
  const post = request("/acme/rocket/issues/new", {
    method: "POST",
    headers: { ...bearer("g1t_web"), origin: "https://g1t.sh" },
    body: new URLSearchParams({ title: "x" }),
  });
  assert.equal((await tokenVerdict(post, tokens)).kind, "signed-in");
});

test("a token without the website permission is no one: a page loads signed out, data and posts get a 401", async () => {
  for (const token of ["g1t_api_only", "g1t_workspace", "g1t_job", "g1t_agent"]) {
    assert.deepEqual(await tokenVerdict(request("/acme/rocket", { headers: bearer(token) }), tokens), { kind: "signed-out" }, token);
    assert.deepEqual(
      await tokenVerdict(request("/acme/rocket.data", { headers: bearer(token) }), tokens),
      { kind: "refused", status: 401, body: TOKEN_REFUSED },
      token,
    );
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
    "/acme/-/settings/tokens",
    "/acme/-/settings/tokens/new.data",
    "/acme/-/settings/personal-access-tokens",
    // As routes match them: any case, encoded, doubled or trailing slashes.
    "/Settings/Tokens",
    "/settings/%74okens",
    "//settings//two-factor/",
  ]) {
    assert.ok(alwaysNeedsSignIn(path), path);
    const verdict = await tokenVerdict(request(path, { headers: bearer("g1t_web") }), tokens);
    assert.deepEqual(verdict, { kind: "refused", status: 403, body: NEEDS_SIGN_IN }, path);
  }
  for (const path of [
    "/settings/profile",
    "/settings/notifications",
    "/settings/security-log",
    "/acme/-/settings",
    "/acme/-/settings/billing",
    "/acme/rocket/settings",
  ]) {
    assert.ok(!alwaysNeedsSignIn(path), path);
  }
  assert.ok(isNeedsSignIn(NEEDS_SIGN_IN));
  assert.ok(!isNeedsSignIn("Not found"));
});

test("deleting or giving away a workspace and payment methods are refused; other changes there are not", async () => {
  const post = (path: string, fields: Record<string, string>) =>
    request(path, { method: "POST", headers: bearer("g1t_web"), body: new URLSearchParams(fields) });
  for (const [path, fields] of [
    ["/acme/-/settings/profile.data", { intent: "delete" }],
    ["/acme/-/settings/members", { action: "transfer", member: "bob" }],
    ["/acme/-/settings/billing.data", { intent: "portal" }],
    ["/acme/-/settings/billing", { intent: "card-check" }],
    ["/acme/-/settings/billing", { intent: "subscribe" }],
    ["/acme/-/settings/billing", { intent: "buy-ai-credit", amount: "10" }],
  ] as const) {
    assert.equal((await tokenVerdict(post(path, fields), tokens)).kind, "refused", `${path} ${JSON.stringify(fields)}`);
  }
  for (const [path, fields] of [
    ["/acme/-/settings/profile", { intent: "rename", slug: "acme2" }],
    ["/acme/-/settings/members", { action: "role", member: "bob", role: "member" }],
    ["/acme/-/settings/billing", { intent: "budget" }],
  ] as const) {
    assert.equal((await tokenVerdict(post(path, fields), tokens)).kind, "signed-in", `${path} ${JSON.stringify(fields)}`);
  }
  // Looking at those pages is fine.
  assert.ok(!needsRealSignIn("/acme/-/settings/billing", "GET", null));
  assert.ok(!needsRealSignIn("/acme/-/settings/profile", "POST", null));
  // A multipart post is read too.
  const multipart = new FormData();
  multipart.set("intent", "delete");
  const deleting = request("/acme/-/settings/profile", { method: "POST", headers: bearer("g1t_web"), body: multipart });
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

/** A person's token without the website permission, as an OAuth sign-in (the phone app) or a personal token has it. */
const scoped = (scopes: string[] | null, more: Partial<NonNullable<User["token"]>> = {}): User => ({
  ...ada,
  token: { token_id: "tok_app", scopes, ...more },
});

const scopedTokens = lookup({
  g1t_chat_read: scoped(["chat:read", "notifications:read"]),
  g1t_chat_write: scoped(["chat:write", "notifications:write"]),
  g1t_no_chat: scoped(["repo:read", "work:write", "notifications:read"]),
  g1t_full: scoped(null),
  g1t_legacy: scoped(null, { legacy: true }),
  g1t_web: ada,
  g1t_workspace: { ...ada, id: "wsp_1", username: "acme", kind: "workspace", token: { token_id: "tok_ws", scopes: ["chat:write"] } },
  g1t_job: scoped(["chat:write"], { job: { run_id: "run_1", job_id: "job_1" } }),
  g1t_deploy: scoped(["chat:write"], { deploy_key: "key_1" }),
  g1t_agent: { ...scoped(["chat:write"]), kind: "agent" },
});

const verdictOf = async (token: string, path: string, method = "GET") =>
  (await tokenVerdict(request(path, { method, headers: bearer(token), body: method === "GET" ? undefined : JSON.stringify({ intent: "post" }) }), scopedTokens))
    .kind;

test("a token with chat:read reads Chat's JSON without the website permission, and sends nothing", async () => {
  for (const path of ["/acme/-/chat/api", "/acme/-/chat/api?channel=ch_1&thread=m_1", "/Acme//-/chat/api/", "/acme/-/chat/person/bob"]) {
    assert.equal(await verdictOf("g1t_chat_read", path), "signed-in", path);
  }
  assert.equal(await verdictOf("g1t_chat_read", "/acme/-/chat/api", "POST"), "refused");
  assert.equal(await verdictOf("g1t_chat_read", "/acme/-/chat/person/bob", "POST"), "refused");
});

test("a token with chat:write sends to Chat's JSON, and reads it too", async () => {
  assert.equal(await verdictOf("g1t_chat_write", "/acme/-/chat/api", "POST"), "signed-in");
  assert.equal(await verdictOf("g1t_chat_write", "/acme/-/chat/api"), "signed-in");
  assert.equal(await verdictOf("g1t_chat_write", "/-/live/ticket?path=%2Facme%2F-%2Fchat%2Flive"), "signed-in");
});

test("a token without a chat scope, or not a person's own, reaches none of Chat", async () => {
  for (const token of ["g1t_no_chat", "g1t_workspace", "g1t_job", "g1t_deploy", "g1t_agent"]) {
    assert.equal(await verdictOf(token, "/acme/-/chat/api"), "signed-out", token);
    assert.equal(await verdictOf(token, "/acme/-/chat/api", "POST"), "refused", token);
    assert.equal(await verdictOf(token, "/-/live/ticket?path=%2F-%2Flive"), "signed-out", token);
  }
});

test("a chat-scoped token opens nothing else on the site: pages are signed out, data and posts are a 401", async () => {
  for (const token of ["g1t_chat_write", "g1t_full"]) {
    for (const path of ["/", "/acme", "/acme/-/chat", "/acme/-/chat/general", "/acme/rocket", "/settings/profile", "/acme/-/chat/live", "/-/live"]) {
      assert.deepEqual(await tokenVerdict(request(path, { headers: bearer(token) }), scopedTokens), { kind: "signed-out" }, `${token} ${path}`);
    }
    // A client navigation's data runs the loaders around the route as well, so it is not Chat's JSON.
    for (const path of ["/acme/-/chat/api.data", "/acme/-/chat/person/bob.data", "/acme/-/chat.data", "/-/notify.data", "/-/live/ticket.data", "/_root.data"]) {
      assert.deepEqual(
        await tokenVerdict(request(path, { headers: bearer(token) }), scopedTokens),
        { kind: "refused", status: 401, body: TOKEN_REFUSED },
        `${token} ${path}`,
      );
    }
    for (const path of ["/acme/rocket/issues/new", "/acme/-/chat/general", "/-/live/ticket", "/acme/-/chat/person/bob", "/-/-/chat/api"]) {
      assert.equal(await verdictOf(token, path, "POST"), "refused", `${token} ${path}`);
    }
    assert.equal(await verdictOf(token, "/acme/-/chat/api", "DELETE"), "refused");
  }
  assert.equal(scopedRoute("/-/-/chat/api", "GET"), null, "`-` is no workspace");
  assert.equal(scopedRoute("/acme/web/-/chat/api", "GET"), null);
  assert.equal(scopedRoute("/acme/-/chat/person/bob/x", "GET"), null);
});

test("push registration and notification settings take the notifications scopes", async () => {
  assert.equal(await verdictOf("g1t_chat_read", "/-/notify"), "signed-in");
  assert.equal(await verdictOf("g1t_chat_read", "/-/notify", "POST"), "refused");
  assert.equal(await verdictOf("g1t_chat_write", "/-/notify", "POST"), "signed-in");
  assert.equal(await verdictOf("g1t_chat_write", "/-/notify"), "signed-in", "write includes read");
  assert.equal(await verdictOf("g1t_no_chat", "/-/notify"), "signed-in", "notifications:read alone is enough");
  assert.equal(await verdictOf("g1t_no_chat", "/-/notify", "POST"), "refused");
  assert.equal(scopedRoute("/-/notify", "POST"), "notifications:write");
});

test("full access, legacy or not, reaches Chat only with the website permission; the website permission keeps opening everything", async () => {
  for (const token of ["g1t_full", "g1t_legacy"]) {
    assert.equal(await verdictOf(token, "/acme/-/chat/api", "GET"), "signed-out", token);
    assert.equal(await verdictOf(token, "/acme/-/chat/api", "POST"), "refused", token);
    assert.equal(await verdictOf(token, "/-/notify", "POST"), "refused", token);
    assert.equal(socketUser(scoped(null), "/-/live"), null, token);
  }
  // A website token with no chat scope is the website's as before, Chat included.
  assert.equal(await verdictOf("g1t_web", "/acme/-/chat/api", "POST"), "signed-in");
  assert.equal(await verdictOf("g1t_web", "/acme/rocket"), "signed-in");
  assert.equal(scopedUser(scoped(["chat:read"]), "/acme/-/chat/api", "GET")?.username, "ada");
  assert.equal(scopedUser({ ...ada, token: undefined }, "/acme/-/chat/api", "GET"), null, "a session is not a token");
  assert.equal(scopedUser(scoped(["chat:bogus", "chat"]), "/acme/-/chat/api", "GET"), null);
});

test("a chat-scoped token opens Chat's socket and the feed, never an artifact's", () => {
  const reader = scoped(["chat:read"]);
  assert.equal(socketUser(reader, "/acme/-/chat/live")?.username, "ada");
  assert.equal(socketUser(reader, "/-/live")?.username, "ada");
  assert.equal(socketUser(reader, "/acme/-/library/artifacts/live"), null);
  assert.equal(socketUser(scoped(null), "/acme/-/chat/live"), null, "full access, without the website permission");
  assert.equal(socketUser(scoped(["notifications:write"]), "/-/live"), null);
  assert.equal(socketUser(scoped(["chat:read"], { job: { run_id: "run_1", job_id: "job_1" } }), "/-/live"), null);
  assert.equal(socketUser({ ...ada, token: undefined }, "/-/live"), null);
  // The website permission opens every socket, as before.
  assert.equal(socketUser(ada, "/acme/-/library/artifacts/live")?.username, "ada");
});
