import { createRequestHandler } from "react-router";

import { identityClient, isNamespaceShaped } from "@g1t/contracts";

import { addressesFor } from "../app/lib/addresses";
import { hardenRegistryHeaders } from "../app/lib/content-safety";
import { withSiteHeaders } from "../app/lib/page-headers";
import { finishResponse, withRequestPerf } from "../app/lib/perf.server";
import { READ_DEADLINE_MS, withDeadline } from "../app/lib/deadline";
import { wantsServerErrors } from "../app/lib/developer-mode";
import { crawlerLimited, gitLimited, pageLimited, usercontentLimited } from "../app/lib/front-door-limits";
import { alsoKeptForCrawlers, costlyForCrawlers, crawlerCacheKey, crawlerKeepSeconds, crawlerOf, keptForCrawlers, signedOut } from "../app/lib/crawlers";
import { goImport } from "../app/lib/go-get";
import { decodeSharedPage, encodeSharedPage, repositoryOfPage, sharedPageKey, stillPublic } from "../app/lib/public-cache";
import { registryWorkspace, servicePath } from "../app/lib/registry-paths";
import { usercontentPath } from "../app/lib/usercontent";
import { TOKEN_CHALLENGE } from "../app/lib/website-token";
import { serveUsercontent } from "./usercontent";
import { receiveSaml } from "./sso-saml";
import { samlPath } from "../app/lib/sso";
import { serveArchivedAsset } from "../app/lib/asset-archive";
import { needsBuildRefresh } from "../app/lib/build-version";
import { developerResource, pageRepresentation } from "../app/lib/agent-pages";
import { previewAccessSettings, refusePreview } from "../app/lib/preview-access";

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
/**
 * The same, in React Router's development mode: for a signed-in request
 * with developer mode on (app/lib/developer-mode.ts), so a page that fails
 * shows the server's own error rather than "Unexpected Server Error". Made
 * the first time someone asks for it.
 */
let developerHandler: ReturnType<typeof createRequestHandler> | undefined;
async function requestHandler(request: Request): Promise<Response> {
  if (import.meta.env.DEV) return createRequestHandler(loadBuild, import.meta.env.MODE)(request);
  if (wantsServerErrors(request)) {
    developerHandler ??= createRequestHandler(await loadBuild(), "development");
    return developerHandler(request);
  }
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
  "/docs/agents": "/guides/bring-your-own-agent/",
  "/docs/api": "/reference/api/",
  "/docs/api/reference": "/reference/api/",
};

/** Whether this isolate has been handed a request yet. */
let started = false;

export default {
  async fetch(request, env, ctx) {
    // Repository files and avatars, on their own origin
    // (g1tusercontent.com): answered before anything of the site's runs,
    // so nothing there reads or sets the session cookie.
    const usercontent = usercontentPath(new URL(request.url), addressesFor(env).usercontent);
    if (usercontent !== null) {
      return (await usercontentLimited(env, request, usercontent)) ?? serveUsercontent(env, ctx, request, usercontent);
    }
    const arrived = Date.now();
    const fresh = !started;
    started = true;
    // A pull request's preview is for g1t staff, signed in through
    // Cloudflare Access (app/lib/preview-access.ts).
    const refused = await refusePreview(request, previewAccessSettings(env));
    if (refused) return withSiteHeaders(refused);
    // Every answer: no sniffing, a referrer of the origin alone, and no
    // framing of pages (app/lib/page-headers.ts).
    const answer = withSiteHeaders(await site(request, env, ctx));
    // Everything this Worker did, from the moment it was handed the request
    // (`total` starts later, after the limits and the page cache), and
    // whether it was this isolate's first: what a first try waited for
    // beyond these is Cloudflare's, before this Worker ran (#383).
    if (answer.status !== 101) answer.headers.append("server-timing", `worker;dur=${Date.now() - arrived}, isolate;desc=${fresh ? "new" : "warm"}`);
    return answer;
  },
} satisfies ExportedHandler<Env>;

