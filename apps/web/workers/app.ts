import { createRequestHandler } from "react-router";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

const GIT_PATH = /\/(info\/refs|git-upload-pack|git-receive-pack)$/;
/** An uploaded avatar, by the SHA-256 of its bytes. */
const AVATAR_PATH = /^\/avatars\/([0-9a-f]{64})$/;
/** The only types identity stores, having checked each image's bytes. */
const AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
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
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    // Git over HTTPS shares this hostname but belongs to the repos service.
    // Its answer goes back to the git client as it is: a repository under a
    // renamed workspace's old name answers with a 301, which git follows and
    // must see, so the redirect is never followed here.
    if (GIT_PATH.test(pathname)) {
      return env.REPOS.fetch(new Request(request, { redirect: "manual" }));
    }
    const avatar = AVATAR_PATH.exec(pathname);
    if (avatar) {
      return serveAvatar(env, ctx, request, avatar[1]);
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

/**
 * An uploaded avatar. Its address is its hash, so it never changes and is
 * kept for good. It is served as nothing but an image: the stored type,
 * no sniffing, and a policy that lets nothing in it run.
 */
/**
 * An uploaded icon. Its address is its content's hash, so it never changes:
 * each data centre keeps it in its cache after the first view, and storage
 * is read about once per place, not once per visitor.
 */
async function serveAvatar(env: Env, ctx: ExecutionContext, request: Request, hash: string): Promise<Response> {
  const method = request.method;
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  // The Workers runtime's own cache, which the DOM types do not know.
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(new URL(`/avatars/${hash}`, request.url).toString(), { method: "GET" });
  const cached = await cache.match(key);
  if (cached) {
    return method === "HEAD" ? new Response(null, { headers: cached.headers }) : cached;
  }
  const { value, metadata } = await env.AVATARS.getWithMetadata<{ contentType?: string }>(hash, {
    type: "arrayBuffer",
    cacheTtl: 86400,
  });
  const contentType = metadata?.contentType;
  if (!value || !contentType || !AVATAR_TYPES.has(contentType)) {
    return new Response("Not found", {
      status: 404,
      headers: { "cache-control": "public, max-age=60" },
    });
  }
  const headers = {
    "content-type": contentType,
    "content-length": String(value.byteLength),
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "cross-origin",
  };
  ctx.waitUntil(cache.put(key, new Response(value, { headers })));
  return new Response(method === "HEAD" ? null : value, { headers });
}
