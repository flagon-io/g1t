import { createRequestHandler } from "react-router";

import { identityClient, isNamespaceShaped } from "@g1t/contracts";

import { addressesFor } from "../app/lib/addresses";
import { visitorAsksFirst } from "../app/lib/analytics-consent";
import { hardenRegistryHeaders } from "../app/lib/content-safety";
import { withSiteHeaders } from "../app/lib/page-headers";
import { finishResponse, withRequestPerf } from "../app/lib/perf.server";
import { gitLimited, pageLimited, usercontentLimited } from "../app/lib/front-door-limits";
import { goImport } from "../app/lib/go-get";
import { repositoryOfPage, stillPublic } from "../app/lib/public-cache";
import { registryWorkspace, servicePath } from "../app/lib/registry-paths";
import { usercontentPath } from "../app/lib/usercontent";
import { TOKEN_CHALLENGE } from "../app/lib/website-token";
import { serveUsercontent } from "./usercontent";

const loadBuild = () => import("virtual:react-router/server-build");

/**
 * Given a function for the build, React Router derives everything from it
 * again on every request: each route wrapped for the timings in
 * entry.server.tsx, then the route table flattened and ranked, about a
 * millisecond and a half of CPU a page. The build never changes while an
 * isolate lives, so outside development it is loaded once and the handler
 * made once. Development keeps the function, so a changed file is picked up.
 * Only the made handler is kept, never a promise of one, so no request
 * waits on another's (a build that fails to load is loaded again next time).
 */
let handler: ReturnType<typeof createRequestHandler> | undefined;
async function requestHandler(request: Request): Promise<Response> {
  if (import.meta.env.DEV) return createRequestHandler(loadBuild, import.meta.env.MODE)(request);
  handler ??= createRequestHandler(await loadBuild(), import.meta.env.MODE);
  return handler(request);
}

const DOCS = "https://docs.g1t.sh";

/** Where the documentation pages that used to live under /docs are now. */
const MOVED_DOCS: Record<string, string> = {
  "/docs": "/quickstart/",
  "/docs/concepts": "/concepts/overview/",
  "/docs/authentication": "/guides/authentication/",
  "/docs/git": "/guides/git/",
  "/docs/g1t-agents": "/guides/working-with-g1t/",
  "/docs/agents": "/guides/bring-your-own-agent/",
  "/docs/api": "/reference/api/",
  "/docs/api/reference": "/reference/api/",
};

export default {
  async fetch(request, env, ctx) {
    // Repository files and avatars, on their own origin
    // (g1tusercontent.com): answered before anything of the site's runs,
    // so nothing there reads or sets the session cookie.
    const usercontent = usercontentPath(new URL(request.url), addressesFor(env).usercontent);
    if (usercontent !== null) {
      return (await usercontentLimited(env, request, usercontent)) ?? serveUsercontent(env, ctx, request, usercontent);
    }
    // Every answer: no sniffing, a referrer of the origin alone, and no
    // framing of pages (app/lib/page-headers.ts).
    return withSiteHeaders(await site(request, env, ctx));
  },
} satisfies ExportedHandler<Env>;

