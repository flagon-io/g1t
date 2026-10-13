import assert from "node:assert/strict";
import { test } from "node:test";

import { BUFFERED_MAX_BYTES, RETRY_WAITS_MS, bufferable, forward, resumeFrom } from "./forward.ts";

/** A fetch that throws `failures` times, then answers 200; it counts its calls. */
function flaky(failures: number) {
  const calls: Request[] = [];
  const send = async (request: Request) => {
    calls.push(request);
    if (calls.length <= failures) throw new Error("Network connection lost.");
    return new Response("ok");
  };
  return { calls, send };
}

const waits: number[] = [];
const sleep = async (ms: number) => {
  waits.push(ms);
};

test("a GET that fails is tried again, and its answer comes back", async () => {
  waits.length = 0;
  const { calls, send } = flaky(2);
  const response = await forward(new Request("https://registry.npmjs.org/react"), send, sleep);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [...RETRY_WAITS_MS]);
});

test("one that keeps failing gets a 502 naming the host and why, never a throw", async () => {
  const { calls, send } = flaky(10);
  const response = await forward(new Request("https://Registry.npmjs.org:443/react"), send, sleep);
  assert.equal(calls.length, 3);
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("x-g1t-egress"), "upstream-failed");
  assert.match(response.headers.get("content-type") ?? "", /^text\/plain/);
  const body = await response.text();
  assert.match(body, /registry\.npmjs\.org could not be reached/);
  assert.match(body, /Network connection lost\./);
});

test("a POST is never sent twice", async () => {
  const { calls, send } = flaky(1);
  const response = await forward(new Request("https://api.example.com/upload", { method: "POST", body: "data" }), send, sleep);
  assert.equal(calls.length, 1);
  assert.equal(response.status, 502);
});

test("an answer, even an error, is passed on as it is", async () => {
  const response = await forward(new Request("https://example.com/"), async () => new Response("no", { status: 503 }), sleep);
  assert.equal(response.status, 503);
});

/** A tarball's answer whose body breaks off after its first chunk, as an upstream that drops mid-body does. */
function brokenOff(length: number): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(16));
      controller.error(new Error("aborted"));
    },
  });
  return new Response(body, { headers: { "content-length": String(length), "content-type": "application/octet-stream" } });
}

test("a body that breaks off midway is tried again, and the whole answer comes back", async () => {
  let calls = 0;
  const send = async () => {
    calls += 1;
    return calls === 1 ? brokenOff(1024) : new Response(new Uint8Array(1024), { headers: { "content-length": "1024" } });
  };
  const response = await forward(new Request("https://registry.npmjs.org/react/-/react-19.0.0.tgz"), send, sleep);
  assert.equal(calls, 2);
  assert.equal(response.status, 200);
  assert.equal((await response.arrayBuffer()).byteLength, 1024);
});

test("a body that keeps breaking off ends as a 502, not a truncated answer", async () => {
  let calls = 0;
  const response = await forward(
    new Request("https://registry.npmjs.org/x.tgz"),
    async () => {
      calls += 1;
      return brokenOff(1024);
    },
    sleep,
  );
  assert.equal(calls, 3);
  assert.equal(response.status, 502);
});

test("large, compressed or unsized answers stream as they come", () => {
  const sized = (length: number, headers: Record<string, string> = {}) => new Response("x", { headers: { "content-length": String(length), ...headers } });
  assert.equal(bufferable(sized(1024)), true);
  assert.equal(bufferable(sized(BUFFERED_MAX_BYTES + 1)), false);
  assert.equal(bufferable(sized(1024, { "content-encoding": "gzip" })), false);
  assert.equal(bufferable(new Response(new ReadableStream())), false);
  assert.equal(bufferable(new Response(null, { status: 304 })), false);
});

/** A file larger than is read whole, served by an upstream that takes byte ranges. */
const LARGE = BUFFERED_MAX_BYTES + 4096;
const file = Uint8Array.from({ length: LARGE }, (_, i) => (i * 7) % 251);
const ETAG = '"0136d6b610a8ef0251f65aecb4c9fc24"';

/** A body of `bytes` that breaks off after `cut` of them (null: sent whole), in chunks as a network body comes. */
function breaking(bytes: Uint8Array, cut: number | null): ReadableStream<Uint8Array> {
  const end = cut ?? bytes.length;
  let at = 0;
  // Pulled a chunk at a time: an error in `start` would drop what was queued before it.
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at < end) {
        controller.enqueue(bytes.slice(at, Math.min(at + 65536, end)));
        at += 65536;
      } else if (cut === null) controller.close();
      else controller.error(new Error("aborted"));
    },
  });
}

/**
 * An upstream for `file`: each answer in turn breaks off after the byte
 * of the file given in `cuts` (null: sent whole). A range request with the
 * file's ETag gets a `206` with the rest, as registry.npmjs.org answers
 * one, unless `ranges` is false.
 */
