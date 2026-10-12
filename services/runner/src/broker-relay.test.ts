import assert from "node:assert/strict";
import { test } from "node:test";

import type { BrokeredSecret } from "@g1t/contracts";

import {
  ANSWER_HEADER,
  MAX_REQUEST_BYTES,
  REQUEST_HEADER,
  type RelayDeps,
  answerHeaders,
  capped,
  readCapped,
  readRelayed,
  relay,
  replaceBytes,
  scrubStream,
  scrubbedType,
} from "./broker-relay.ts";

const NPM: BrokeredSecret = {
  standIn: `g1tsec_${"a".repeat(48)}`,
  name: "NPM_TOKEN",
  value: "npm_realvalue123",
  hosts: ["registry.npmjs.org"],
};

const b64 = (value: unknown) => btoa(JSON.stringify(value));

function brokerRequest(
  wanted: { method?: string; url: string; headers?: [string, string][] },
  options: { token?: string; job?: string; body?: BodyInit; header?: string } = {},
): Request {
  const headers = new Headers({ "x-g1t-broker-job": options.job ?? "job_1" });
  if (options.token !== "") headers.set("authorization", `Bearer ${options.token ?? "current"}`);
  headers.set(REQUEST_HEADER, options.header ?? b64({ method: wanted.method ?? "GET", url: wanted.url, headers: wanted.headers ?? [] }));
  return new Request("https://runner/rpc/broker", { method: "POST", headers, body: options.body });
}

type Seen = { sent: Request[]; notes: string[] };

function deps(answer: (request: Request) => Response, secrets: BrokeredSecret[] | null = [NPM]): RelayDeps & { seen: Seen } {
  const seen: Seen = { sent: [], notes: [] };
  return {
    seen,
    async secrets(_job, token) {
      return token === "current" ? secrets : null;
    },
    async note(_job, _token, text) {
      seen.notes.push(text);
    },
    async send(request) {
      seen.sent.push(request);
      return answer(request);
    },
  };
}

function answerOf(response: Response): { status: number; headers: [string, string][] } {
  return JSON.parse(atob(response.headers.get(ANSWER_HEADER) ?? ""));
}

test("a request carrying a stand-in for its host is filled in, sent, and its answer scrubbed", async () => {
  const d = deps(
    (request) =>
      new Response(`{"token":"${request.headers.get("authorization")?.slice(7)}"}`, {
        status: 201,
        headers: { "content-type": "application/json", "x-echo": "npm_realvalue123", "content-encoding": "gzip" },
      }),
  );
  const response = await relay(
    brokerRequest({ url: "https://registry.npmjs.org/pkg", headers: [["authorization", `Bearer ${NPM.standIn}`], ["connection", "keep-alive"]] }),
    d,
  );
  assert.equal(response.status, 200);
  assert.equal(d.seen.sent.length, 1);
  const sent = d.seen.sent[0];
  assert.equal(sent.headers.get("authorization"), "Bearer npm_realvalue123");
  assert.equal(sent.headers.get("connection"), null, "the connection's own headers go no further");
  assert.equal(sent.redirect, "manual");
  const answer = answerOf(response);
  assert.equal(answer.status, 201);
  assert.deepEqual(Object.fromEntries(answer.headers)["x-echo"], NPM.standIn);
  assert.equal(Object.fromEntries(answer.headers)["content-encoding"], undefined, "the body is relayed decoded");
  const body = await response.text();
  assert.equal(body, `{"token":"${NPM.standIn}"}`);
  assert.ok(!JSON.stringify(answer).includes(NPM.value) && !body.includes(NPM.value));
  assert.deepEqual(d.seen.notes, []);
});

test("a body is relayed, and one past the limit is refused", async () => {
  const d = deps(async () => new Response(null, { status: 204 }));
  const ok = await relay(
    brokerRequest({ method: "PUT", url: "https://registry.npmjs.org/pkg", headers: [["authorization", `Bearer ${NPM.standIn}`]] }, { body: "tarball" }),
    d,
  );
  assert.equal(answerOf(ok).status, 204);
  assert.equal(await d.seen.sent[0].text(), "tarball");
  const big = new Uint8Array(MAX_REQUEST_BYTES + 1);
  const tooBig = await relay(
    brokerRequest({ method: "PUT", url: "https://registry.npmjs.org/pkg", headers: [["authorization", `Bearer ${NPM.standIn}`]] }, { body: big }),
    d,
  );
  assert.equal(tooBig.status, 413);
  assert.equal(d.seen.sent.length, 1, "nothing more was sent");
});

