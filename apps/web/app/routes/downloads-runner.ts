import { env } from "cloudflare:workers";

import type { Route } from "./+types/downloads-runner";

/**
 * The self-hosted runner's releases: `g1t.sh/downloads/runner/<version>/<file>`,
 * served from the g1t-downloads R2 bucket that scripts/runner-release.mjs
 * publishes to. `latest/<file>` is the newest release's, as its signed
 * `latest.json` names it; `latest.json` and `latest.json.sig` themselves
 * are what runners check before updating.
 */
const TYPES: Record<string, string> = {
  json: "application/json",
  sig: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

async function object(key: string): Promise<R2ObjectBody | null> {
  const bucket = env.DOWNLOADS;
  return bucket ? bucket.get(key) : null;
}

export async function loader({ params }: Route.LoaderArgs) {
  const path = (params["*"] ?? "").replace(/^\/+/, "");
  if (!path || path.includes("..") || !/^[A-Za-z0-9._/-]+$/.test(path)) throw new Response("Not found\n", { status: 404 });
  let key = `runner/${path}`;
  // `latest/<file>`: the file of the newest release.
  if (path.startsWith("latest/")) {
    const manifest = await object("runner/latest.json");
    if (!manifest) throw new Response("No release yet\n", { status: 404 });
    const { version } = (await manifest.json()) as { version: string };
    key = `runner/${version}/${path.slice("latest/".length)}`;
  }
  const found = await object(key);
  if (!found) throw new Response("Not found\n", { status: 404 });
  const name = key.split("/").pop() ?? "g1t-runner";
  const extension = name.includes(".") ? name.split(".").pop()! : "";
  const headers = new Headers({
    "content-type": TYPES[extension] ?? "application/octet-stream",
    etag: found.httpEtag,
    // A version's files never change; what `latest` points to does.
    "cache-control": path.startsWith("latest") ? "public, max-age=300" : "public, max-age=31536000, immutable",
  });
  if (!TYPES[extension]) headers.set("content-disposition", `attachment; filename="${name}"`);
  return new Response(found.body, { headers });
}
