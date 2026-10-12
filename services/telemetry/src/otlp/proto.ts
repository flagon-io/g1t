/**
 * OTLP over HTTP in protobuf (`application/x-protobuf`), the encoding most
 * OpenTelemetry SDKs send by default, read into the shape OTLP/JSON has
 * (opentelemetry-proto's JSON mapping: ids as hex, 64-bit integers and
 * nanosecond times as decimal strings, enums as numbers). Both encodings
 * then go through one reader (./normalize.ts).
 *
 * Only the messages of the three export requests are read; fields this
 * does not know are skipped, as protobuf allows, so a newer SDK still
 * gets through. No code generation, no dependency: a protobuf message is
 * a list of (field number, wire type, value), and each reader below picks
 * the fields it wants.
 */

/** A value read off the wire, before it is known what the field means. */
type Field =
  | { no: number; wire: 0; value: bigint }
  | { no: number; wire: 1; value: Uint8Array }
  | { no: number; wire: 2; value: Uint8Array }
  | { no: number; wire: 5; value: Uint8Array };

export class ProtoError extends Error {}

const utf8 = new TextDecoder("utf-8");

/** Splits one message into its fields, in order. */
export function fields(bytes: Uint8Array): Field[] {
  const out: Field[] = [];
  let at = 0;
  const varint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (at >= bytes.length) throw new ProtoError("The message ends inside a number.");
      const byte = bytes[at++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 70n) throw new ProtoError("A number is longer than ten bytes.");
    }
  };
  const take = (n: number): Uint8Array => {
    if (n < 0 || at + n > bytes.length) throw new ProtoError("A field runs past the end of the message.");
    const slice = bytes.subarray(at, at + n);
    at += n;
    return slice;
  };
  while (at < bytes.length) {
    const key = Number(varint());
    const no = key >>> 3;
    const wire = key & 7;
    if (no === 0) throw new ProtoError("A field numbered 0.");
    switch (wire) {
      case 0:
        out.push({ no, wire, value: varint() });
        break;
      case 1:
        out.push({ no, wire, value: take(8) });
        break;
      case 2:
        out.push({ no, wire, value: take(Number(varint())) });
        break;
      case 5:
        out.push({ no, wire, value: take(4) });
        break;
      default:
        throw new ProtoError(`Wire type ${wire} is not one OTLP uses.`);
    }
  }
  return out;
}

// ---- Scalars -------------------------------------------------------------

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

const fixed64 = (b: Uint8Array): bigint => view(b).getBigUint64(0, true);
const sfixed64 = (b: Uint8Array): bigint => view(b).getBigInt64(0, true);
const double = (b: Uint8Array): number => view(b).getFloat64(0, true);
const str = (b: Uint8Array): string => utf8.decode(b);
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
/** A varint as a signed 64-bit two's-complement number (int64). */
const int64 = (v: bigint): bigint => BigInt.asIntN(64, v);

/** Base64, for `bytes` values, as the JSON mapping writes them. */
function base64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/** A repeated fixed64 or double field, packed (wire type 2) or not. */
function packed64(list: Field[], no: number, read: (b: Uint8Array) => number | bigint): (number | bigint)[] {
  const out: (number | bigint)[] = [];
  for (const f of list) {
    if (f.no !== no) continue;
    if (f.wire === 1) out.push(read(f.value));
    else if (f.wire === 2) for (let i = 0; i + 8 <= f.value.length; i += 8) out.push(read(f.value.subarray(i, i + 8)));
  }
  return out;
}

// ---- Common --------------------------------------------------------------

export type AnyValueJson =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: AnyValueJson[] } }
  | { kvlistValue: { values: KeyValueJson[] } }
  | { bytesValue: string }
  | Record<string, never>;

export type KeyValueJson = { key: string; value?: AnyValueJson };

