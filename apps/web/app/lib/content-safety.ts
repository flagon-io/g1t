/**
 * Headers that keep bytes someone else wrote from running as a page.
 *
 * The package registries answer on the site's own origin, and what they
 * serve (a POM, a nuspec, a manifest) is the publisher's. Every registry
 * answer is told never to be sniffed, to run nothing and to load nothing,
 * and one a browser would open as a document is a download instead. The
 * clients the registries serve ignore all three headers.
 */

/** Nothing loads and nothing runs: the policy for bytes that are only ever data. */
export const NOTHING_RUNS = "default-src 'none'; sandbox";

/**
 * Types a browser shows as data, never as a page: JSON, plain text,
 * archives and checked images. Anything else (HTML, SVG, any XML, an
 * unknown or missing type) could become a page, so it is a download.
 */
const SHOWN_AS_DATA = [
  /^text\/plain$/,
  /^application\/json$/,
  /^application\/[a-z0-9.+-]+\+json$/,
  /^application\/(?:octet-stream|gzip|x-gzip|zip|x-tar|java-archive|pgp-signature)$/,
  /^application\/vnd\.[a-z0-9.+-]+$/,
  /^image\/(?:png|jpeg|gif|webp|avif)$/,
];

/** The media type alone: lowercase, without parameters. */
export function mediaType(contentType: string | null | undefined): string {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

/** Whether a browser could open a body of this type as a document. */
export function opensAsDocument(contentType: string | null | undefined): boolean {
  const type = mediaType(contentType);
  if (/\+xml$|\/xml$|xml-|html|svg|xsl/.test(type)) return true;
  return !SHOWN_AS_DATA.some((pattern) => pattern.test(type));
}

/**
 * The headers a registry answer gains: no sniffing, a policy that runs
 * nothing, and, for a type a browser would open as a document, an
 * attachment. A disposition the service already set is kept.
 */
export function hardenRegistryHeaders(headers: Headers): void {
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", NOTHING_RUNS);
  if (!headers.has("content-disposition") && opensAsDocument(headers.get("content-type"))) {
    headers.set("content-disposition", "attachment");
  }
}

/**
 * A `Content-Disposition` for a download named `filename`: an ASCII
 * fallback with anything unsafe replaced, and the exact name as
 * RFC 6266's `filename*`.
 */
export function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\%;]/g, "_") || "download";
  const exact = encodeURIComponent(filename.replace(/[\x00-\x1f\x7f]/g, "_")).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${exact}`;
}
