/**
 * Links into the app. A `g1t://` link names a site path, as on the desktop
 * (apps/desktop/src-tauri/src/links.rs): `g1t://acme/-/chat/dm/chn_1` is
 * the page `/acme/-/chat/dm/chn_1`, as `https://g1t.sh/acme/-/chat/dm/chn_1`
 * is. The app has screens for some of the site's pages; `routeFor` says
 * which screen shows a site path, and the rest open on the site.
 *
 * Kept free of React Native imports so `npm test` runs it under Node.
 */

/** Where the app's OAuth sign-in comes back to. */
export const OAUTH_CALLBACK_PATH = "/oauth/callback";

/**
 * Pages a workspace no longer has: Agents (with the skill library),
 * Customize and the Marketplace. An old link to one opens Home.
 */
const RETIRED = new Set(["agents", "customize", "marketplace"]);

/** Path segments a workspace or account can never be named (the site's own pages). */
const NOT_OWNERS = new Set(["settings", "notifications", "oauth", "device", "login", "register", "-"]);

/** The filters a link to Work's list may carry, as the site's: `/acme/-/work?repo=web&label=bug`. */
export const WORK_FILTERS = ["state", "label", "milestone", "assignee", "repo", "role"] as const;

/** The filters a link to Work's sessions may carry: `/acme/-/work/sessions?state=live&repo=web`. */
export const SESSION_FILTERS = ["state", "person", "repo", "item"] as const;

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
  // `g1t://connect?server=<site>`: point the app at a g1t, as a self-hosted one's download page offers.
  if (owner === "connect" && !second && /(^|&)server=/.test(query)) return `/connect?${query}`;
  if (NOT_OWNERS.has(owner.toLowerCase())) return null;
  const workspace = `workspace=${encodeURIComponent(owner)}`;

  // A workspace's own pages: /<workspace>/-/<page>.
  if (second === "-") {
    if (third === "chat") {
      if (!fourth) return `/chat?${workspace}`;
      // Sessions are Chat's on the site; the app keeps them with Work for now.
      if (fourth === "sessions") {
        if (!fifth) return `/work?${workspace}&view=sessions${filtersOf(query, SESSION_FILTERS)}`;
        if (parts.length === 5) return `/work/sessions/${encodeURIComponent(fifth)}?${workspace}`;
        return null;
      }
      if (fourth === "dm" && fifth) return `/chat/${encodeURIComponent(fifth)}?${workspace}`;
      if (fourth !== "browse" && fourth !== "dm" && !fifth) return `/chat/${encodeURIComponent(fourth)}?${workspace}`;
      return null;
    }
    if (third === "work") {
      if (!fourth) return `/work?${workspace}${filtersOf(query, WORK_FILTERS)}`;
      if (fourth === "new" && !fifth) return `/work/new?${workspace}`;
      if (fourth === "board" && !fifth) return `/work?${workspace}&view=board`;
      // Sessions were Work's on the site: links from then open its Sessions view, and one session's screen.
      if (fourth === "sessions") {
        if (!fifth) return `/work?${workspace}&view=sessions${filtersOf(query, SESSION_FILTERS)}`;
        if (parts.length === 5) return `/work/sessions/${encodeURIComponent(fifth)}?${workspace}`;
        return null;
      }
      if (isNumber(fourth) && !fifth) return `/work/${fourth}?${workspace}`;
      // Labels and milestones stay on the site.
      return null;
    }
    if (third === "overview" && !fourth) return `/code?${workspace}`;
    if (third && RETIRED.has(third)) return `/home?${workspace}`;
    return null;
  }

  // A repository's pages: /<owner>/<repo>[/pull/<n>].
  if (!second) return null;
  const repo = `/code/${encodeURIComponent(owner)}/${encodeURIComponent(second)}`;
  if (!third) return repo;
  if (third === "pull" && isNumber(fourth) && !fifth) return `${repo}/pull/${fourth}`;
  // Issues became the workspace's work items. An old issue's number is
  // read in its repository, where it may name a pull request (they shared
  // numbers then): the ref screen asks g1t which.
  if (third === "issues") {
    const name = `repo=${encodeURIComponent(second)}`;
    if (!fourth) return `/work?${workspace}&${name}`;
    if (fourth === "new" && !fifth) return `/work/new?${workspace}&${name}`;
    if (isNumber(fourth) && !fifth) return refRoute({ repo: `${owner}/${second}` }, Number(fourth));
    return null;
  }
  return null;
}