function anyValue(b: Uint8Array): AnyValueJson {
  for (const f of fields(b)) {
    if (f.no === 1 && f.wire === 2) return { stringValue: str(f.value) };
    if (f.no === 2 && f.wire === 0) return { boolValue: f.value !== 0n };
    if (f.no === 3 && f.wire === 0) return { intValue: int64(f.value).toString() };
    if (f.no === 4 && f.wire === 1) return { doubleValue: double(f.value) };
    if (f.no === 5 && f.wire === 2) return { arrayValue: { values: repeated(fields(f.value), 1, anyValue) } };
    if (f.no === 6 && f.wire === 2) return { kvlistValue: { values: repeated(fields(f.value), 1, keyValue) } };
    if (f.no === 7 && f.wire === 2) return { bytesValue: base64(f.value) };
  }
  return {};
}

function keyValue(b: Uint8Array): KeyValueJson {
  const kv: KeyValueJson = { key: "" };
  for (const f of fields(b)) {
    if (f.no === 1 && f.wire === 2) kv.key = str(f.value);
    else if (f.no === 2 && f.wire === 2) kv.value = anyValue(f.value);
  }
  return kv;
}

function repeated<T>(list: Field[], no: number, read: (b: Uint8Array) => T): T[] {
  const out: T[] = [];
  for (const f of list) if (f.no === no && f.wire === 2) out.push(read(f.value));
  return out;
}

function one<T>(list: Field[], no: number, read: (b: Uint8Array) => T): T | undefined {
  let found: T | undefined;
  for (const f of list) if (f.no === no && f.wire === 2) found = read(f.value);
  return found;
}

function string(list: Field[], no: number): string | undefined {
  return one(list, no, str);
}

function varintField(list: Field[], no: number): bigint | undefined {
  let found: bigint | undefined;
  for (const f of list) if (f.no === no && f.wire === 0) found = f.value;
  return found;
}

function fixed64Field(list: Field[], no: number): string | undefined {
  let found: string | undefined;
  for (const f of list) if (f.no === no && f.wire === 1) found = fixed64(f.value).toString();
  return found;
}

function doubleField(list: Field[], no: number): number | undefined {
  let found: number | undefined;
  for (const f of list) if (f.no === no && f.wire === 1) found = double(f.value);
  return found;
}

function bytesHex(list: Field[], no: number): string | undefined {
  return one(list, no, hex);
}

export type ResourceJson = { attributes?: KeyValueJson[] };
export type ScopeJson = { name?: string; version?: string; attributes?: KeyValueJson[] };

function resource(b: Uint8Array): ResourceJson {
  return { attributes: repeated(fields(b), 1, keyValue) };
}

function scope(b: Uint8Array): ScopeJson {
  const f = fields(b);
  return { name: string(f, 1), version: string(f, 2), attributes: repeated(f, 3, keyValue) };
}

// ---- Traces --------------------------------------------------------------

export type SpanJson = {
  traceId?: string;
  spanId?: string;
  traceState?: string;
  parentSpanId?: string;
  name?: string;
  kind?: number;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes?: KeyValueJson[];
  events?: { timeUnixNano?: string; name?: string; attributes?: KeyValueJson[] }[];
  links?: { traceId?: string; spanId?: string; attributes?: KeyValueJson[] }[];
  status?: { message?: string; code?: number };
};

export type TracesRequestJson = {
  resourceSpans?: { resource?: ResourceJson; scopeSpans?: { scope?: ScopeJson; spans?: SpanJson[] }[] }[];
};

function span(b: Uint8Array): SpanJson {
  const f = fields(b);
  const kind = varintField(f, 6);
  return {
    traceId: bytesHex(f, 1),
    spanId: bytesHex(f, 2),
    traceState: string(f, 3),
    parentSpanId: bytesHex(f, 4),
    name: string(f, 5),
    kind: kind === undefined ? undefined : Number(kind),
    startTimeUnixNano: fixed64Field(f, 7),
    endTimeUnixNano: fixed64Field(f, 8),
    attributes: repeated(f, 9, keyValue),
    events: repeated(f, 11, (e) => {
      const ef = fields(e);
      return { timeUnixNano: fixed64Field(ef, 1), name: string(ef, 2), attributes: repeated(ef, 3, keyValue) };
    }),
    links: repeated(f, 13, (l) => {
      const lf = fields(l);
      return { traceId: bytesHex(lf, 1), spanId: bytesHex(lf, 2), attributes: repeated(lf, 4, keyValue) };
    }),
    status: one(f, 15, (s) => {
      const sf = fields(s);
      const code = varintField(sf, 3);
      return { message: string(sf, 2), code: code === undefined ? undefined : Number(code) };
    }),
  };
}

