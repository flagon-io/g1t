/**
 * Reading an OTLP/HTTP request: its token, its encoding (JSON or
 * protobuf, gzipped or not) and its signal, into a batch. And what OTLP
 * expects back.
 */
import { TELEMETRY_TOKEN_PREFIX } from "@g1t/contracts/telemetry";

import type { Batch } from "../batch.ts";
import { readLogs, readMetrics, readTraces, type Door } from "./normalize.ts";
import { ProtoError, decodeLogs, decodeMetrics, decodeTraces } from "./proto.ts";

export type Signal = "traces" | "logs" | "metrics";

/** A request body is at most this many bytes as sent, and this many once unzipped. */
export const MAX_BODY = 8 * 1024 * 1024;
export const MAX_DECODED = 32 * 1024 * 1024;

export class IngestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * The token a request carries: `Authorization: Bearer <token>` (what
 * `OTEL_EXPORTER_OTLP_HEADERS` sets), or `x-g1t-token`.
 */
export function tokenOf(request: Request): string | null {
  const auth = request.headers.get("authorization") ?? "";
  const bearer = /^bearer\s+(\S+)$/i.exec(auth.trim())?.[1];
  return bearer ?? request.headers.get("x-g1t-token");
}

/**
 * A project id as g1t makes them (`newId("prj")`): `prj_` and a UUIDv7 in
 * lowercase Crockford base32. Anything else names no project, so it never
 * reaches (or makes) a store.
 */
const PROJECT_ID = /^prj_[0-9abcdefghjkmnpqrstvwxyz]{26}$/;

/** The project a token is for: tokens are `g1to_<project id>_<secret>`. */
export function projectOfToken(token: string): string | null {
  if (!token.startsWith(TELEMETRY_TOKEN_PREFIX)) return null;
  const rest = token.slice(TELEMETRY_TOKEN_PREFIX.length);
  const at = rest.lastIndexOf("_");
  if (at <= 0 || at === rest.length - 1) return null;
  const project = rest.slice(0, at);
  return PROJECT_ID.test(project) ? project : null;
}

async function readBody(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY) throw new IngestError(413, `A request may be at most ${MAX_BODY / 1024 / 1024} MB; send smaller batches.`);
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.length > MAX_BODY) throw new IngestError(413, `A request may be at most ${MAX_BODY / 1024 / 1024} MB; send smaller batches.`);
  const encoding = (request.headers.get("content-encoding") ?? "").toLowerCase();
  if (!encoding || encoding === "identity") return raw;
  if (encoding !== "gzip" && encoding !== "deflate") throw new IngestError(415, `Content-Encoding ${encoding} is not one this endpoint reads: send gzip or none.`);
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream(encoding));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_DECODED) throw new IngestError(413, "The request is too large once unzipped; send smaller batches.");
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** The request read into a batch for the store. */
export async function readOtlp(request: Request, signal: Signal, door: Door): Promise<{ batch: Batch; protobuf: boolean }> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const protobuf = type === "application/x-protobuf" || type === "application/protobuf";
  if (!protobuf && type !== "application/json" && type !== "") {
    throw new IngestError(415, `Content-Type ${type} is not OTLP: send application/json or application/x-protobuf.`);
  }
  const bytes = await readBody(request);
  let body: unknown;
  try {
    if (protobuf) {
      body = signal === "traces" ? decodeTraces(bytes) : signal === "logs" ? decodeLogs(bytes) : decodeMetrics(bytes);
    } else {
      body = bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : {};
    }
  } catch (error) {
    if (error instanceof ProtoError || error instanceof SyntaxError) throw new IngestError(400, `The body is not OTLP ${protobuf ? "protobuf" : "JSON"}: ${error.message}`);
    throw error;
  }
  if (!body || typeof body !== "object") throw new IngestError(400, "The body is not an OTLP export request.");
  const batch =
    signal === "traces" ? readTraces(body as never, door, bytes.length) : signal === "logs" ? readLogs(body as never, door, bytes.length) : readMetrics(body as never, door, bytes.length);
  return { batch, protobuf };
}

/** What OTLP expects back for a success: an empty export response, in the encoding it sent. */
export function accepted(protobuf: boolean): Response {
  return protobuf
    ? new Response(new Uint8Array(0), { status: 200, headers: { "content-type": "application/x-protobuf" } })
    : Response.json({}, { status: 200 });
}

/**
 * A failure, as OTLP describes one (a `Status` with a message). 4xx other
 * than 429 tells the exporter not to retry.
 */
export function refused(status: number, message: string): Response {
  return Response.json({ code: status === 401 ? 16 : status === 429 ? 8 : 3, message }, { status });
}