function rangedUpstream(cuts: (number | null)[], options: { ranges?: boolean } = {}) {
  const requests: Request[] = [];
  const send = async (request: Request) => {
    requests.push(request);
    const cut = cuts[requests.length - 1] ?? null;
    const range = /^bytes=(\d+)-$/.exec(request.headers.get("range") ?? "");
    if (range && options.ranges !== false && request.headers.get("if-range") === ETAG) {
      const start = Number(range[1]);
      const rest = file.slice(start);
      return new Response(breaking(rest, cut === null ? null : cut - start), {
        status: 206,
        headers: { "content-length": String(rest.length), "content-range": `bytes ${start}-${LARGE - 1}/${LARGE}`, "accept-ranges": "bytes", etag: ETAG },
      });
    }
    return new Response(breaking(file, cut), {
      headers: { "content-length": String(LARGE), "content-type": "application/octet-stream", "accept-ranges": "bytes", etag: ETAG },
    });
  };
  return { requests, send };
}

const tarball = () =>
  new Request("https://registry.npmjs.org/@pagefind/linux-x64/-/linux-x64-1.5.2.tgz", { headers: { "user-agent": "npm/11" } });

test("a large tarball that breaks off midway is resumed from where it stopped, and arrives whole", async () => {
  waits.length = 0;
  const { requests, send } = rangedUpstream([3_000_000, 6_000_000, null]);
  const response = await forward(tarball(), send, sleep);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), String(LARGE));
  const body = new Uint8Array(await response.arrayBuffer());
  assert.equal(body.length, LARGE);
  assert.deepEqual(body, file);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].headers.get("range"), null);
  assert.equal(requests[1].headers.get("range"), "bytes=3000000-");
  assert.equal(requests[2].headers.get("range"), "bytes=6000000-");
  assert.equal(requests[1].headers.get("if-range"), ETAG);
  assert.equal(requests[2].headers.get("user-agent"), "npm/11");
  assert.deepEqual(waits, [...RETRY_WAITS_MS]);
});

test("a large tarball sent whole streams as it is, asked for once", async () => {
  const { requests, send } = rangedUpstream([null]);
  const response = await forward(tarball(), send, sleep);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), file);
  assert.equal(requests.length, 1);
});

test("a body that ends short of its length is resumed too", async () => {
  const upstream = rangedUpstream([null]);
  let calls = 0;
  const send = async (request: Request) => {
    calls += 1;
    if (calls > 1) return upstream.send(request);
    return new Response(breaking(file.slice(0, 1_000_000), null), {
      headers: { "content-length": String(LARGE), "accept-ranges": "bytes", etag: ETAG },
    });
  };
  const response = await forward(tarball(), send, sleep);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), file);
  assert.equal(calls, 2);
  assert.equal(upstream.requests[0].headers.get("range"), "bytes=1000000-");
});

test("a body that keeps breaking off errors after its resumptions, never handing on a short answer as whole", async () => {
  const { requests, send } = rangedUpstream([1_000_000, 2_000_000, 3_000_000]);
  const response = await forward(tarball(), send, sleep);
  await assert.rejects(response.arrayBuffer());
  assert.equal(requests.length, 1 + RETRY_WAITS_MS.length);
});

test("a resumption that fails to connect is tried again", async () => {
  const upstream = rangedUpstream([2_000_000, null]);
  let calls = 0;
  const send = async (request: Request) => {
    calls += 1;
    if (calls === 2) throw new Error("Network connection lost.");
    return upstream.send(request);
  };
  const response = await forward(tarball(), send, sleep);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), file);
  assert.equal(calls, 3);
});

test("no rest is joined on when the host answers a range with the whole file", async () => {
  const { requests, send } = rangedUpstream([1_000_000, null], { ranges: false });
  const response = await forward(tarball(), send, sleep);
  await assert.rejects(response.arrayBuffer());
  assert.equal(requests.length, 2);
});

test("only a whole, plain answer to a GET, from a host that takes ranges, is resumable", () => {
  const get = new Request("https://registry.npmjs.org/x.tgz");
  const answer = (headers: Record<string, string>, status = 200) =>
    new Response("x", { status, headers: { "content-length": "1", "accept-ranges": "bytes", etag: ETAG, ...headers } });
  assert.deepEqual(resumeFrom(get, answer({})), { validator: ETAG, length: 1 });
  const modified = "Thu, 16 Apr 2026 23:38:31 GMT";
  assert.deepEqual(resumeFrom(get, answer({ etag: 'W/"weak"', "last-modified": modified })), { validator: modified, length: 1 });
  assert.equal(resumeFrom(get, answer({ etag: 'W/"weak"' })), null);
  assert.equal(resumeFrom(get, answer({ "accept-ranges": "none" })), null);
  assert.equal(resumeFrom(get, answer({ "content-encoding": "gzip" })), null);
  assert.equal(resumeFrom(get, answer({}, 206)), null);
  assert.equal(resumeFrom(new Request(get.url, { headers: { range: "bytes=0-" } }), answer({})), null);
  assert.equal(resumeFrom(new Request(get.url, { method: "HEAD" }), answer({})), null);
});
