/**
 * An avatar as it arrives from a form: read, checked and turned into the
 * base64 the identity service takes. Identity checks it again, by its
 * bytes, and is the one that decides; this only turns away what is
 * plainly wrong before sending a megabyte across.
 */

/** As `MAX_AVATAR_BYTES` in the contracts: kept here so tests run without them. */
export const MAX_AVATAR_BYTES = 1024 * 1024;

/** What an `<input type="file">` offers to pick. SVG is left out on purpose. */
export const AVATAR_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

/** The type an image's first bytes show it to be, or null. As identity's `sniff`. */
export function sniffImage(bytes: Uint8Array): string | null {
  const starts = (...prefix: number[]) => prefix.every((byte, i) => bytes[i] === byte);
  const ascii = (at: number, text: string) => [...text].every((char, i) => bytes[at + i] === char.charCodeAt(0));
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return null;
}

/** Bytes as base64, in chunks so a large file does not overflow the stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export type AvatarUpload = { image: string } | { error: string };

/** Reads the file in `field` of a submitted form. */
export async function readAvatarUpload(form: FormData, field = "avatar"): Promise<AvatarUpload> {
  const file = form.get(field);
  if (!file || typeof file === "string" || file.size === 0) {
    return { error: "Choose an image to upload." };
  }
  if (file.size > MAX_AVATAR_BYTES) {
    return { error: "Use an image of at most 1 MB." };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!sniffImage(bytes)) {
    return { error: "Use a PNG, JPEG, WebP or GIF image." };
  }
  return { image: toBase64(bytes) };
}