async function site(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { pathname } = new URL(request.url);
  // An old tab's chunk or stylesheet must not turn into an HTML route/404.
  if (pathname.startsWith("/assets/")) return serveArchivedAsset(request, env.DOWNLOADS);
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
  const developer = ["GET", "HEAD"].includes(request.method) ? developerResource(pathname, addressesFor(env)) : null;
  if (developer) return Response.redirect(developer, 308);
  if (pathname === "/docs" || pathname.startsWith("/docs/")) {
    const page = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
    const target = MOVED_DOCS[page] ?? "/";
    return Response.redirect(DOCS + target, 301);
  }
  // Pages and data requests, limited per address signed out and per
  // session signed in (app/lib/front-door-limits.ts).
  const limited = await pageLimited(env, request, pathname);
  if (limited) return limited;
  // A workspace's identity provider posting a SAML response, from its own
  // site: React Router refuses cross-site posts (workers/sso-saml.ts).
  const saml = request.method === "POST" ? samlPath(pathname) : null;
  if (saml) return receiveSaml(env, request, saml);
  // Crawlers see what anyone signed out sees, from the cache for hours
  // (app/lib/crawlers.ts).
  const crawler = crawlerOf(request);
  if (crawler) return serveCrawler(env, request, ctx, crawler);
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
 * are never kept. A repository's kept page is served only while repos
 * says the repository is still public: one made private or deleted is
 * never served from any data centre's copy.
 */
const PUBLIC_TOP = /^\/(?:|_root\.data|pricing|explore|security|support|policies(?:\/[a-z-]+)?)(?:\.data)?$/;
const PUBLIC_PROJECT =
  /^\/(?!(?:settings|u|auth|oauth|integrations|new|invite|workspaces|device|verify|confirm-email|login|register|logout|forgot|reset|search|status|avatars|docs)\/)[^/]+\/(?!-\/|-$)[^/]+(?:\/(?:code|commits|issues|pulls|pull\/\d+|issues\/\d+|commit\/[0-9a-f]+|tree\/.+|blob\/.+))?(?:\.data)?$/;
/** Fresh for this long; then served once more while a new copy is made. */
const PUBLIC_FRESH_SECONDS = 30;
const PUBLIC_STALE_SECONDS = 300;
/** The longest a cache lookup holds up a public page. */
const CACHE_DEADLINE_MS = 2_000;

function anonymousPage(request: Request, pathname: string): boolean {
  if (request.method !== "GET") return false;
  // A cached data response must not bypass the build-switch middleware.
  if (needsBuildRefresh(request, import.meta.env.G1T_BUILD_ID)) return false;
  if (/(?:^|;\s*)g1t_session=/.test(request.headers.get("cookie") ?? "")) return false;
  // A token signs the request in (app/lib/website-token.ts): never kept, never served a kept page.
  if (request.headers.has("authorization")) return false;
  return PUBLIC_TOP.test(pathname) || PUBLIC_PROJECT.test(pathname);
}

async function servePublic(env: Env, request: Request, ctx: ExecutionContext, render: () => Promise<Response>): Promise<Response> {
  const cache = (caches as unknown as { default: Cache }).default;
  const keyUrl = new URL(request.url);
  // Cached HTML and route data belong to the build that rendered them.
  keyUrl.searchParams.set("_g1t_build", import.meta.env.G1T_BUILD_ID);
  // Vary alone does not partition the Workers Cache API's explicit key.
  keyUrl.searchParams.set("_g1t_representation", pageRepresentation(request.headers.get("accept")));
  const key = new Request(keyUrl, { method: "GET" });
  const repository = PUBLIC_PROJECT.test(new URL(request.url).pathname) ? repositoryOfPage(new URL(request.url).pathname) : null;
  const looking = Date.now();
  // Asked alongside the cache, so a hit waits for one indexed read at most.
  // A cache that does not answer is a miss: the page is drawn afresh.
  const [cached, visible] = await Promise.all([
    withDeadline("cache", CACHE_DEADLINE_MS, () => cache.match(key)).catch(() => undefined),
    repository ? isStillPublic(env, repository) : Promise.resolve(true),
  ]);
  if (cached && !visible) {
    ctx.waitUntil(
      cache.delete(key).then(
        () => undefined,
        () => undefined,
      ),
    );
    return render();
  }
  // No copy here: the one every data centre shares, kept by whichever drew
  // the page last after finding none of its own (lib/public-cache.ts).
  const pages = env.PAGES;
  const sharedKey = pages && !cached && visible ? await sharedPageKey(key.url) : null;
  const shared =
    pages && sharedKey
      ? await withDeadline("shared cache", CACHE_DEADLINE_MS, () => pages.get(sharedKey, "arrayBuffer"))
          .then((bytes) => (bytes ? decodeSharedPage(new Uint8Array(bytes)) : null))
          .catch(() => null)
      : null;
  const lookupMs = Date.now() - looking;
  const keptAt = cached ? Number(cached.headers.get("x-g1t-kept-at") ?? 0) : (shared?.keptAt ?? 0);
  const age = Math.round((Date.now() - keptAt) / 1000);
  const refresh = async () => {
    const fresh = await render();
    // Only a plain answer for everyone: nothing that sets a cookie or says
    // it is private.
    const cacheable =
      (fresh.status === 200 || fresh.status === 404) && !fresh.headers.has("set-cookie") && !/private|no-store/.test(fresh.headers.get("cache-control") ?? "");
    if (cacheable) {
      const now = Date.now();
      const copy = new Response(fresh.clone().body, fresh);
      copy.headers.set("x-g1t-kept-at", String(now));
      copy.headers.set("cache-control", `public, max-age=${PUBLIC_STALE_SECONDS}`);
      ctx.waitUntil(cache.put(key, copy));
      // Shared only by a data centre that had no copy of its own, so it is
      // written at most once per data centre per page while it is kept,
      // not by every data centre's refresh of its own.
      if (pages && sharedKey) {
        const body = fresh.clone().arrayBuffer();
        ctx.waitUntil(
          body
            .then((bytes) =>
              pages.put(sharedKey, encodeSharedPage({ status: fresh.status, headers: [...fresh.headers], keptAt: now, body: new Uint8Array(bytes) }), {
                expirationTtl: PUBLIC_STALE_SECONDS,
              }),
            )
            .catch(() => undefined),
        );
      }
    }
    return fresh;
  };
  if ((cached || shared) && keptAt > 0 && age < PUBLIC_STALE_SECONDS) {
    if (age >= PUBLIC_FRESH_SECONDS)
      ctx.waitUntil(
        refresh().then(
          () => undefined,
          () => undefined,
        ),
      );
    let answer: Response;
    if (cached) {
      answer = new Response(cached.body, cached);
    } else {
      answer = new Response(shared!.body, { status: shared!.status, headers: shared!.headers });
      // Kept here too, as old as it is, so this data centre's next visitor reads it from here.
      const copy = new Response(shared!.body, { status: shared!.status, headers: shared!.headers });
      copy.headers.set("x-g1t-kept-at", String(keptAt));
      copy.headers.set("cache-control", `public, max-age=${PUBLIC_STALE_SECONDS}`);
      if (age < PUBLIC_FRESH_SECONDS) ctx.waitUntil(cache.put(key, copy).catch(() => undefined));
    }
    answer.headers.delete("x-g1t-kept-at");
    answer.headers.delete("cache-control");
    answer.headers.set("server-timing", `cache;desc="${cached ? "hit" : "hit-shared"}, ${age}s old", lookup;dur=${lookupMs}`);
    return answer;
  }
  return refresh();
}

/**
 * A crawler's request (app/lib/crawlers.ts), without its cookies or token.
 * A public page is served from this data centre's cache, kept for six hours
 * (a page of one commit for a day) under its address alone, and drawn only
 * when it is not there; a costly page drawn counts against the crawler's
 * limit. A repository's kept page is served only while it is public, as for
 * people, but whether it is public is kept for a minute: repos asked on
 * every hit would be most of what a crawler still costs.
 */
async function serveCrawler(env: Env, request: Request, ctx: ExecutionContext, family: string): Promise<Response> {
  const anonymous = signedOut(request);
  const render = () => withRequestPerf(anonymous, async () => finishResponse(anonymous, await requestHandler(anonymous)));
  const url = new URL(request.url);
  const costly = costlyForCrawlers(url);
  const kept =
    request.method === "GET" &&
    !needsBuildRefresh(request, import.meta.env.G1T_BUILD_ID) &&
    (PUBLIC_TOP.test(url.pathname) || PUBLIC_PROJECT.test(url.pathname) || alsoKeptForCrawlers(url.pathname));
  if (!kept) return (costly ? await crawlerLimited(env, family) : null) ?? render();
  const cache = (caches as unknown as { default: Cache }).default;
  const key = crawlerCacheKey(url, pageRepresentation(request.headers.get("accept")));
  const cached = await withDeadline("cache", CACHE_DEADLINE_MS, () => cache.match(key)).catch(() => undefined);
  const repository = PUBLIC_TOP.test(url.pathname) ? null : repositoryOfPage(url.pathname);
  if (cached && (!repository || (await publicForCrawlers(env, ctx, url.origin, repository)))) {
    const age = Math.round((Date.now() - Number(cached.headers.get("x-g1t-kept-at") ?? Date.now())) / 1000);
    const answer = new Response(cached.body, cached);
    answer.headers.delete("x-g1t-kept-at");
    answer.headers.delete("cache-control");
    answer.headers.set("server-timing", `cache;desc="crawler hit, ${age}s old"`);
    return answer;
  }
  if (costly) {
    const limited = await crawlerLimited(env, family);
    if (limited) return limited;
  }
  const fresh = await render();
  if (keptForCrawlers(fresh)) {
    const copy = new Response(fresh.clone().body, fresh);
    copy.headers.set("x-g1t-kept-at", String(Date.now()));
    copy.headers.set("cache-control", `public, max-age=${crawlerKeepSeconds(url)}`);
    ctx.waitUntil(cache.put(key, copy).catch(() => undefined));
  }
  return fresh;
}

/** How long whether a repository is public is kept for crawlers. */
const CRAWLER_VISIBILITY_SECONDS = 60;

/** Whether the repository is public, asked of repos at most once a minute per data centre. */
async function publicForCrawlers(env: Env, ctx: ExecutionContext, origin: string, repository: string): Promise<boolean> {
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(`${origin}/_g1t/crawler-visibility/${encodeURIComponent(repository)}`, { method: "GET" });
  const known = await withDeadline("cache", CACHE_DEADLINE_MS, () => cache.match(key)).catch(() => undefined);
  if (known) return (await known.text()) === "public";
  const visible = await isStillPublic(env, repository);
  const answer = new Response(visible ? "public" : "not public", { headers: { "cache-control": `public, max-age=${CRAWLER_VISIBILITY_SECONDS}` } });
  ctx.waitUntil(cache.put(key, answer).catch(() => undefined));
  return visible;
}

/** Whether the repository is there and public; anything else, including no answer, is no. */
async function isStillPublic(env: Env, repository: string): Promise<boolean> {
  try {
    return await withDeadline("repos visibility", READ_DEADLINE_MS, async (signal) => {
      const answer = await env.REPOS.fetch("https://service/rpc/visibility", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paths: [repository] }),
        signal,
      });
      return answer.ok && stillPublic(await answer.json(), repository);
    });
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