/** Where `#N` is read: in a repository (`owner/name`), or in a workspace alone. */
export type RefContext = { repo: string } | { workspace: string };

/** The screen that asks g1t what `#N` names in a context, and opens it (app/ref.tsx). */
export function refRoute(context: RefContext, number: number): string {
  const where = "repo" in context ? `repo=${encodeURIComponent(context.repo)}` : `workspace=${encodeURIComponent(context.workspace)}`;
  return `/ref?${where}&number=${number}`;
}

/**
 * The context a reference in text is read in (crates/contracts/src/work/refs.rs):
 * `owner/name#N` in that repository, `workspace#N` in that workspace, and
 * `#N` where it was written.
 */
export function refContext(written: string | null, here: RefContext): RefContext {
  if (!written) return here;
  return written.includes("/") ? { repo: written } : { workspace: written };
}

/** What `#N` names, as the API answers (`RefTarget`, in snake_case). */
export type RefTarget =
  | { kind: "work_item"; workspace: string; number: number; item_id?: string }
  | { kind: "pull"; repo: string; number: number }
  | { kind: "none" };

/** The app's screen for what a reference names, or null for nothing. */
export function targetRoute(target: RefTarget): string | null {
  if (target.kind === "work_item") return `/work/${target.number}?workspace=${encodeURIComponent(target.workspace)}`;
  if (target.kind === "pull") {
    const [owner, name] = target.repo.split("/", 2);
    if (!owner || !name) return null;
    return `/code/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pull/${target.number}`;
  }
  return null;
}

/**
 * The site's page for a reference, for when the app cannot ask: the site
 * reads it the same way and redirects.
 */
export function refSitePath(context: RefContext, number: number): string {
  return "repo" in context ? `/${context.repo}/issues/${number}` : `/${context.workspace}/-/work/${number}`;
}

/** A session in a list: what kind it is, its repository (`owner/name`) and pull request. */
export type SessionTarget = { kind: "harness" | "hosted" | "agent" | "recorded"; id: string; repo: string; pull: number | null };

/**
 * Where tapping a session goes. Someone's harness and hosted ones have a
 * page of their own; g1t's agent and a recorded one are their pull
 * request's: its screen in Code, or its session on the site for someone
 * without Code. Null when there is nowhere to go.
 */
export function sessionRoute(session: SessionTarget, workspace: string, code: boolean): string | null {
  if (session.kind === "harness" || session.kind === "hosted") {
    return `/work/sessions/${encodeURIComponent(session.id)}?workspace=${encodeURIComponent(workspace)}`;
  }
  const [owner, name] = session.repo.split("/", 2);
  if (!session.pull || !owner || !name) return null;
  if (code) return `/code/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pull/${session.pull}`;
  return `/open?path=${encodeURIComponent(`/${owner}/${name}/pull/${session.pull}/session`)}`;
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

/**
 * The site path any link that opens the app names: a `g1t://` one, or an
 * `https` one to the site (Android App Links, iOS Universal Links), as
 * `https://g1t.sh/acme/-/work/12` is `/acme/-/work/12`. Null for others.
 */
export function linkPathOf(link: string): string | null {
  const own = sitePathOf(link);
  if (own) return own;
  const web = /^https?:\/\/[^/?#]+(\/[^?#]*)?(\?[^#]*)?/i.exec(link);
  return web ? (web[1] || "/") + (web[2] ?? "") : null;
}

function filtersOf(query: string, names: readonly string[]): string {
  const params = new URLSearchParams(query);
  return names
    .filter((name) => params.get(name))
    .map((name) => `&${name}=${encodeURIComponent(params.get(name)!)}`)
    .join("");
}

function isNumber(part: string | undefined): part is string {
  return Boolean(part && /^\d+$/.test(part));
}

function decodeURIComponentSafe(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}
