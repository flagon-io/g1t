/**
 * Taking and keeping production screenshots with Browser Rendering.
 *
 * A screenshot is a few seconds of browser time (at most `SETTLE_MS` and
 * the shot itself): Workers Paid includes 10 browser hours a month and
 * charges $0.09 an hour after that, so one costs about $0.0001-$0.0003.
 * Each production deploy on g1t.page takes at most one, plus a retry after
 * `RETRY_AFTER_MS` if it failed. A production deployed elsewhere takes one
 * when its address is set or changed and when a production deployment is
 * reported for it, and otherwise at most one a day, from the daily cron
 * (at most `EXTERNAL_PER_RUN` a run): a hundred such projects come to
 * about 3,000 shots and 4 to 10 browser hours a month. A project that
 * shows an uploaded image instead is not visited at all. That is small
 * enough not to meter.
 */
import puppeteer from "@cloudflare/puppeteer";

import {
  type ExternalShot,
  SETTLE_MS,
  type ShotRequest,
  VIEWPORT,
  attemptKey,
  dayOf,
  dueForRefresh,
  expired,
  externalAttemptKey,
  externalShotKey,
  isCurrent,
  isFresh,
  parseExternalShot,
  shotKey,
  shouldAttempt,
} from "./screenshot.ts";

export type ShotEnv = {
  BROWSER: Fetcher;
  SCREENSHOTS: R2Bucket;
};

export type Shot = { body: ArrayBuffer; contentType: string; commit: string; capturedAt: string };

/** Where one screenshot is kept and its attempts noted, and the page it shows. */
type Target = { key: string; attempt: string; url: string; host: string; commit: string };

async function read(env: ShotEnv, key: string): Promise<Shot | null> {
  const object = await env.SCREENSHOTS.get(key);
  if (!object) return null;
  return {
    body: await object.arrayBuffer(),
    contentType: object.httpMetadata?.contentType ?? "image/jpeg",
    commit: object.customMetadata?.commit ?? "",
    capturedAt: object.customMetadata?.capturedAt ?? object.uploaded.toISOString(),
  };
}

/** The kept screenshot, whatever commit it shows. */
export function stored(env: ShotEnv, host: string): Promise<Shot | null> {
  return read(env, shotKey(host));
}

/** The kept screenshot of a production deployed elsewhere, by its host. */
export function storedExternal(env: ShotEnv, host: string): Promise<Shot | null> {
  return read(env, externalShotKey(host));
}

/** Takes the target's screenshot, unless one was tried for its commit moments ago. */
async function shoot(env: ShotEnv, target: Target): Promise<Shot | null> {
  const marker = await env.SCREENSHOTS.head(target.attempt);
  if (!shouldAttempt(marker?.customMetadata, target.commit, Date.now())) return null;
  const at = new Date().toISOString();
  await env.SCREENSHOTS.put(target.attempt, "", { customMetadata: { commit: target.commit, at } });

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch(env.BROWSER as unknown as Parameters<typeof puppeteer.launch>[0]);
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    // A page that keeps the network busy is taken as it is when time is up.
    await page.goto(target.url, { waitUntil: "networkidle2", timeout: SETTLE_MS }).catch((error: unknown) => {
      console.warn("og: page did not settle", target.host, String(error));
    });
    const image = (await page.screenshot({ type: "jpeg", quality: 80 })) as Uint8Array;
    const body = image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength) as ArrayBuffer;
    const capturedAt = new Date().toISOString();
    await env.SCREENSHOTS.put(target.key, body, {
      httpMetadata: { contentType: "image/jpeg" },
      customMetadata: { commit: target.commit, capturedAt },
    });
    return { body, contentType: "image/jpeg", commit: target.commit, capturedAt };
  } catch (error) {
    console.error("og: screenshot failed", target.host, error);
    return null;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

/**
 * Takes the screenshot of `commit` of an app on g1t.page, unless one was
 * tried for it moments ago. Returns it, or null when it was not taken.
 */
export function take(env: ShotEnv, { host, commit }: ShotRequest): Promise<Shot | null> {
  return shoot(env, { key: shotKey(host), attempt: attemptKey(host), url: `https://${host}/`, host, commit });
}

/** Takes the screenshot of a production deployed elsewhere, at its address. */
export function takeExternal(env: ShotEnv, { host, url, commit }: ExternalShot): Promise<Shot | null> {
  return shoot(env, { key: externalShotKey(host), attempt: externalAttemptKey(host), url, host, commit });
}

/** The screenshot of the request's deploy, taken now if it has not been; else the last one kept. */
export async function screenshotOf(env: ShotEnv, request: ShotRequest): Promise<Shot | null> {
  const kept = await stored(env, request.host);
  if (kept && isCurrent(kept, request)) return kept;
  return (await take(env, request)) ?? kept;
}

/**
 * The screenshot of a production deployed elsewhere: the one kept, with
 * `stale` when it should be taken again (older than a day, or than the
 * deploy the request names), which the caller does in the background. With
 * none kept, it is taken now.
 */
export async function externalOf(env: ShotEnv, request: ExternalShot, now = Date.now()): Promise<{ shot: Shot | null; stale: boolean }> {
  const kept = await storedExternal(env, request.host);
  if (kept) return { shot: kept, stale: !isFresh(kept, now, request.since) };
  return { shot: await takeExternal(env, request), stale: false };
}

/**
 * The daily refresh of productions deployed elsewhere: each address whose
 * screenshot is missing or more than a day old is taken again, the
 * stalest first, one at a time, at most `EXTERNAL_PER_RUN`. Addresses that
 * are not public are skipped. Returns how many were taken.
 */
export async function refreshExternal(env: ShotEnv, urls: readonly string[], now = Date.now()): Promise<number> {
  const day = dayOf(now);
  const byHost = new Map<string, ExternalShot>();
  for (const url of urls) {
    const request = parseExternalShot({ url, commit: day });
    if (request && !byHost.has(request.host)) byHost.set(request.host, request);
  }
  const targets = await Promise.all(
    [...byHost.values()].map(async (request) => {
      const head = await env.SCREENSHOTS.head(externalShotKey(request.host)).catch(() => null);
      return { request, capturedAt: head ? (head.customMetadata?.capturedAt ?? head.uploaded.toISOString()) : null };
    }),
  );
  let taken = 0;
  for (const { request } of dueForRefresh(targets, now)) {
    if (await takeExternal(env, request)) taken += 1;
  }
  return taken;
}

/**
 * Deletes screenshots and attempt notes older than `KEEP_DAYS`: apps that
 * moved or were removed leave theirs behind, and a live app's is taken
 * again the next time its page asks. Returns how many went.
 */
export async function sweep(env: ShotEnv, now = Date.now()): Promise<number> {
  let removed = 0;
  for (const prefix of ["production/", "external/", "attempts/"]) {
    let cursor: string | undefined;
    do {
      const page = await env.SCREENSHOTS.list({ prefix, cursor, limit: 500 });
      const old = page.objects.filter((object) => expired(object.uploaded, now)).map((object) => object.key);
      if (old.length) {
        await env.SCREENSHOTS.delete(old);
        removed += old.length;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  return removed;
}