export function decodeTraces(bytes: Uint8Array): TracesRequestJson {
  return {
    resourceSpans: repeated(fields(bytes), 1, (rs) => {
      const f = fields(rs);
      return {
        resource: one(f, 1, resource),
        scopeSpans: repeated(f, 2, (ss) => {
          const sf = fields(ss);
          return { scope: one(sf, 1, scope), spans: repeated(sf, 2, span) };
        }),
      };
    }),
  };
}

// ---- Logs ----------------------------------------------------------------

export type LogRecordJson = {
  timeUnixNano?: string;
  observedTimeUnixNano?: string;
  severityNumber?: number;
  severityText?: string;
  body?: AnyValueJson;
  attributes?: KeyValueJson[];
  traceId?: string;
  spanId?: string;
  eventName?: string;
};

export type LogsRequestJson = {
  resourceLogs?: { resource?: ResourceJson; scopeLogs?: { scope?: ScopeJson; logRecords?: LogRecordJson[] }[] }[];
};

function logRecord(b: Uint8Array): LogRecordJson {
  const f = fields(b);
  const severity = varintField(f, 2);
  return {
    timeUnixNano: fixed64Field(f, 1),
    observedTimeUnixNano: fixed64Field(f, 11),
    severityNumber: severity === undefined ? undefined : Number(severity),
    severityText: string(f, 3),
    body: one(f, 5, anyValue),
    attributes: repeated(f, 6, keyValue),
    traceId: bytesHex(f, 9),
    spanId: bytesHex(f, 10),
    eventName: string(f, 12),
  };
}

export function decodeLogs(bytes: Uint8Array): LogsRequestJson {
  return {
    resourceLogs: repeated(fields(bytes), 1, (rl) => {
      const f = fields(rl);
      return {
        resource: one(f, 1, resource),
        scopeLogs: repeated(f, 2, (sl) => {
          const sf = fields(sl);
          return { scope: one(sf, 1, scope), logRecords: repeated(sf, 2, logRecord) };
        }),
      };
    }),
  };
}

// ---- Metrics -------------------------------------------------------------

export type NumberPointJson = {
  attributes?: KeyValueJson[];
  startTimeUnixNano?: string;
  timeUnixNano?: string;
  asDouble?: number;
  asInt?: string;
};

export type HistogramPointJson = {
  attributes?: KeyValueJson[];
  startTimeUnixNano?: string;
  timeUnixNano?: string;
  count?: string;
  sum?: number;
  bucketCounts?: string[];
  explicitBounds?: number[];
  min?: number;
  max?: number;
};

export type SummaryPointJson = {
  attributes?: KeyValueJson[];
  startTimeUnixNano?: string;
  timeUnixNano?: string;
  count?: string;
  sum?: number;
  quantileValues?: { quantile?: number; value?: number }[];
};

export type MetricJson = {
  name?: string;
  description?: string;
  unit?: string;
  gauge?: { dataPoints?: NumberPointJson[] };
  sum?: { dataPoints?: NumberPointJson[]; aggregationTemporality?: number; isMonotonic?: boolean };
  histogram?: { dataPoints?: HistogramPointJson[]; aggregationTemporality?: number };
  /** Read as its count, sum, min and max: the buckets are not kept. */
  exponentialHistogram?: { dataPoints?: HistogramPointJson[]; aggregationTemporality?: number };
  summary?: { dataPoints?: SummaryPointJson[] };
};

