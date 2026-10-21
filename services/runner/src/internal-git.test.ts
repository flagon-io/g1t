import assert from "node:assert/strict";
import { test } from "node:test";

import { GIT_HOST, GIT_INTERNAL_ENV, GIT_INTERNAL_URL, internalGit, isGitHost, isGitRequest } from "./internal-git.ts";

const authorization = `basic ${btoa("x-access-token:g1t_job")}`;

/** A repos binding that records what it is sent and answers `answer`. */
function repos(answer: () => Promise<Response> = async () => new Response("pack")) {
  const sent: Request[] = [];
  return {
    sent,
    binding: {
      async fetch(request: Request) {
        sent.push(request);
        return answer();
      },
    },
  };
}

test("the runner is told the internal base, which is the internal host", () => {
  assert.deepEqual(GIT_INTERNAL_ENV, { G1T_GIT_INTERNAL: "http://git.g1t.internal" });
  assert.equal(new URL(GIT_INTERNAL_URL).host, GIT_HOST);
  assert.equal(isGitHost("Git.G1T.internal:80"), true);
  assert.equal(isGitHost("g1t.sh"), false);
  assert.equal(isGitHost("git.g1t.internal.evil.com"), false);
});

test("only git's smart HTTP for one repository is a git request", () => {
  const is = (path: string) => isGitRequest(new URL(path, GIT_INTERNAL_URL));
  assert.equal(is("/acme/app/info/refs?service=git-upload-pack"), true);
  assert.equal(is("/acme/app.git/info/refs?service=git-receive-pack"), true);
  assert.equal(is("/acme/app/git-upload-pack"), true);
  assert.equal(is("/acme/app.git/git-receive-pack"), true);
  assert.equal(is("/acme/app/info/refs"), false);
  assert.equal(is("/acme/app/info/refs?service=git-foo"), false);
  assert.equal(is("/acme/app/HEAD"), false);
  assert.equal(is("/app/git-upload-pack"), false);
  assert.equal(is("/acme/team/app/git-upload-pack"), false);
  assert.equal(is("/rpc/get"), false);
  assert.equal(is("//app/git-upload-pack"), false);
});

test("a job's clone goes to the repos service as it came, and its answer streams back", async () => {
  const { sent, binding } = repos(async () => new Response("0008NAK\n", { status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } }));
  const request = new Request(`${GIT_INTERNAL_URL}/acme/app/git-upload-pack`, {
    method: "POST",
    headers: { authorization, "content-type": "application/x-git-upload-pack-request", "git-protocol": "version=2" },
    body: "0014command=fetch\n0000",
  });
  const response = await internalGit(request, { REPOS: binding });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "0008NAK\n");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, `${GIT_INTERNAL_URL}/acme/app/git-upload-pack`);
  assert.equal(sent[0].method, "POST");
  assert.equal(sent[0].headers.get("authorization"), authorization);
  assert.equal(sent[0].headers.get("git-protocol"), "version=2");
  assert.equal(sent[0].redirect, "manual");
  assert.equal(await sent[0].text(), "0014command=fetch\n0000");
});

test("a redirect goes back to git, which follows it itself", async () => {
  const { binding } = repos(
    async () => new Response(null, { status: 301, headers: { location: `${GIT_INTERNAL_URL}/renamed/app/info/refs?service=git-upload-pack` } }),
  );
  const response = await internalGit(new Request(`${GIT_INTERNAL_URL}/old/app/info/refs?service=git-upload-pack`, { headers: { authorization } }), {
    REPOS: binding,
  });
  assert.equal(response.status, 301);
  assert.match(response.headers.get("location") ?? "", /\/renamed\/app\//);
});

test("anything else, an anonymous clone, or no binding is refused, and never reaches the repos service", async () => {
  const { sent, binding } = repos();
  const other = await internalGit(new Request(`${GIT_INTERNAL_URL}/rpc/get`, { method: "POST", headers: { authorization }, body: "{}" }), { REPOS: binding });
  assert.equal(other.status, 404);
  const anonymous = await internalGit(new Request(`${GIT_INTERNAL_URL}/acme/app/info/refs?service=git-upload-pack`), { REPOS: binding });
  assert.equal(anonymous.status, 401);
  assert.match(await anonymous.text(), /needs the job's token/);
  assert.equal(sent.length, 0);
  const unbound = await internalGit(new Request(`${GIT_INTERNAL_URL}/acme/app/info/refs?service=git-upload-pack`, { headers: { authorization } }), {});
  assert.equal(unbound.status, 503);
});

test("a repos service that cannot be reached is a 502 naming why, never a throw", async () => {
  const { binding } = repos(async () => {
    throw new Error("Network connection lost.");
  });
  const response = await internalGit(new Request(`${GIT_INTERNAL_URL}/acme/app/info/refs?service=git-upload-pack`, { headers: { authorization } }), {
    REPOS: binding,
  });
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("x-g1t-egress"), "internal-git");
  assert.match(await response.text(), /Network connection lost/);
});
