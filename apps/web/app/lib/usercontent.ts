/**
 * Files people supply, served from an origin of their own: a repository's
 * files and uploaded avatars at `USERCONTENT_URL` (g1tusercontent.com on
 * g1t.sh). The site's session cookie is never sent there, and nothing
 * served there can run script.
 *
 *   <usercontent>/<owner>/<repo>/raw/<ref>/<path>   a file at a branch, tag or commit
 *   <usercontent>/avatars/<sha256>                   an uploaded avatar
 *   <usercontent>/emoji/<sha256>                     a workspace's custom emoji
 *
 * A public repository's files are there for anyone. A private one's carry
 * `?token=`, a signature the site makes for someone who can read the
 * repository (routes/repo/raw.ts), good for one file for an hour or two.
 * No Workers imports, so it can be tested under Node.
 */

/** What every file served there runs under: nothing runs, images and inline styles of its own only. */
export const USERCONTENT_POLICY = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";
/** A PDF: the same, but not sandboxed, which browsers' PDF viewers refuse to open under. */
export const PDF_POLICY = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** The largest file served, in bytes. */
export const MAX_RAW_BYTES = 10 * 1024 * 1024;

/** A signed address lasts until the end of the next whole hour, so a page's addresses stay the same for an hour. */
const TOKEN_HOURS = 2;

export type RawFile = { owner: string; repo: string; ref: string; path: string };

const segment = (value: string) => encodeURIComponent(value);

/** `/<owner>/<repo>/raw/<ref>/<path>`, each part encoded; a ref's slashes too, so it stays one segment. */
export function rawPath(file: RawFile): string {
  const path = file.path.split("/").filter(Boolean).map(segment).join("/");
  return `/${segment(file.owner)}/${segment(file.repo)}/raw/${segment(file.ref)}/${path}`;
}

/** The parts of a raw file's path, decoded; null for any other path. */
export function parseRawPath(pathname: string): RawFile | null {
  const parts = pathname.split("/").slice(1);
  if (parts.length < 5 || parts[2] !== "raw") return null;
  try {
    const [owner, repo, , ref, ...rest] = parts.map(decodeURIComponent);
    const path = rest.join("/");
    if (!owner || !repo || !ref || !path || rest.some((part) => !part || part === "." || part === "..")) return null;
    return { owner, repo, ref, path };
  } catch {
    return null;
  }
}

/**
 * The part of `url` under the usercontent address `base`, or null when it
 * is not there: on its own host, any path; as a path on the site
 * (`<site>/-/usercontent`), what follows that path, whatever the host the
 * request came in on (a proxy may change it).
 */
export function usercontentPath(url: URL, base: string): string | null {
  const at = new URL(base);
  const prefix = at.pathname.replace(/\/+$/, "");
  if (!prefix) return url.host === at.host ? url.pathname : null;
  if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) return url.pathname.slice(prefix.length) || "/";
  return null;
}

/** Whether a ref names a commit, whose files never change. */
export function isCommit(ref: string): boolean {
  return /^[0-9a-f]{40}$/.test(ref);
}

const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const plain = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(plain, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function hmacKey(secret: string, use: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [use]);
}

/** What a token signs: the file, by the repository's path and id, and when it ends. */
function signed(file: RawFile, repoId: string, expires: number): Uint8Array<ArrayBuffer> {
  return encoder.encode(["raw", file.owner.toLowerCase(), file.repo.toLowerCase(), repoId, file.ref, file.path, String(expires)].join("\n"));
}

/** A token for one file of a private repository: `<expires>.<repoId>.<signature>`. */
export async function signRaw(secret: string, file: RawFile, repoId: string, nowMs = Date.now()): Promise<string> {
  const hour = 3600;
  const expires = (Math.floor(nowMs / 1000 / hour) + TOKEN_HOURS) * hour;
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), signed(file, repoId, expires));
  return `${expires}.${repoId}.${base64url(signature)}`;
}

/** The repository id a token is good for, when it is for this file and has not ended; else null. */
export async function verifyRaw(secret: string, file: RawFile, token: string, nowMs = Date.now()): Promise<string | null> {
  const match = /^(\d{1,12})\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const [, at, repoId, signature] = match;
  const expires = Number(at);
  if (expires * 1000 <= nowMs) return null;
  const bytes = fromBase64url(signature!);
  if (!bytes) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), bytes, signed(file, repoId!, expires));
  return ok ? repoId! : null;
}

const IMAGES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

const MEDIA: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  woff: "font/woff",
  woff2: "font/woff2",
  pdf: "application/pdf",
};

function extension(path: string): string {
  const name = path.split("/").pop() ?? "";
  return name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
}

/** Whether a file shows as an image in a page, by its name. */
export function isImagePath(path: string): boolean {
  return extension(path) in IMAGES;
}

/** Whether the bytes look like text: no NUL in the first 8,000. */
function looksLikeText(bytes: Uint8Array): boolean {
  return !bytes.subarray(0, 8000).includes(0);
}

/**
 * The headers a file is served with. Images, media and PDFs as
 * themselves; any other text (HTML, SVG's script, XML, JavaScript
 * included) as plain text; anything else as bytes to save. Never sniffed,
 * and nothing in it runs.
 */
export function rawHeaders(path: string, bytes: Uint8Array): Headers {
  const ext = extension(path);
  const type = IMAGES[ext] ?? MEDIA[ext] ?? (looksLikeText(bytes) ? "text/plain; charset=utf-8" : "application/octet-stream");
  const headers = new Headers({
    "content-type": type,
    "content-length": String(bytes.byteLength),
    "x-content-type-options": "nosniff",
    "content-security-policy": type === "application/pdf" ? PDF_POLICY : USERCONTENT_POLICY,
    "cross-origin-resource-policy": "cross-origin",
    "referrer-policy": "no-referrer",
  });
  if (type === "application/octet-stream") {
    const name = path.split("/").pop() ?? "file";
    headers.set("content-disposition", `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\%;]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  return headers;
}

/**
 * An image's address: an external one as written; a relative one as the
 * repository's raw file at the same commit, or nothing when it climbs out
 * of the repository. `rawBase` is the document's folder under
 * `/<owner>/<repo>/raw/<ref>`.
 */
export function imageSource(src: string, rawBase: string | undefined): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//") || !rawBase || src.startsWith("#")) return src;
  const root = /^\/[^/]+\/[^/]+\/raw\/[^/]+/.exec(rawBase)?.[0];
  if (!root) return src;
  const path = src.split(/[?#]/)[0]!;
  if (!path) return undefined;
  const from = path.startsWith("/") ? `${root}/` : `${rawBase.replace(/\/+$/, "")}/`;
  const resolved = new URL(path.replace(/^\/+/, ""), `https://g1t.invalid${from}`).pathname;
  return resolved.startsWith(`${root}/`) ? resolved : undefined;
}
