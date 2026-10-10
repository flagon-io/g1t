/**
 * AWS Signature Version 4, by hand with WebCrypto: how a self-hosted g1t
 * signs requests to an S3-compatible store (MinIO, Ceph, Garage, AWS S3,
 * R2's S3 API) without an SDK. Checked against AWS's published test
 * vectors (sigv4.test.ts). Reference:
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
 */

export type Credentials = { access_key_id: string; secret_access_key: string };

export type SignInput = {
  method: string;
  url: string;
  /** Headers to sign besides `host` and `x-amz-date` (which are added). */
  headers?: Record<string, string>;
  /** The payload's SHA-256 in hex, or `UNSIGNED-PAYLOAD`. */
  payload_hash: string;
  region: string;
  service: string;
  credentials: Credentials;
  /** When it is signed; now by default. */
  date?: Date;
  /**
   * Whether path segments are encoded a second time, as every AWS service
   * but S3 expects. S3 signs the path as sent.
   */
  double_encode_path?: boolean;
};

export type Signed = {
  /** Every header to send, `authorization` included (lowercase names). */
  headers: Record<string, string>;
  canonical_request: string;
  string_to_sign: string;
  signature: string;
};

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, encoder.encode(data));
}

/** RFC 3986 encoding, as SigV4 wants it: unreserved characters stay, everything else is %XX in upper case. */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `20150830T123600Z`. */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function canonicalPath(pathname: string, double: boolean): string {
  if (!pathname || pathname === "/") return "/";
  return pathname
    .split("/")
    .map((segment) => {
      let raw: string;
      try {
        raw = decodeURIComponent(segment);
      } catch {
        raw = segment;
      }
      const once = uriEncode(raw);
      return double ? uriEncode(once) : once;
    })
    .join("/");
}

function canonicalQuery(search: URLSearchParams): string {
  return [...search.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** Signs a request: the headers to send with it, and what was signed (for tests and debugging). */
export async function sign(input: SignInput): Promise<Signed> {
  const url = new URL(input.url);
  const when = amzDate(input.date ?? new Date());
  const day = when.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  headers.host = url.host;
  headers["x-amz-date"] = when;
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(url.pathname, input.double_encode_path ?? input.service !== "s3"),
    canonicalQuery(url.searchParams),
    names.map((n) => `${n}:${headers[n]}\n`).join(""),
    signedHeaders,
    input.payload_hash,
  ].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", when, scope, await sha256Hex(canonicalRequest)].join("\n");
  const kDate = await hmac(encoder.encode(`AWS4${input.credentials.secret_access_key}`), day);
  const kRegion = await hmac(kDate, input.region);
  const kService = await hmac(kRegion, input.service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = hex(await hmac(kSigning, stringToSign));
  return {
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.access_key_id}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonical_request: canonicalRequest,
    string_to_sign: stringToSign,
    signature,
  };
}