async function site(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { pathname } = new URL(request.url);
  // Git over HTTPS shares this hostname but belongs to the repos service.
  // Its answer goes back to the git client as it is: a repository under a
  // renamed workspace's old name answers with a 301, which git follows and
  // must see, so the redirect is never followed here.
  // The container registry (`docker login g1t.sh`) and the npm registry
  // (`g1t.sh/-/npm/`) are the packages
  // service's, handed over the same way.
  // `go get g1t.sh/<workspace>/<repo>`: where its code is, from the
  // address alone, so it costs nothing and caches.
  const go = request.method === "GET" ? goImport(new URL(request.url)) : null;
  if (go) {
    return new Response(go, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" },
    });
  }
  const service = servicePath(pathname);
  if (service === "git") {
    // Per address without credentials, per credential with them
    // (app/lib/front-door-limits.ts): anonymous clones are not free to
    // the repository's owner.
    return (await gitLimited(env, request)) ?? proxyGit(env, request);
  }
  if (service === "packages") {
    return proxyPackages(env, request);
  }
  // The documentation is its own site.
  if (pathname === "/docs" || pathname.startsWith("/docs/")) {
    const page = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
    const target = MOVED_DOCS[page] ?? "/";
    return Response.redirect(DOCS + target, 301);
  }
  // Pages and data requests, limited per address signed out and per
  // session signed in (app/lib/front-door-limits.ts).
  const limited = await pageLimited(env, request, pathname);
  if (limited) return limited;
  // Every page and data request says where its time went (Server-Timing)
  // and keeps the reader's D1 bookmarks (app/lib/perf.server.ts).
  const render = () => withRequestPerf(request, async () => finishResponse(request, await requestHandler(request)));
  if (anonymousPage(request, pathname)) return servePublic(env, request, ctx, render);
  const answer = await render();
  // A token the site refused (app/lib/website-token.ts) is told so as the
  // API tells it: React Router drops the headers of what middleware throws.
  if (answer.status === 401 && request.headers.has("authorization")) answer.headers.set("www-authenticate", TOKEN_CHALLENGE);
  return answer;
}

/**
 * Public pages as someone signed out sees them: the same for every such
 * visitor, so kept in this data centre's cache. Reserved first segments
 * (settings, sign-in, invitations and the like) and workspace pages (`-`)
 * are never kept; docs/PERFORMANCE.md lists the rules. A repository's kept
 * page is served only while repos says the repository is still public: one
 * made private or deleted is never served from any data centre's copy.
 */
const PUBLIC_TOP = /^\/(?:|_root\.data|pricing|explore|security|support|policies(?:\/[a-z-]+)?)(?:\.data)?$/;
const PUBLIC_PROJECT =
  /^\/(?!(?:settings|u|auth|oauth|integrations|new|invite|workspaces|device|verify|confirm-email|login|register|logout|forgot|reset|search|status|avatars|docs)\/)[^/]+\/(?!-\/|-$)[^/]+(?:\/(?:code|commits|issues|pulls|pull\/\d+|issues\/\d+|commit\/[0-9a-f]+|tree\/.+|blob\/.+))?(?:\.data)?$/;
/** Fresh for this long; then served once more while a new copy is made. */
const PUBLIC_FRESH_SECONDS = 30;
const PUBLIC_STALE_SECONDS = 300;

function anonymousPage(request: Request, pathname: string): boolean {
  if (request.method !== "GET") return false;
  if (/(?:^|;\s*)g1t_session=/.test(request.headers.get("cookie") ?? "")) return false;
  // A token signs the request in (app/lib/website-token.ts): never kept, never served a kept page.
  if (request.headers.has("authorization")) return false;
  return PUBLIC_TOP.test(pathname) || PUBLIC_PROJECT.test(pathname);
}

