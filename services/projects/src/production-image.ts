/**
 * A project's uploaded production image: shown on its overview where a
 * screenshot of production would be, when there is none or when it is
 * preferred. Kept in the avatars namespace under `production/<sha256>`,
 * with the type read from its bytes, and served from the usercontent
 * origin at `/production-images/<sha256>` (apps/web/workers/usercontent.ts),
 * never from the site itself. Types only, so it is tested apart from the
 * service.
 */

import type { ProductionImage } from "@g1t/contracts";

/** As `MAX_PRODUCTION_IMAGE_BYTES` and `PRODUCTION_IMAGE_TYPES` in the contracts: kept here so tests run without them. */
export const MAX_PRODUCTION_IMAGE_BYTES = 5 * 1024 * 1024;
const PRODUCTION_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** The SHA-256 of the bytes, in hex: the image's name. */
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The UTC day, as the screenshot of a production deployed elsewhere is versioned when no deploy names a commit. */
export function today(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Where an image is kept in the avatars namespace. */
export function productionImageKey(file: string): string {
  return `production/${file}`;
}

/** The type an image's first bytes show it to be, if it is one a production image may be. */
export function sniffProductionImage(bytes: Uint8Array): string | null {
  const starts = (...prefix: number[]) => prefix.every((byte, i) => bytes[i] === byte);
  const ascii = (at: number, text: string) => [...text].every((char, i) => bytes[at + i] === char.charCodeAt(0));
  let type: string | null = null;
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) type = "image/png";
  else if (starts(0xff, 0xd8, 0xff)) type = "image/jpeg";
  else if (bytes.length >= 12 && ascii(0, "RIFF") && ascii(8, "WEBP")) type = "image/webp";
  return type && PRODUCTION_IMAGE_TYPES.includes(type) ? type : null;
}

/** Base64 to bytes; null when it is not base64. */
export function fromBase64(data: unknown): Uint8Array | null {
  if (typeof data !== "string" || !data) return null;
  try {
    return Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

export type CheckedImage = { ok: true; bytes: Uint8Array; contentType: string } | { ok: false; message: string };

/** An uploaded image, checked by its bytes: a PNG, JPEG or WebP of at most 5 MB. */
export function checkProductionImage(data: unknown): CheckedImage {
  const bytes = fromBase64(data);
  if (!bytes || bytes.length === 0) return { ok: false, message: "Choose a PNG, JPEG or WebP image." };
  if (bytes.length > MAX_PRODUCTION_IMAGE_BYTES) {
    return { ok: false, message: `Use an image of at most ${MAX_PRODUCTION_IMAGE_BYTES / 1024 / 1024} MB.` };
  }
  const contentType = sniffProductionImage(bytes);
  if (!contentType) return { ok: false, message: "Use a PNG, JPEG or WebP image." };
  return { ok: true, bytes, contentType };
}

/** The image's stored form: its hash and type, or null for none. */
export function productionImageOf(row: {
  production_image?: string | null;
  production_image_type?: string | null;
  production_image_preferred?: number | null;
}): ProductionImage | null {
  if (!row.production_image) return null;
  return {
    file: row.production_image,
    contentType: row.production_image_type ?? "image/png",
    preferred: !!row.production_image_preferred,
  };
}

/**
 * Whether the project's production should be visited for a screenshot: it
 * runs elsewhere, at an address, and no uploaded image is shown instead.
 */
export function wantsScreenshot(project: { runs: string | null; productionUrl: string | null; productionImage: { preferred: boolean } | null }): boolean {
  return project.runs === "elsewhere" && !!project.productionUrl && !project.productionImage?.preferred;
}
