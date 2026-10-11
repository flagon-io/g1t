/**
 * Links into the app. A `g1t://` link names a site path, as on the desktop
 * (apps/desktop/src-tauri/src/links.rs): `g1t://acme/-/chat/dm/chn_1` is
 * the page `/acme/-/chat/dm/chn_1`. The app has screens for some of the
 * site's pages; `routeFor` says which screen shows a site path, and the
 * rest open on the site.
 *
 * Kept free of React Native imports so `npm test` runs it under Node.
 */

/** Where the app's OAuth sign-in comes back to. */
export const OAUTH_CALLBACK_PATH = "/oauth/callback";

/** Path segments a workspace or account can never be named (the site's own pages). */
const NOT_OWNERS = new Set(["settings", "notifications", "oauth", "device", "login", "register", "-"]);

/**
 * The app's screen for a site path, or null when the app has none and the
 * page should open on the site.
 */
export function routeFor(sitePath: string): string | null {
  const [pathname, query = ""] = sitePath.split("?", 2);
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponentSafe);
  const keep = query ? `?${query}` : "";
  if (parts.length === 0) return "/";
  if (`/${parts.join("/")}` === OAUTH_CALLBACK_PATH) return OAUTH_CALLBACK_PATH + keep;
  const [owner, second, third, fourth, fifth] = parts;
  if (NOT_OWNERS.has(owner.toLowerCase())) return null;
  const workspace = `workspace=${encodeURIComponent(owner)}`;

  // A workspace's own pages: /<workspace>/-/<page>.
  if (second === "-") {
    if (third === "chat") {
      if (!fourth) return `/chat?${workspace}`;
      if (fourth === "dm" && fifth) return `/chat/${encodeURIComponent(fifth)}?${workspace}`;
      if (fourth !== "browse" && fourth !== "dm" && !fifth) return `/chat/${encodeURIComponent(fourth)}?${workspace}`;
      return null;
    }
    if (third === "overview" && !fourth) return `/code?${workspace}`;
    if (third === "marketplace" || third === "integrations" || (third === "agents" && fourth === "skills")) {
      return `/customize?${workspace}`;
    }
    return null;
  }

  // A repository's pages: /<owner>/<repo>[/pull/<n> | /issues/<n>].
  if (!second) return null;
  const repo = `/code/${encodeURIComponent(owner)}/${encodeURIComponent(second)}`;
  if (!third) return repo;
  if (third === "pull" && fourth && /^\d+$/.test(fourth) && !fifth) return `${repo}/pull/${fourth}`;
  if (third === "issues" && fourth && /^\d+$/.test(fourth) && !fifth) return `${repo}/issues/${fourth}`;
  return null;
}

/**
 * The site path a `g1t://` link names, or null for any other link.
 * `g1t://acme/-/chat?x` is `/acme/-/chat?x`.
 */
export function sitePathOf(link: string): string | null {
  const match = /^g1t:\/\/([^?#]*)(\?[^#]*)?/i.exec(link);
  if (!match) return null;
  const path = `/${match[1].replace(/^\/+/, "")}`;
  return path + (match[2] ?? "");
}

function decodeURIComponentSafe(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}
