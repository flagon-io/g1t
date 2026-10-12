import assert from "node:assert/strict";
import test from "node:test";

import { decodeLogs, decodeMetrics, decodeTraces, ProtoError } from "./proto.ts";

// A small protobuf writer, enough to build the messages SDKs send.
const varint = (n: bigint | number): number[] => {
  let v = BigInt(n);
  if (v < 0n) v = BigInt.asUintN(64, v);
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return out;
};
const key = (no: number, wire: number) => varint((no << 3) | wire);
const bytes = (no: number, b: number[] | Uint8Array) => [...key(no, 2), ...varint(b.length), ...b];
const str = (no: number, s: string) => bytes(no, [...new TextEncoder().encode(s)]);
const msg = (no: number, ...parts: number[][]) => bytes(no, parts.flat());
const vint = (no: number, n: number | bigint) => [...key(no, 0), ...varint(n)];
const fixed64 = (no: number, n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return [...key(no, 1), ...b];
};
const double = (no: number, n: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, n, true);
  return [...key(no, 1), ...b];
};
const hex = (h: string) => h.match(/../g)!.map((x) => parseInt(x, 16));
const kv = (no: number, k: string, value: number[]) => msg(no, str(1, k), msg(2, value));

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";

test("a trace export in protobuf reads as OTLP/JSON does", () => {
  const span = [
    ...bytes(1, hex(TRACE)),
    ...bytes(2, hex(SPAN)),
    ...str(5, "GET /users/:id"),
    ...vint(6, 2),
    ...fixed64(7, 1_760_000_000_000_000_000n),
    ...fixed64(8, 1_760_000_000_250_000_000n),
    ...kv(9, "http.response.status_code", vint(3, 200)),
    ...kv(9, "http.route", str(1, "/users/:id")),
    ...kv(9, "ratio", double(4, 0.5)),
    ...kv(9, "ok", vint(2, 1)),
    ...kv(9, "neg", vint(3, -5n)),
    ...msg(11, fixed64(1, 1_760_000_000_100_000_000n), str(2, "exception"), kv(3, "exception.type", str(1, "TypeError"))),
    ...msg(15, str(2, "boom"), vint(3, 2)),
    // A field this reader does not know is skipped.
    ...vint(99, 7),
  ];
  const request = msg(1, msg(1, kv(1, "service.name", str(1, "api"))), msg(2, msg(1, str(1, "scope")), msg(2, span)));
  const out = decodeTraces(Uint8Array.from(request));
  const s = out.resourceSpans![0].scopeSpans![0].spans![0];
  assert.equal(out.resourceSpans![0].resource!.attributes![0].key, "service.name");
  assert.equal(s.traceId, TRACE);
  assert.equal(s.spanId, SPAN);
  assert.equal(s.name, "GET /users/:id");
  assert.equal(s.kind, 2);
  assert.equal(s.startTimeUnixNano, "1760000000000000000");
  assert.equal(s.endTimeUnixNano, "1760000000250000000");
  assert.deepEqual(s.attributes![0], { key: "http.response.status_code", value: { intValue: "200" } });
  assert.deepEqual(s.attributes![2].value, { doubleValue: 0.5 });
  assert.deepEqual(s.attributes![3].value, { boolValue: true });
  assert.deepEqual(s.attributes![4].value, { intValue: "-5" });
  assert.equal(s.events![0].name, "exception");
  assert.deepEqual(s.status, { message: "boom", code: 2 });
});

test("logs and metrics in protobuf", () => {
  const record = [...fixed64(1, 1_760_000_000_000_000_000n), ...vint(2, 17), ...str(3, "ERROR"), ...msg(5, str(1, "it broke")), ...bytes(9, hex(TRACE))];
  const logs = decodeLogs(Uint8Array.from(msg(1, msg(2, msg(2, record)))));
  const r = logs.resourceLogs![0].scopeLogs![0].logRecords![0];
  assert.equal(r.severityNumber, 17);
  assert.deepEqual(r.body, { stringValue: "it broke" });
  assert.equal(r.traceId, TRACE);

  // A histogram with packed buckets and bounds.
  const counts = new Uint8Array(24);
  [1n, 2n, 3n].forEach((n, i) => new DataView(counts.buffer).setBigUint64(i * 8, n, true));
  const bounds = new Uint8Array(16);
  [10, 100].forEach((n, i) => new DataView(bounds.buffer).setFloat64(i * 8, n, true));
  const point = [...fixed64(3, 1_760_000_000_000_000_000n), ...fixed64(4, 6n), ...double(5, 300), ...bytes(6, counts), ...bytes(7, bounds)];
  const gauge = msg(5, msg(1, fixed64(3, 1_760_000_000_000_000_000n), double(4, 42)));
  const metrics = decodeMetrics(
    Uint8Array.from(msg(1, msg(2, msg(2, str(1, "http.server.duration"), str(3, "ms"), msg(9, msg(1, point), vint(2, 2))), msg(2, str(1, "queue.depth"), gauge)))),
  );
  const [h, g] = metrics.resourceMetrics![0].scopeMetrics![0].metrics!;
  assert.equal(h.name, "http.server.duration");
  assert.deepEqual(h.histogram!.dataPoints![0].bucketCounts, ["1", "2", "3"]);
  assert.deepEqual(h.histogram!.dataPoints![0].explicitBounds, [10, 100]);
  assert.equal(h.histogram!.aggregationTemporality, 2);
  assert.equal(g.gauge!.dataPoints![0].asDouble, 42);
});

test("a message cut short is refused, not read as garbage", () => {
  assert.throws(() => decodeTraces(Uint8Array.from([0x0a, 0x10, 0x01])), ProtoError);
});
