/**
 * Where to send someone after they sign in, sign up or switch account:
 * a path on g1t, and never anywhere else.
 *
 * Only a plain same-origin path is honoured. `//host`, `/\host` and paths
 * with control characters are refused, because browsers read all of them
 * as another site (they drop tabs and newlines, and treat `\` as `/`).
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.includes("\\")) return "/";
  // Control characters and DEL, which a browser may strip before parsing.
  if (/[\u0000-\u001f\u007f]/.test(raw)) return "/";
  try {
    const base = "https://g1t.invalid";
    const url = new URL(raw, base);
    if (url.origin !== base) return "/";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/";
  }
}

/** A sign-in or sign-up page that brings someone back to `here` afterwards. */
export function withNext(page: "/login" | "/register", here: string): string {
  const next = safeNext(here);
  return next === "/" ? page : `${page}?next=${encodeURIComponent(next)}`;
}
