/**
 * Social cards: the PNG a link to g1t shows in a chat, a post or a search
 * result, at `https://og.g1t.sh`.
 *
 *   GET /image?path=/<any page of g1t.sh>[&v=<version>]
 *   GET /docs?title=&section=&description=
 *
 * A page's card is looked up as an anonymous visitor would see the page,
 * so nothing private ever reaches one (see `resolve.ts`). Cards are kept in
 * the edge cache by their full address; the site adds `v`, which changes
 * when what a card shows does, so an edited title gets a new card.
 */
import { type ServiceBinding, identityClient, projectsClient, reposClient, workClient } from "@g1t/contracts";
import type { Font } from "satori/standalone";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import yogaWasm from "satori/yoga.wasm";

import inter400 from "./fonts/inter-400.ttf";
import inter500 from "./fonts/inter-500.ttf";
import inter600 from "./fonts/inter-600.ttf";
import inter700 from "./fonts/inter-700.ttf";
import mono400 from "./fonts/jetbrains-mono-400.ttf";
import mono500 from "./fonts/jetbrains-mono-500.ttf";
import { cardPng } from "./render.ts";
import { cacheKey } from "./cache.ts";
import { BRAND, type Card, docsCard, resolve } from "./resolve.ts";

interface Env {
  IDENTITY: ServiceBinding;
  REPOS: ServiceBinding;
  WORK: ServiceBinding;
  PROJECTS: ServiceBinding;
}

const FONTS: Font[] = [
  { name: "Inter", data: inter400, weight: 400, style: "normal" },
  { name: "Inter", data: inter500, weight: 500, style: "normal" },
  { name: "Inter", data: inter600, weight: 600, style: "normal" },
  { name: "Inter", data: inter700, weight: 700, style: "normal" },
  { name: "JetBrains Mono", data: mono400, weight: 400, style: "normal" },
  { name: "JetBrains Mono", data: mono500, weight: 500, style: "normal" },
];

const ASSETS = { yoga: yogaWasm, resvg: resvgWasm, fonts: FONTS };

/** Kept an hour by browsers and a day at the edge. */
const CACHE_CONTROL = "public, max-age=3600, s-maxage=86400";
/** When a service could not be reached: soon tried again. */
const BRIEF_CACHE_CONTROL = "public, max-age=60";

/** The static card, for when rendering itself fails. */
const FALLBACK = "https://g1t.sh/brand/g1t-og.png";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname !== "/" && url.pathname !== "/image" && url.pathname !== "/docs") {
      return new Response("Not found", { status: 404 });
    }

    const key = cacheKey(url);
    const cache = (caches as unknown as { default: Cache }).default;
    const hit = await cache.match(key);
    if (hit) return hit;

    const card = await cardFor(url, env);
    const failed = card.kind === "brand" && card.failed === true;
    // Every page without a card of its own shares the one brand card, so
    // made-up paths cannot make the service draw it again and again.
    const brandKey = cacheKey(new URL("/", url));
    if (card.kind === "brand" && key !== brandKey) {
      const brand = await cache.match(brandKey);
      if (brand) return withCacheControl(brand, failed);
    }

    let png: Uint8Array;
    try {
      png = await cardPng(card, ASSETS);
    } catch (error) {
      console.error("og: rendering failed", url.pathname, error);
      return Response.redirect(FALLBACK, 302);
    }
    const response = new Response(png, {
      headers: {
        "content-type": "image/png",
        "cache-control": CACHE_CONTROL,
        "access-control-allow-origin": "*",
        "x-content-type-options": "nosniff",
      },
    });
    if (card.kind === "brand") {
      ctx.waitUntil(cache.put(brandKey, response.clone()));
    } else {
      ctx.waitUntil(cache.put(key, response.clone()));
    }
    return withCacheControl(response, failed);
  },
} satisfies ExportedHandler<Env>;

/** A card shown because a service failed is kept only briefly, by anyone. */
function withCacheControl(response: Response, failed: boolean): Response {
  if (!failed) return response;
  const brief = new Response(response.body, response);
  brief.headers.set("cache-control", BRIEF_CACHE_CONTROL);
  return brief;
}

async function cardFor(url: URL, env: Env): Promise<Card> {
  if (url.pathname === "/docs") return docsCard(url.searchParams);
  if (url.pathname === "/") return BRAND;
  return resolve(url.searchParams.get("path") ?? "/", {
    identity: identityClient(env.IDENTITY),
    repos: reposClient(env.REPOS),
    work: workClient(env.WORK),
    projects: projectsClient(env.PROJECTS),
  });
}
