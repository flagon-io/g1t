/**
 * Social cards: the PNG a link to g1t shows in a chat, a post or a search
 * result, at `https://og.g1t.sh`.
 *
 *   GET /image?path=/<any page of g1t.sh>[&v=<version>]
 *   GET /docs?title=&section=&description=[&v=<version>]
 *
 * A page's card is looked up as an anonymous visitor would see the page,
 * so nothing private ever reaches one (see `resolve.ts`). Cards are kept in
 * the edge cache under the render version and the parameters that change
 * them (see `cache.ts`). The site and the docs add `v`, which changes when
 * the design does (`OG_RENDER_VERSION` in packages/contracts) or when what
 * a card shows does, so a new logo or an edited title gets a new address.
 *
 * Also the `Screenshots` entrypoint, reached only through service
 * bindings: a screenshot of each project's production, per deploy (see
 * `capture.ts`).
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { type ServiceBinding, identityClient, projectsClient, reposClient, workClient } from "@g1t/contracts";
import type { Font } from "satori/standalone";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import yogaWasm from "satori/yoga.wasm";

import display500 from "./fonts/bricolage-grotesque-500.ttf";
import display600 from "./fonts/bricolage-grotesque-600.ttf";
import sans400 from "./fonts/hanken-grotesk-400.ttf";
import sans500 from "./fonts/hanken-grotesk-500.ttf";
import sans600 from "./fonts/hanken-grotesk-600.ttf";
import sans700 from "./fonts/hanken-grotesk-700.ttf";
import mono400 from "./fonts/ibm-plex-mono-400.ttf";
import mono500 from "./fonts/ibm-plex-mono-500.ttf";
import { cardPng } from "./render.ts";
import { cacheKey } from "./cache.ts";
import { type Shot, screenshotOf, take } from "./capture.ts";
import { parseShot } from "./screenshot.ts";
import { BRAND, type Card, docsCard, resolve } from "./resolve.ts";

interface Env {
  /** Uploaded avatars by hash, with `{ contentType }`; written by identity. */
  AVATARS: KVNamespace;
  IDENTITY: ServiceBinding;
  REPOS: ServiceBinding;
  WORK: ServiceBinding;
  PROJECTS: ServiceBinding;
  /** Browser Rendering, for production screenshots. */
  BROWSER: Fetcher;
  /** Production screenshots, by app hostname. */
  SCREENSHOTS: R2Bucket;
}

/**
 * Production screenshots. `capture` is called by deployments when
 * production goes live; `image` by the site, for a project's overview, which
 * decides who may see it.
 */
export class Screenshots extends WorkerEntrypoint<Env> {
  /** Takes the screenshot of `{ host, commit }` in the background. */
  async capture(input: unknown): Promise<boolean> {
    const request = parseShot(input);
    if (!request) return false;
    this.ctx.waitUntil(take(this.env, request));
    return true;
  }

  /**
   * The screenshot of `{ host, commit }`, taken now if it has not been, or
   * the last one kept for that app. Its `commit` says which it is.
   */
  async image(input: unknown): Promise<Shot | null> {
    const request = parseShot(input);
    if (!request) return null;
    return screenshotOf(this.env, request);
  }
}

/*
 * g1t's typefaces, as on the site (packages/theme), but static: the
 * renderer takes no variable fonts. Bricolage is cut at the optical size
 * of the headlines it sets on a card.
 */
const FONTS: Font[] = [
  { name: "Hanken Grotesk", data: sans400, weight: 400, style: "normal" },
  { name: "Hanken Grotesk", data: sans500, weight: 500, style: "normal" },
  { name: "Hanken Grotesk", data: sans600, weight: 600, style: "normal" },
  { name: "Hanken Grotesk", data: sans700, weight: 700, style: "normal" },
  { name: "Bricolage Grotesque", data: display500, weight: 500, style: "normal" },
  { name: "Bricolage Grotesque", data: display600, weight: 600, style: "normal" },
  { name: "IBM Plex Mono", data: mono400, weight: 400, style: "normal" },
  { name: "IBM Plex Mono", data: mono500, weight: 500, style: "normal" },
];

const ASSETS = { yoga: yogaWasm, resvg: resvgWasm, fonts: FONTS };

/** Kept an hour by browsers and a day at the edge. */
const CACHE_CONTROL = "public, max-age=3600, s-maxage=86400";
/** When a service could not be reached: soon tried again. */
const BRIEF_CACHE_CONTROL = "public, max-age=60";

/** When even the brand card cannot be drawn: never kept, so the next request tries again. */
const NO_STORE = "no-store";

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
    let fellBack = false;
    try {
      png = await cardPng(card, ASSETS);
    } catch (error) {
      console.error("og: rendering failed", url.pathname, error);
      try {
        // An icon it could not draw is left out rather than losing the card;
        // anything else gets the brand card, kept only briefly.
        if ((card.kind === "workspace" || card.kind === "person") && card.icon) {
          png = await cardPng({ ...card, icon: undefined }, ASSETS);
        } else if (card.kind !== "brand") {
          png = await cardPng(BRAND, ASSETS);
          fellBack = true;
        } else {
          throw error;
        }
      } catch (again) {
        console.error("og: the brand card could not be drawn either", again);
        return new Response("The card could not be drawn", { status: 503, headers: { "cache-control": NO_STORE } });
      }
    }
    const response = new Response(png, {
      headers: {
        "content-type": "image/png",
        "cache-control": CACHE_CONTROL,
        "access-control-allow-origin": "*",
        "x-content-type-options": "nosniff",
      },
    });
    if (fellBack) return withCacheControl(response, true);
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

/** What satori can draw: PNG and JPEG. A WebP or GIF icon is left off the card. */
const DRAWABLE = new Set(["image/png", "image/jpeg"]);

/** A workspace's or person's uploaded icon as a data URI, if it has one satori can draw. */
async function iconFor(env: Env, avatar: string | null | undefined): Promise<string | undefined> {
  if (!avatar || !/^[0-9a-f]{64}$/.test(avatar)) return undefined;
  try {
    const { value, metadata } = await env.AVATARS.getWithMetadata<{ contentType?: string }>(avatar, {
      type: "arrayBuffer",
    });
    const type = metadata?.contentType;
    if (!value || !type || !DRAWABLE.has(type)) return undefined;
    const bytes = new Uint8Array(value);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${type};base64,${btoa(binary)}`;
  } catch {
    return undefined;
  }
}

async function cardFor(url: URL, env: Env): Promise<Card> {
  const card = await lookUpCard(url, env);
  if (card.kind === "workspace" || card.kind === "person") return { ...card, icon: await iconFor(env, card.avatar) };
  return card;
}

async function lookUpCard(url: URL, env: Env): Promise<Card> {
  if (url.pathname === "/docs") return docsCard(url.searchParams);
  if (url.pathname === "/") return BRAND;
  return resolve(url.searchParams.get("path") ?? "/", {
    identity: identityClient(env.IDENTITY),
    repos: reposClient(env.REPOS),
    work: workClient(env.WORK),
    projects: projectsClient(env.PROJECTS),
  });
}
