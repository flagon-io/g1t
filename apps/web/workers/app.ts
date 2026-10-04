import { createRequestHandler } from "react-router";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

const GIT_PATH = /\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const DOCS = "https://docs.g1t.sh";

/** Where the documentation pages that used to live under /docs are now. */
const MOVED_DOCS: Record<string, string> = {
  "/docs": "/quickstart/",
  "/docs/concepts": "/concepts/overview/",
  "/docs/authentication": "/guides/authentication/",
  "/docs/git": "/guides/git/",
  "/docs/g1t-agents": "/guides/g1t-agents/",
  "/docs/agents": "/guides/bring-your-own-agent/",
  "/docs/api": "/reference/api/",
  "/docs/api/reference": "/reference/api/",
};

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    // Git over HTTPS shares this hostname but belongs to the repos service.
    if (GIT_PATH.test(pathname)) {
      return env.REPOS.fetch(request);
    }
    // The documentation is its own site.
    if (pathname === "/docs" || pathname.startsWith("/docs/")) {
      const page = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
      const target = MOVED_DOCS[page] ?? "/";
      return Response.redirect(DOCS + target, 301);
    }
    return requestHandler(request);
  },
} satisfies ExportedHandler<Env>;
