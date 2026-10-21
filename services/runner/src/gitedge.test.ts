import assert from "node:assert/strict";
import { test } from "node:test";

import { type EdgeBox, type EdgeNamespace, GIT_EDGE_ENV, answerEdge, edgeRoute, routeToEdge } from "./gitedge.ts";

const REPO = "rep_01jb2k7x9hfq0b3zj0f5s2m8ra";
const base = `https://runner/gitedge/${REPO}`;

/**
 * A container that is running or not, as told, and records what it was
 * asked: starts, requests passed to it (with their bodies read), and work
 * left running in the background.
 */
function box(running: boolean, answer: (request: Request) => Response | Promise<Response> = () => new Response("ok")) {
  const seen = {
    starts: 0,
    forwarded: [] as { method: string; url: string; headers: Headers; body: string }[],
    background: [] as Promise<unknown>[],
    logged: [] as unknown[][],
  };
  const edge: EdgeBox = {
    ready: async () => running,
    start: async () => {
      seen.starts++;
      running = true;
    },
    forward: async (request) => {
      // The container is only ever asked once it runs.
      assert.equal(running, true, "a request reached a container that was not running");
      seen.forwarded.push({ method: request.method, url: request.url, headers: request.headers, body: await request.text() });
      return answer(request);
    },
    background: (work) => void seen.background.push(work),
    log: (...data) => void seen.logged.push(data),
  };
  return { edge, seen };
}

test("only the edge's four endpoints, with their methods, are routed", () => {
  const route = (method: string, path: string) => edgeRoute(method, new URL(`https://runner${path}`));
  assert.deepEqual(route("POST", `/gitedge/${REPO}/sync`), { repoId: REPO, endpoint: "sync" });
  assert.deepEqual(route("GET", `/gitedge/${REPO}/state`), { repoId: REPO, endpoint: "state" });
  assert.deepEqual(route("GET", `/gitedge/${REPO}/info/refs?service=git-upload-pack`), { repoId: REPO, endpoint: "info/refs" });
  assert.deepEqual(route("POST", `/gitedge/${REPO}/git-upload-pack`), { repoId: REPO, endpoint: "git-upload-pack" });
  assert.deepEqual(route("get", `/gitedge/repo_1/state`), { repoId: "repo_1", endpoint: "state" });
  for (const [method, path] of [
    // Pushes never reach the edge.
    ["GET", `/gitedge/${REPO}/info/refs?service=git-receive-pack`],
    ["GET", `/gitedge/${REPO}/info/refs`],
    ["POST", `/gitedge/${REPO}/git-receive-pack`],
    // The wrong method.
    ["GET", `/gitedge/${REPO}/sync`],
    ["POST", `/gitedge/${REPO}/state`],
    ["GET", `/gitedge/${REPO}/git-upload-pack`],
    // Anything else in the container, or around the endpoints.
    ["GET", `/gitedge/${REPO}/git/info/refs?service=git-upload-pack`],
    ["POST", `/gitedge/${REPO}/sync/`],
    ["GET", `/gitedge/${REPO}/HEAD`],
    ["GET", `/gitedge/${REPO}/objects/info/packs`],
    ["GET", `/gitedge/${REPO}/`],
    ["GET", `/gitedge/${REPO}`],
    // Not a repository's id.
    ["GET", `/gitedge/Rep_01/state`],
    ["GET", `/gitedge/rep-01/state`],
    ["GET", `/gitedge/rep_01%2F..%2Fx/state`],
    ["GET", `/gitedge/..%2Frep_01/state`],
    ["GET", `/gitedge//state`],
    ["GET", `/gitedge/flagon-io/g1t/state`],
    ["GET", `/gitedge/rep_${"a".repeat(65)}/state`],
    ["GET", `/rpc/gitedge/${REPO}/state`],
  ]) {
    assert.equal(route(method!, path!), null, `${method} ${path}`);
  }
});

test("the edge's container is the runner binary as the edge's server, on 8080, not watched for mining", () => {
  assert.deepEqual(GIT_EDGE_ENV, { MODE: "gitedge", GITEDGE_PORT: "8080", G1T_ABUSE: "off" });
});