export type MetricsRequestJson = {
  resourceMetrics?: { resource?: ResourceJson; scopeMetrics?: { scope?: ScopeJson; metrics?: MetricJson[] }[] }[];
};

function numberPoint(b: Uint8Array): NumberPointJson {
  const f = fields(b);
  const point: NumberPointJson = {
    attributes: repeated(f, 7, keyValue),
    startTimeUnixNano: fixed64Field(f, 2),
    timeUnixNano: fixed64Field(f, 3),
  };
  for (const x of f) {
    if (x.no === 4 && x.wire === 1) point.asDouble = double(x.value);
    if (x.no === 6 && x.wire === 1) point.asInt = sfixed64(x.value).toString();
  }
  return point;
}

function histogramPoint(b: Uint8Array): HistogramPointJson {
  const f = fields(b);
  return {
    attributes: repeated(f, 9, keyValue),
    startTimeUnixNano: fixed64Field(f, 2),
    timeUnixNano: fixed64Field(f, 3),
    count: fixed64Field(f, 4),
    sum: doubleField(f, 5),
    bucketCounts: packed64(f, 6, fixed64).map(String),
    explicitBounds: packed64(f, 7, double) as number[],
    min: doubleField(f, 11),
    max: doubleField(f, 12),
  };
}

function exponentialPoint(b: Uint8Array): HistogramPointJson {
  const f = fields(b);
  return {
    attributes: repeated(f, 1, keyValue),
    startTimeUnixNano: fixed64Field(f, 2),
    timeUnixNano: fixed64Field(f, 3),
    count: fixed64Field(f, 4),
    sum: doubleField(f, 5),
    min: doubleField(f, 12),
    max: doubleField(f, 13),
  };
}

function summaryPoint(b: Uint8Array): SummaryPointJson {
  const f = fields(b);
  return {
    attributes: repeated(f, 7, keyValue),
    startTimeUnixNano: fixed64Field(f, 2),
    timeUnixNano: fixed64Field(f, 3),
    count: fixed64Field(f, 4),
    sum: doubleField(f, 5),
    quantileValues: repeated(f, 6, (q) => {
      const qf = fields(q);
      return { quantile: doubleField(qf, 1), value: doubleField(qf, 2) };
    }),
  };
}

function metric(b: Uint8Array): MetricJson {
  const f = fields(b);
  const out: MetricJson = { name: string(f, 1), description: string(f, 2), unit: string(f, 3) };
  const temporality = (list: Field[]) => {
    const t = varintField(list, 2);
    return t === undefined ? undefined : Number(t);
  };
  const g = one(f, 5, (x) => x);
  if (g) out.gauge = { dataPoints: repeated(fields(g), 1, numberPoint) };
  const s = one(f, 7, (x) => x);
  if (s) {
    const sf = fields(s);
    out.sum = { dataPoints: repeated(sf, 1, numberPoint), aggregationTemporality: temporality(sf), isMonotonic: varintField(sf, 3) === 1n };
  }
  const h = one(f, 9, (x) => x);
  if (h) {
    const hf = fields(h);
    out.histogram = { dataPoints: repeated(hf, 1, histogramPoint), aggregationTemporality: temporality(hf) };
  }
  const e = one(f, 10, (x) => x);
  if (e) {
    const ef = fields(e);
    out.exponentialHistogram = { dataPoints: repeated(ef, 1, exponentialPoint), aggregationTemporality: temporality(ef) };
  }
  const q = one(f, 11, (x) => x);
  if (q) out.summary = { dataPoints: repeated(fields(q), 1, summaryPoint) };
  return out;
}

export function decodeMetrics(bytes: Uint8Array): MetricsRequestJson {
  return {
    resourceMetrics: repeated(fields(bytes), 1, (rm) => {
      const f = fields(rm);
      return {
        resource: one(f, 1, resource),
        scopeMetrics: repeated(f, 2, (sm) => {
          const sf = fields(sm);
          return { scope: one(sf, 1, scope), metrics: repeated(sf, 2, metric) };
        }),
      };
    }),
  };
}
