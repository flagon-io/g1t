import { createRequestHandler } from "react-router";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

const GIT_PATH = /\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const DOCS_HOST = "docs.g1t.sh";
const SITE = "https://g1t.sh";

/**
 * docs.g1t.sh serves the site's /docs pages from its root: /concepts there
 * is /docs/concepts here. Anything on that hostname that is not
 * documentation belongs to the main site.
 */
function docsRequest(request: Request, url: URL): Request | Response {
  const { pathname } = url;
  if (pathname === "/docs" || pathname.startsWith("/docs/")) return request;
  // React Router's data requests for in-site navigation.
  if (pathname.startsWith("/__manifest") || pathname.endsWith(".data")) return request;
  const first = pathname.split("/")[1];
  if (DOCS_PAGES.has(first)) {
    url.pathname = "/docs" + (pathname === "/" ? "" : pathname);
    return new Request(url, request);
  }
  return Response.redirect(SITE + pathname + url.search, 302);
}

/** First path segments that are documentation; "" is the docs home page. */
const DOCS_PAGES = new Set([
  "",
  "concepts",
  "authentication",
  "git",
  "g1t-agents",
  "agents",
  "api",
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Git over HTTPS shares this hostname but belongs to the repos service.
    if (GIT_PATH.test(url.pathname)) {
      return env.REPOS.fetch(request);
    }
    if (url.hostname === DOCS_HOST) {
      const rewritten = docsRequest(request, url);
      if (rewritten instanceof Response) return rewritten;
      return requestHandler(rewritten);
    }
    return requestHandler(request);
  },
} satisfies ExportedHandler<Env>;