test("the Worker passes a request to its repository's object, as it came, and nothing else", async () => {
  const named: string[] = [];
  const got: Request[] = [];
  const namespace: EdgeNamespace = {
    idFromName: (name) => {
      named.push(name);
      return name as unknown as DurableObjectId;
    },
    get: (id) => ({
      fetch: async (request) => {
        assert.equal(id as unknown as string, REPO);
        got.push(request);
        return new Response("from the edge", { status: 202 });
      },
    }),
  };
  const sync = new Request(`${base}/sync`, { method: "POST", body: "{}" });
  const answer = await routeToEdge(sync, namespace);
  assert.equal(answer.status, 202);
  assert.equal(await answer.text(), "from the edge");
  assert.deepEqual(named, [REPO]);
  assert.equal(got[0], sync);

  const refused = await routeToEdge(new Request(`${base}/git-receive-pack`, { method: "POST", body: "x" }), namespace);
  assert.equal(refused.status, 404);
  assert.equal((await routeToEdge(new Request("https://runner/gitedge/../state"), namespace)).status, 404);
  assert.deepEqual(named, [REPO]);

  // A g1t without the edge: a miss, which the repos service answers from Artifacts.
  const off = await routeToEdge(new Request(`${base}/state`), undefined);
  assert.equal(off.status, 503);
  assert.equal(off.headers.get("x-g1t-edge"), "off");
});

test("a clone that finds the edge cold is answered 503 at once, and the edge starts in the background", async () => {
  for (const request of [
    new Request(`${base}/info/refs?service=git-upload-pack`),
    new Request(`${base}/git-upload-pack`, { method: "POST", body: "0032want …" }),
  ]) {
    const { edge, seen } = box(false);
    const answer = await answerEdge(request, edge);
    assert.equal(answer.status, 503);
    assert.equal(answer.headers.get("x-g1t-edge"), "cold");
    assert.equal(seen.forwarded.length, 0);
    assert.equal(seen.background.length, 1);
    await Promise.all(seen.background);
    assert.equal(seen.starts, 1);
  }
});

test("a background start that fails is logged, never thrown", async () => {
  const { edge, seen } = box(false);
  edge.start = async () => {
    throw new Error("There is no Container instance available at this time.");
  };
  const answer = await answerEdge(new Request(`${base}/info/refs?service=git-upload-pack`), edge);
  assert.equal(answer.status, 503);
  await Promise.all(seen.background);
  assert.equal(seen.logged.length, 1);
  assert.equal(seen.logged[0]![0], "git edge not started");
});

test("a clone of a running edge is passed to /git with its query, headers and body, and its answer streamed back", async () => {
  const { edge, seen } = box(true, () => {
    const pack = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("0008NAK\n"));
        controller.enqueue(new TextEncoder().encode("PACK…"));
        controller.close();
      },
    });
    return new Response(pack, { status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } });
  });
  const answer = await answerEdge(
    new Request(`${base}/git-upload-pack`, {
      method: "POST",
      headers: {
        "content-type": "application/x-git-upload-pack-request",
        "content-encoding": "gzip",
        "git-protocol": "version=2",
        "x-g1t-edge-version": "17",
      },
      body: "0032want 0123456789abcdef0123456789abcdef01234567\n",
    }),
    edge,
  );
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get("content-type"), "application/x-git-upload-pack-result");
  assert.equal(await answer.text(), "0008NAK\nPACK…");
  assert.equal(seen.starts, 0);
  assert.equal(seen.background.length, 0);
  const [sent] = seen.forwarded;
  assert.equal(sent!.method, "POST");
  assert.equal(new URL(sent!.url).pathname, "/git/git-upload-pack");
  assert.equal(sent!.headers.get("x-g1t-edge-version"), "17");
  assert.equal(sent!.headers.get("git-protocol"), "version=2");
  assert.equal(sent!.headers.get("content-encoding"), "gzip");
  assert.equal(sent!.headers.get("content-type"), "application/x-git-upload-pack-request");
  assert.equal(sent!.body, "0032want 0123456789abcdef0123456789abcdef01234567\n");

  const refs = box(true, () => new Response(null, { status: 409, headers: { "x-g1t-edge": "behind" } }));
  const behind = await answerEdge(
    new Request(`${base}/info/refs?service=git-upload-pack`, { headers: { "x-g1t-edge-version": "18", "git-protocol": "version=2" } }),
    refs.edge,
  );
  // What the container answers, as it answers it.
  assert.equal(behind.status, 409);
  assert.equal(behind.headers.get("x-g1t-edge"), "behind");
  const url = new URL(refs.seen.forwarded[0]!.url);
  assert.equal(url.pathname, "/git/info/refs");
  assert.equal(url.search, "?service=git-upload-pack");
  assert.equal(refs.seen.forwarded[0]!.method, "GET");
  assert.equal(refs.seen.forwarded[0]!.headers.get("x-g1t-edge-version"), "18");
});

