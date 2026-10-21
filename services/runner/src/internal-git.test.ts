import assert from "node:assert/strict";
import { test } from "node:test";

import { GIT_PUBLIC_HOST, gitService, isGitHost, takesInternalPath, viaRepos } from "./internal-git.ts";

const authorization = `basic ${btoa("x-access-token:g1t_job")}`;
const base = `https://${GIT_PUBLIC_HOST}`;

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

/** The public way, recording what it is sent. */
function publicWay() {
  const sent: Request[] = [];
  return {
    sent,
    async onward(request: Request) {
      sent.push(request);
      return new Response("from g1t.sh", { status: 200 });
    },
  };
}

/** actions/checkout's fetch of a repository: protocol v2, its token in the extraheader. */
function fetchRequest(path = "/acme/app/git-upload-pack", body = "0014command=fetch\n0000") {
  return new Request(`${base}${path}`, {
    method: "POST",
    headers: { authorization, "content-type": "application/x-git-upload-pack-request", "git-protocol": "version=2" },
    body,
  });
}

test("only g1t.sh is g1t's git host", () => {
  assert.equal(isGitHost("G1T.sh:443"), true);
  assert.equal(isGitHost("g1t.sh."), true);
  assert.equal(isGitHost("api.g1t.sh"), false);
  assert.equal(isGitHost("g1t.sh.evil.com"), false);
});

test("git's smart HTTP for one repository is told by its service", () => {
  const service = (path: string) => gitService(new URL(path, base));
  assert.equal(service("/acme/app/info/refs?service=git-upload-pack"), "git-upload-pack");
  assert.equal(service("/acme/app.git/info/refs?service=git-receive-pack"), "git-receive-pack");
  assert.equal(service("/acme/app/git-upload-pack"), "git-upload-pack");
  assert.equal(service("/acme/app.git/git-receive-pack"), "git-receive-pack");
  assert.equal(service("/acme/app/info/refs"), null);
  assert.equal(service("/acme/app/info/refs?service=git-foo"), null);
  assert.equal(service("/acme/app/HEAD"), null);
  assert.equal(service("/app/git-upload-pack"), null);
  assert.equal(service("/acme/team/app/git-upload-pack"), null);
  assert.equal(service("/rpc/get"), null);
  assert.equal(service("//app/git-upload-pack"), null);
});

test("only a signed-in fetch from g1t.sh takes the internal path", () => {
  const get = (url: string, headers: Record<string, string> = { authorization }) => new Request(url, { headers });
  assert.equal(takesInternalPath(get(`${base}/acme/app/info/refs?service=git-upload-pack`)), true);
  assert.equal(takesInternalPath(fetchRequest()), true);
  // Anonymous: the front door counts it by address.
  assert.equal(takesInternalPath(get(`${base}/acme/app/info/refs?service=git-upload-pack`, {})), false);
  // A push: its pack cannot be sent again the public way.
  assert.equal(takesInternalPath(get(`${base}/acme/app/info/refs?service=git-receive-pack`)), false);
  assert.equal(takesInternalPath(get(`${base}/acme/app`)), false);
  assert.equal(takesInternalPath(get("https://github.com/acme/app/info/refs?service=git-upload-pack")), false);
});

test("a job's fetch goes to the repos service as it came, and its answer streams back", async () => {
  const { sent, binding } = repos(async () => new Response("0008NAK\n", { status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } }));
  const out = publicWay();
  const response = await viaRepos(fetchRequest(), { REPOS: binding }, out.onward);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "0008NAK\n");
  assert.equal(out.sent.length, 0);
  assert.equal(sent.length, 1);
  // The URL is g1t.sh's, as the front door hands it on.
  assert.equal(sent[0].url, `${base}/acme/app/git-upload-pack`);
  assert.equal(sent[0].method, "POST");
  assert.equal(sent[0].headers.get("authorization"), authorization);
  assert.equal(sent[0].headers.get("git-protocol"), "version=2");
  assert.equal(sent[0].redirect, "manual");
  assert.equal(await sent[0].text(), "0014command=fetch\n0000");
});

test("the repos service's refusal is the job's answer, as on the public path", async () => {
  const { binding } = repos(async () => new Response("Authentication required\n", { status: 401, headers: { "www-authenticate": 'Basic realm="g1t"' } }));
  const out = publicWay();
  const response = await viaRepos(fetchRequest(), { REPOS: binding }, out.onward);
  assert.equal(response.status, 401);
  assert.equal(out.sent.length, 0);
});

test("a redirect goes back to git, which follows it itself", async () => {
  const { binding } = repos(async () => new Response(null, { status: 301, headers: { location: `${base}/renamed/app/info/refs?service=git-upload-pack` } }));
  const request = new Request(`${base}/old/app/info/refs?service=git-upload-pack`, { headers: { authorization } });
  const response = await viaRepos(request, { REPOS: binding }, publicWay().onward);
  assert.equal(response.status, 301);
  assert.match(response.headers.get("location") ?? "", /\/renamed\/app\//);
});

test("a fetch the repos service could not answer is sent the public way, body and all", async () => {
  for (const failing of [
    async (): Promise<Response> => {
      throw new Error("Network connection lost.");
    },
    async () => new Response("busy", { status: 503 }),
  ]) {
    const { sent, binding } = repos(failing);
    const out = publicWay();
    const response = await viaRepos(fetchRequest(), { REPOS: binding }, out.onward);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "from g1t.sh");
    assert.equal(sent.length, 1);
    assert.equal(out.sent.length, 1);
    assert.equal(out.sent[0].url, `${base}/acme/app/git-upload-pack`);
    assert.equal(out.sent[0].headers.get("authorization"), authorization);
    assert.equal(await out.sent[0].text(), "0014command=fetch\n0000");
  }
});

test("everything else to g1t.sh, or no binding, goes the public way and never reaches the repos service", async () => {
  const { sent, binding } = repos();
  const out = publicWay();
  const push = new Request(`${base}/acme/app/git-receive-pack`, { method: "POST", headers: { authorization }, body: "PACK" });
  const anonymous = new Request(`${base}/acme/app/info/refs?service=git-upload-pack`);
  const page = new Request(`${base}/acme/app`, { headers: { authorization } });
  for (const request of [push, anonymous, page]) {
    assert.equal((await viaRepos(request, { REPOS: binding }, out.onward)).status, 200);
  }
  assert.equal((await viaRepos(fetchRequest(), {}, out.onward)).status, 200);
  assert.equal(sent.length, 0);
  assert.equal(out.sent.length, 4);
  // A push's pack streams on as it came.
  assert.equal(out.sent[0], push);
});