test("it is no open proxy: no stand-in, another host, or plain HTTP is refused and noted", async () => {
  const d = deps(() => new Response("never"));
  const none = await relay(brokerRequest({ url: "https://registry.npmjs.org/pkg" }), d);
  assert.equal(none.status, 403);
  assert.equal(none.headers.get(ANSWER_HEADER), null);
  const elsewhere = await relay(brokerRequest({ url: "https://evil.example/steal", headers: [["authorization", `Bearer ${NPM.standIn}`]] }), d);
  assert.equal(elsewhere.status, 403);
  const plain = await relay(brokerRequest({ url: "http://registry.npmjs.org/pkg", headers: [["authorization", `Bearer ${NPM.standIn}`]] }), d);
  assert.equal(plain.status, 403);
  assert.equal(d.seen.sent.length, 0);
  assert.equal(d.seen.notes.length, 3);
  assert.match(d.seen.notes[0], /without a stand-in/);
  assert.match(d.seen.notes[1], /NPM_TOKEN was sent to evil\.example/);
  // Once per secret and host.
  await relay(brokerRequest({ url: "https://evil.example/again", headers: [["authorization", `Bearer ${NPM.standIn}`]] }), d);
  assert.equal(d.seen.notes.length, 3);
});

test("only the job's current token opens it, and it must come as a header", async () => {
  const d = deps(() => new Response("never"));
  const wanted = { url: "https://registry.npmjs.org/pkg", headers: [["authorization", `Bearer ${NPM.standIn}`]] as [string, string][] };
  assert.equal((await relay(brokerRequest(wanted, { token: "spent" }), d)).status, 401);
  assert.equal((await relay(brokerRequest(wanted, { token: "" }), d)).status, 401);
  assert.equal((await relay(brokerRequest(wanted, { header: "not base64 json" }), d)).status, 400);
  assert.equal((await relay(brokerRequest({ ...wanted, method: "CONNECT" }), d)).status, 400);
  assert.equal(d.seen.sent.length, 0);
});

test("a request has a time limit", async () => {
  const d = deps(() => new Response("ok"));
  await relay(brokerRequest({ url: "https://registry.npmjs.org/pkg", headers: [["authorization", `Bearer ${NPM.standIn}`]] }), d);
  assert.ok(d.seen.sent[0].signal instanceof AbortSignal);
});

test("an answer past the limit is refused by its length, or cut off as it streams", async () => {
  const d = deps(() => new Response("x", { headers: { "content-length": String(2 * 1024 * 1024 * 1024) } }));
  const response = await relay(brokerRequest({ url: "https://registry.npmjs.org/pkg", headers: [["authorization", `Bearer ${NPM.standIn}`]] }), d);
  assert.equal(response.status, 502);
  const cut = new Response(new Blob(["12345"]).stream().pipeThrough(capped(3)));
  await assert.rejects(cut.text());
});

test("a value split across chunks is still scrubbed, and other bytes pass as they are", async () => {
  const pairs = [{ from: new TextEncoder().encode("secret"), to: new TextEncoder().encode("STAND") }];
  const one = replaceBytes(new TextEncoder().encode("a secret here"), pairs, true);
  assert.equal(new TextDecoder().decode(one.out), "a STAND here");
  // The last bytes that could begin a value wait for the next chunk.
  const held = replaceBytes(new TextEncoder().encode("xx sec"), pairs, false);
  assert.equal(new TextDecoder().decode(held.out), "x");
  assert.equal(new TextDecoder().decode(held.rest), "x sec");

  const chunks = ["{\"t\":\"npm_real", "value123\",\"u\":\"npm_", "realvalue123\"}"];
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  const text = await new Response(source.pipeThrough(scrubStream([NPM]))).text();
  assert.equal(text, `{"t":"${NPM.standIn}","u":"${NPM.standIn}"}`);
});

test("text bodies are scrubbed whatever their size; binary ones stream as they are", () => {
  assert.ok(scrubbedType(new Headers({ "content-type": "application/json; charset=utf-8" })));
  assert.ok(scrubbedType(new Headers({ "content-type": "text/html" })));
  assert.ok(scrubbedType(new Headers({ "content-type": "application/vnd.api+json" })));
  assert.ok(scrubbedType(new Headers()));
  assert.ok(!scrubbedType(new Headers({ "content-type": "application/octet-stream" })));
  assert.ok(!scrubbedType(new Headers({ "content-type": "application/gzip" })));
});

test("the request reads only in its own shape, and answer headers keep each cookie", async () => {
  assert.deepEqual(readRelayed(b64({ method: "get", url: "https://a.example/", headers: [["a", "1"]] })), {
    method: "GET",
    url: "https://a.example/",
    headers: [["a", "1"]],
  });
  assert.equal(readRelayed(b64({ method: "GET", url: "https://a.example/", headers: [["a", 1]] })), null);
  assert.equal(readRelayed(null), null);
  const headers = new Headers({ "content-type": "text/plain", "transfer-encoding": "chunked" });
  headers.append("set-cookie", "a=1");
  headers.append("set-cookie", "b=2");
  assert.deepEqual(answerHeaders(headers), [
    ["content-type", "text/plain"],
    ["set-cookie", "a=1"],
    ["set-cookie", "b=2"],
  ]);
  assert.deepEqual(await readCapped(new Blob(["abc"]).stream(), 3), new TextEncoder().encode("abc"));
  assert.equal(await readCapped(new Blob(["abcd"]).stream(), 3), null);
});