test("a running edge that cannot be reached is a miss, not an error", async () => {
  const { edge, seen } = box(true);
  edge.forward = async () => {
    throw new Error("connection refused");
  };
  const answer = await answerEdge(new Request(`${base}/info/refs?service=git-upload-pack`), edge);
  assert.equal(answer.status, 502);
  assert.equal(answer.headers.get("x-g1t-edge"), "error");
  assert.equal(seen.logged.length, 1);
});

test("a sync starts the edge and waits for it, then passes the request to /sync", async () => {
  const order: string[] = [];
  const { edge, seen } = box(false, () => {
    order.push("forwarded");
    return new Response(null, { status: 202 });
  });
  const start = edge.start;
  edge.start = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await start();
    order.push("started");
  };
  const body = JSON.stringify({ remote: "https://x.artifacts.cloudflare.net/r.git", token: "t", version: 17, head: "refs/heads/main" });
  const answer = await answerEdge(new Request(`${base}/sync`, { method: "POST", headers: { "content-type": "application/json" }, body }), edge);
  assert.equal(answer.status, 202);
  assert.deepEqual(order, ["started", "forwarded"]);
  assert.equal(seen.starts, 1);
  assert.equal(new URL(seen.forwarded[0]!.url).pathname, "/sync");
  assert.equal(seen.forwarded[0]!.body, body);
  assert.equal(seen.forwarded[0]!.headers.get("content-type"), "application/json");

  // One that cannot start says so; nothing reaches a container.
  const failed = box(false);
  failed.edge.start = async () => {
    throw new Error("no instance");
  };
  const refused = await answerEdge(new Request(`${base}/sync`, { method: "POST", body }), failed.edge);
  assert.equal(refused.status, 503);
  assert.equal(refused.headers.get("x-g1t-edge"), "cold");
  assert.equal(failed.seen.forwarded.length, 0);
});

test("a cold edge's state says so and starts nothing; a running one's is the container's", async () => {
  const cold = box(false);
  const answer = await answerEdge(new Request(`${base}/state`), cold.edge);
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { version: null, cold: true });
  assert.equal(cold.seen.starts, 0);
  assert.equal(cold.seen.background.length, 0);

  const running = box(true, () => Response.json({ version: 17, syncing: false }));
  const state = await answerEdge(new Request(`${base}/state`), running.edge);
  assert.deepEqual(await state.json(), { version: 17, syncing: false });
  assert.equal(new URL(running.seen.forwarded[0]!.url).pathname, "/state");
});

test("an object asked for anything but its endpoints answers 404 and starts nothing", async () => {
  const { edge, seen } = box(false);
  for (const request of [
    new Request(`${base}/git-receive-pack`, { method: "POST", body: "x" }),
    new Request(`${base}/info/refs?service=git-receive-pack`),
    new Request(`https://runner/sync`, { method: "POST", body: "{}" }),
  ]) {
    assert.equal((await answerEdge(request, edge)).status, 404);
  }
  assert.equal(seen.starts, 0);
  assert.equal(seen.background.length, 0);
});
