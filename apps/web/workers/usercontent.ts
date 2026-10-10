/**
 * The usercontent origin (app/lib/usercontent.ts): repository files and
 * uploaded avatars, on g1tusercontent.com for g1t.sh. This answers before
 * anything of the site's runs, and reads no cookie and sets none: nothing
 * here knows who is asking, only what the address and its token say.
 */
import { reposClient } from "@g1t/contracts";

import { MAX_RAW_BYTES, PDF_POLICY, USERCONTENT_POLICY, isCommit, parseRawPath, rawHeaders, verifyRaw } from "../app/lib/usercontent";

/** An uploaded avatar, by the SHA-256 of its bytes. */
export const AVATAR_PATH = /^\/avatars\/([0-9a-f]{64})$/;
/** A workspace's custom emoji, by the SHA-256 of its bytes: kept by chat under `emoji/<hash>` in the same namespace. */
export const EMOJI_PATH = /^\/emoji\/([0-9a-f]{64})$/;
/** A file put in a Docs page, by its random key: kept by the artifacts service (services/artifacts). */
export const DOCS_FILE_PATH = /^\/docs-files\/([0-9a-f]{64})$/;
/** The only types identity stores, having checked each image's bytes. */
const AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function plain(status: number, message: string, cache = "no-store"): Response {
  return new Response(`${message}\n`, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": cache,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

/** Answers a request for `path`, the part of its address under the usercontent origin. */
export async function serveUsercontent(env: Env, ctx: ExecutionContext, request: Request, path: string): Promise<Response> {
  const method = request.method;
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method not allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  if (path === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /\n", { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=86400" } });
  }
  const avatar = AVATAR_PATH.exec(path);
  if (avatar) return serveAvatar(env, ctx, method, avatar[1]!, new URL(request.url).origin);
  const emoji = EMOJI_PATH.exec(path);
  if (emoji) return serveAvatar(env, ctx, method, `emoji/${emoji[1]!}`, new URL(request.url).origin);
  const docsFile = DOCS_FILE_PATH.exec(path);
  if (docsFile) return serveDocsFile(env, method, docsFile[1]!);
  const file = parseRawPath(path);
  if (file) return serveRaw(env, request, method, file);
  return plain(404, "Not found", "public, max-age=300");
}

/**
 * A repository's file. A public repository's to anyone; a private one's
 * only with a token for this very file (routes/repo/raw.ts makes them).
 */
async function serveRaw(env: Env, request: Request, method: string, file: NonNullable<ReturnType<typeof parseRawPath>>): Promise<Response> {
  const repos = reposClient(env.REPOS);
  const token = new URL(request.url).searchParams.get("token");
  let repoId: string | null = null;
  let isPublic = false;
  if (token) {
    if (!env.USERCONTENT_KEY) return plain(404, "Not found");
    repoId = await verifyRaw(env.USERCONTENT_KEY, file, token);
    if (!repoId) return plain(403, "This address has expired. Open the file on g1t again for a new one.");
  } else {
    // No viewer: only a public repository answers.
    const found = await repos.get({ namespace: file.owner, name: file.repo }, null).catch(() => null);
    if (!found?.ok) return plain(404, "There is no such file, or it is not public.", "public, max-age=60");
    repoId = found.value.id;
    isPublic = true;
  }
  const raw = await repos.rawFile(repoId, file.ref, file.path, MAX_RAW_BYTES).catch(() => null);
  if (!raw) return plain(404, `There is no such file, or it is over ${MAX_RAW_BYTES / 1024 / 1024} MB. Clone the repository for it.`, "public, max-age=60");
  const bytes = Uint8Array.from(atob(raw.data), (c) => c.charCodeAt(0));
  const headers = rawHeaders(file.path, bytes);
  // A commit's files never change; a branch's or tag's may.
  const lasting = isCommit(file.ref);
  headers.set(
    "cache-control",
    isPublic ? (lasting ? "public, max-age=31536000, immutable" : "public, max-age=60") : lasting ? "private, max-age=3600" : "private, max-age=60",
  );
  if (lasting) headers.set("etag", `"${file.ref}"`);
  return new Response(method === "HEAD" ? null : bytes, { headers });
}

/**
 * An uploaded avatar, or a custom emoji (`key` is then `emoji/<hash>`). Its
 * address is its hash, so it never changes and is
 * kept for good: each data centre keeps it in its cache after the first
 * view, and storage is read about once per place, not once per visitor.
 * It is served as nothing but an image: the stored type, no sniffing, and
 * a policy that lets nothing in it run.
 */
async function serveAvatar(env: Env, ctx: ExecutionContext, method: string, key: string, origin: string): Promise<Response> {
  // The Workers runtime's own cache, which the DOM types do not know.
  const cache = (caches as unknown as { default: Cache }).default;
  const cacheKey = new Request(`${origin}/${key.startsWith("emoji/") ? key : `avatars/${key}`}`, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) {
    return method === "HEAD" ? new Response(null, { headers: cached.headers }) : cached;
  }
  const { value, metadata } = await env.AVATARS.getWithMetadata<{ contentType?: string }>(key, {
    type: "arrayBuffer",
    cacheTtl: 86400,
  });
  const contentType = metadata?.contentType;
  if (!value || !contentType || !AVATAR_TYPES.has(contentType)) {
    return plain(404, "Not found", "public, max-age=60");
  }
  const headers = {
    "content-type": contentType,
    "content-length": String(value.byteLength),
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "cross-origin",
  };
  ctx.waitUntil(cache.put(cacheKey, new Response(value, { headers })));
  return new Response(method === "HEAD" ? null : value, { headers });
}

/**
 * A file put in a Docs page. Its key is 256 random bits the artifacts service
 * made, so the address is the permission, as a shared link is; the docs
 * service serves images, media and PDFs as themselves and everything else
 * as a download, and nothing here can run script.
 */
async function serveDocsFile(env: Env, method: string, key: string): Promise<Response> {
  let answer: Response;
  try {
    answer = await env.ARTIFACTS.fetch(`https://docs/files/${key}`, { method });
  } catch {
    return plain(503, "Docs didn't answer");
  }
  if (!answer.ok) return plain(answer.status === 404 ? 404 : 502, "Not found", "public, max-age=60");
  const headers = new Headers(answer.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", headers.get("content-type") === "application/pdf" ? PDF_POLICY : USERCONTENT_POLICY);
  headers.set("cross-origin-resource-policy", "cross-origin");
  return new Response(method === "HEAD" ? null : answer.body, { status: 200, headers });
}
