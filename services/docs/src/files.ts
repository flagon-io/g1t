/**
 * Where files put in pages are kept: behind this small interface, so a
 * self-hosted g1t can keep them on disk or in any S3-compatible store.
 * The managed service uses R2 (`r2FileStore`).
 */

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
