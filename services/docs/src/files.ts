/**
 * Where files put in pages are kept: behind this small interface, so a
 * self-hosted g1t can keep them in any S3-compatible store. The managed
 * service uses R2 (`r2FileStore`); `DOCS_FILES=s3` picks `s3FileStore`
 * (docs/SELF_HOSTING.md, "Files in Docs pages").
 */
import { sha256Hex, sign } from "./sigv4.ts";

export type StoredFile = { body: ReadableStream; content_type: string; bytes: number; etag: string };

export interface FileStore {
  put(key: string, body: ReadableStream | ArrayBuffer | Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredFile | null>;
  delete(key: string): Promise<void>;
}

export function r2FileStore(bucket: R2Bucket): FileStore {
  return {
    async put(key, body, contentType) {
      await bucket.put(key, body, { httpMetadata: { contentType } });
    },
    async get(key) {
      const object = await bucket.get(key);
      if (!object) return null;
      return {
        body: object.body,
        content_type: object.httpMetadata?.contentType ?? "application/octet-stream",
        bytes: object.size,
        etag: object.httpEtag,
      };
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}

/** An S3-compatible store: the endpoint, the bucket and the keys, from the Worker's settings and secrets. */
export type S3Config = {
  /** `https://s3.example.com` (or `http://minio:9000` inside a private network). */
  endpoint: string;
  bucket: string;
  /** `us-east-1` unless the store says otherwise; R2 and MinIO accept `auto`/`us-east-1`. */
  region: string;
  access_key_id: string;
  secret_access_key: string;
  /** `https://<bucket>.<endpoint host>/<key>` instead of `<endpoint>/<bucket>/<key>`. Path style by default: every compatible store takes it. */
  virtual_hosted?: boolean;
};

/** Each part of a key encoded, its slashes kept. */
function keyPath(key: string): string {
  return key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export function s3FileStore(config: S3Config, fetcher: typeof fetch = fetch): FileStore {
  const base = new URL(config.endpoint);
  const urlOf = (key: string) => {
    const root = base.pathname.replace(/\/+$/, "");
    if (config.virtual_hosted) return `${base.protocol}//${config.bucket}.${base.host}${root}/${keyPath(key)}`;
    return `${base.protocol}//${base.host}${root}/${encodeURIComponent(config.bucket)}/${keyPath(key)}`;
  };
  const send = async (method: string, key: string, body: Uint8Array | null, headers: Record<string, string> = {}) => {
    const payloadHash = await sha256Hex(body ?? new Uint8Array());
    const signed = await sign({
      method,
      url: urlOf(key),
      headers: { ...headers, "x-amz-content-sha256": payloadHash },
      payload_hash: payloadHash,
      region: config.region || "us-east-1",
      service: "s3",
      credentials: { access_key_id: config.access_key_id, secret_access_key: config.secret_access_key },
    });
    const { host: _host, ...send } = signed.headers;
    return fetcher(urlOf(key), { method, headers: send, body: body as BodyInit | null });
  };
  return {
    async put(key, body, contentType) {
      // Signed over its bytes: a page's file is at most DOC_MAX_FILE_BYTES.
      const bytes = body instanceof ReadableStream ? new Uint8Array(await new Response(body).arrayBuffer()) : body instanceof Uint8Array ? body : new Uint8Array(body);
      const response = await send("PUT", key, bytes, { "content-type": contentType });
      if (!response.ok) throw new Error(`The file store refused the file (${response.status}).`);
    },
    async get(key) {
      const response = await send("GET", key, null);
      if (response.status === 404) return null;
      if (!response.ok || !response.body) throw new Error(`The file store didn't answer (${response.status}).`);
      return {
        body: response.body,
        content_type: response.headers.get("content-type") ?? "application/octet-stream",
        bytes: Number(response.headers.get("content-length") ?? "0"),
        etag: response.headers.get("etag") ?? `"${key}"`,
      };
    },
    async delete(key) {
      const response = await send("DELETE", key, null);
      if (!response.ok && response.status !== 404) throw new Error(`The file store didn't delete the file (${response.status}).`);
    },
  };
}

/** What picks the store: the R2 binding, or `DOCS_FILES=s3` and its settings. */
export type FileStoreEnv = {
  FILES?: R2Bucket;
  DOCS_FILES?: string;
  DOCS_S3_ENDPOINT?: string;
  DOCS_S3_BUCKET?: string;
  DOCS_S3_REGION?: string;
  DOCS_S3_ACCESS_KEY_ID?: string;
  DOCS_S3_SECRET_ACCESS_KEY?: string;
  DOCS_S3_VIRTUAL_HOSTED?: string;
};

/** The store this deployment keeps files in. Throws when it is set up halfway, so a misconfiguration shows at once. */
export function fileStore(env: FileStoreEnv): FileStore {
  if ((env.DOCS_FILES ?? "").toLowerCase() === "s3") {
    const missing = (["DOCS_S3_ENDPOINT", "DOCS_S3_BUCKET", "DOCS_S3_ACCESS_KEY_ID", "DOCS_S3_SECRET_ACCESS_KEY"] as const).filter((k) => !env[k]);
    if (missing.length) throw new Error(`DOCS_FILES=s3 needs ${missing.join(", ")}.`);
    return s3FileStore({
      endpoint: env.DOCS_S3_ENDPOINT!,
      bucket: env.DOCS_S3_BUCKET!,
      region: env.DOCS_S3_REGION || "us-east-1",
      access_key_id: env.DOCS_S3_ACCESS_KEY_ID!,
      secret_access_key: env.DOCS_S3_SECRET_ACCESS_KEY!,
      virtual_hosted: env.DOCS_S3_VIRTUAL_HOSTED === "true",
    });
  }
  if (!env.FILES) throw new Error("No file store: bind FILES (R2) or set DOCS_FILES=s3.");
  return r2FileStore(env.FILES);
}

/** Types a page's file is served as; anything else is served as a download. */
const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "video/mp4", "video/webm", "audio/mpeg", "audio/ogg", "audio/wav", "application/pdf"]);

/** The type a file is kept and served as: images and media as themselves, SVG and everything else as bytes to download (nothing served can run script). */
export function servedType(contentType: string): string {
  const type = String(contentType ?? "").split(";")[0]!.trim().toLowerCase();
  return INLINE.has(type) ? type : "application/octet-stream";
}

/** A file name safe to keep and to put in a header. */
export function safeName(name: string): string {
  const clean = String(name ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
    .trim()
    .slice(0, 180);
  return clean || "file";
}