async function servePublic(env: Env, request: Request, ctx: ExecutionContext, render: () => Promise<Response>): Promise<Response> {
  const cache = (caches as unknown as { default: Cache }).default;
  // Visitors asked about analytics first get a page that says so, kept apart.
  const keyUrl = new URL(request.url);
  if (visitorAsksFirst(request)) keyUrl.searchParams.set("_g1t_consent", "1");
  const key = new Request(keyUrl, { method: "GET" });
  const repository = PUBLIC_PROJECT.test(new URL(request.url).pathname) ? repositoryOfPage(new URL(request.url).pathname) : null;
  // Asked alongside the cache, so a hit waits for one indexed read at most.
  const [cached, visible] = await Promise.all([cache.match(key), repository ? isStillPublic(env, repository) : Promise.resolve(true)]);
  if (cached && !visible) {
    ctx.waitUntil(cache.delete(key).then(() => undefined, () => undefined));
    return render();
  }
  const keptAt = Number(cached?.headers.get("x-g1t-kept-at") ?? 0);
  const age = Math.round((Date.now() - keptAt) / 1000);
  const refresh = async () => {
    const fresh = await render();
    // Only a plain answer for everyone: nothing that sets a cookie or says
    // it is private.
    const cacheable =
      (fresh.status === 200 || fresh.status === 404) &&
      !fresh.headers.has("set-cookie") &&
      !/private|no-store/.test(fresh.headers.get("cache-control") ?? "");
    if (cacheable) {
      const copy = new Response(fresh.clone().body, fresh);
      copy.headers.set("x-g1t-kept-at", String(Date.now()));
      copy.headers.set("cache-control", `public, max-age=${PUBLIC_STALE_SECONDS}`);
      ctx.waitUntil(cache.put(key, copy));
    }
    return fresh;
  };
  if (cached && keptAt > 0 && age < PUBLIC_STALE_SECONDS) {
    if (age >= PUBLIC_FRESH_SECONDS) ctx.waitUntil(refresh().then(() => undefined, () => undefined));
    const answer = new Response(cached.body, cached);
    answer.headers.delete("x-g1t-kept-at");
    answer.headers.delete("cache-control");
    answer.headers.set("server-timing", `cache;desc="hit, ${age}s old"`);
    return answer;
  }
  return refresh();
}

/** Whether the repository is there and public; anything else, including no answer, is no. */
async function isStillPublic(env: Env, repository: string): Promise<boolean> {
  try {
    const answer = await env.REPOS.fetch("https://service/rpc/visibility", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: [repository] }),
    });
    return answer.ok && stillPublic(await answer.json(), repository);
  } catch {
    return false;
  }
}

/**
 * A git request, answered by the repos service. Its `Server-Timing` header
 * gains `repos`: how long the answer took to start from here, so the time
 * between this Worker and the repos service shows beside the steps the
 * repos service reports.
 */
async function proxyGit(env: Env, request: Request): Promise<Response> {
  const started = Date.now();
  const answer = await env.REPOS.fetch(new Request(request, { redirect: "manual" }));
  const response = new Response(answer.body, answer);
  response.headers.append("server-timing", `repos;dur=${Date.now() - started}`);
  return response;
}

/**
 * A registry request, answered by the packages service as it is: its
 * redirects (a large blob sent to storage) go back to the client, which
 * follows them itself. One that found nothing under a workspace's old name
 * or an alias staff set (`g1t` for `flagon-io`) is sent to the same path
 * under the workspace's name: only the not-found answer pays for the lookup.
 * Every answer runs nothing in a browser (app/lib/content-safety.ts): what
 * a registry serves is its publisher's, on this origin.
 */
async function proxyPackages(env: Env, request: Request): Promise<Response> {
  const started = Date.now();
  const answer = await env.PACKAGES.fetch(new Request(request, { redirect: "manual" }));
  const moved = answer.status === 404 ? await registryMoved(env, request) : null;
  const response = moved ?? new Response(answer.body, answer);
  hardenRegistryHeaders(response.headers);
  response.headers.append("server-timing", `packages;dur=${Date.now() - started}`);
  return response;
}

/** Where a registry request under an alias or old name goes now, or null. */
async function registryMoved(env: Env, request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const named = registryWorkspace(url.pathname);
  if (!named || !isNamespaceShaped(named.slug)) return null;
  let current: string | null = null;
  try {
    current = await identityClient(env.IDENTITY).resolveSlug(named.slug);
  } catch {
    return null;
  }
  if (!current || current === named.slug) return null;
  const get = request.method === "GET" || request.method === "HEAD";
  // 308 keeps a publish a PUT, for the clients that follow it.
  return new Response(null, { status: get ? 301 : 308, headers: { location: named.under(current) + url.search } });
}
