/** Only built public assets can be read from the release bucket. */
export function archivedAssetKey(pathname: string): string | null {
  if (!/^\/assets\/[a-zA-Z0-9_.~-]+\.(?:js|css|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|ico|wasm)$/.test(pathname)) return null;
  return `web-assets${pathname}`;
}

/** Current assets are served by Cloudflare before the Worker; misses land here. */
export async function serveArchivedAsset(request: Request, bucket: Pick<R2Bucket, "get"> | undefined): Promise<Response> {
  const key = archivedAssetKey(new URL(request.url).pathname);
  if (!key || !["GET", "HEAD"].includes(request.method)) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  try {
    if (!bucket) throw new Error("Asset archive is not configured");
    const object = await bucket.get(key);
    if (!object) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", "public, max-age=31536000, immutable");
    headers.set("x-content-type-options", "nosniff");
    if (request.headers.get("if-none-match") === object.httpEtag) return new Response(null, { status: 304, headers });
    headers.set("content-length", String(object.size));
    return new Response(request.method === "HEAD" ? null : object.body, { headers });
  } catch {
    return new Response("Asset temporarily unavailable", { status: 503, headers: { "cache-control": "no-store", "retry-after": "1" } });
  }
}
