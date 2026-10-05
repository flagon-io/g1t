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
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    // Git over HTTPS shares this hostname but belongs to the repos service.
    if (GIT_PATH.test(pathname)) {
      return env.REPOS.fetch(request);
    }
    const avatar = AVATAR_PATH.exec(pathname);
    if (avatar) {
      return serveAvatar(env, avatar[1], request.method);
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
async function serveAvatar(env: Env, hash: string, method: string): Promise<Response> {
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
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
  return new Response(method === "HEAD" ? null : value, {
    headers: {
      "content-type": contentType,
      "content-length": String(value.byteLength),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "cross-origin",
    },
  });
}
