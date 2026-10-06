/**
 * Taking and keeping production screenshots with Browser Rendering.
 *
 * A screenshot is a few seconds of browser time: Workers Paid includes 10
 * browser hours a month and charges $0.09 an hour after that, so one costs
 * about $0.0001, and each production deploy takes at most one (plus a retry
 * after `RETRY_AFTER_MS` if it failed). That is small enough not to meter.
 */
import puppeteer from "@cloudflare/puppeteer";

import { SETTLE_MS, type ShotRequest, VIEWPORT, attemptKey, shotKey, shouldAttempt } from "./screenshot.ts";

export type ShotEnv = {
  BROWSER: Fetcher;
  SCREENSHOTS: R2Bucket;
};

export type Shot = { body: ArrayBuffer; contentType: string; commit: string; capturedAt: string };

/** The kept screenshot, whatever commit it shows. */
export async function stored(env: ShotEnv, host: string): Promise<Shot | null> {
  const object = await env.SCREENSHOTS.get(shotKey(host));
  if (!object) return null;
  return {
    body: await object.arrayBuffer(),
    contentType: object.httpMetadata?.contentType ?? "image/jpeg",
    commit: object.customMetadata?.commit ?? "",
    capturedAt: object.customMetadata?.capturedAt ?? object.uploaded.toISOString(),
  };
}

/**
 * Takes the screenshot of `commit`, unless one was tried for it moments
 * ago. Returns it, or null when it was not taken.
 */
export async function take(env: ShotEnv, { host, commit }: ShotRequest): Promise<Shot | null> {
  const marker = await env.SCREENSHOTS.head(attemptKey(host));
  if (!shouldAttempt(marker?.customMetadata, commit, Date.now())) return null;
  const at = new Date().toISOString();
  await env.SCREENSHOTS.put(attemptKey(host), "", { customMetadata: { commit, at } });

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch(env.BROWSER as unknown as Parameters<typeof puppeteer.launch>[0]);
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    // A page that keeps the network busy is taken as it is when time is up.
    await page.goto(`https://${host}/`, { waitUntil: "networkidle2", timeout: SETTLE_MS }).catch((error: unknown) => {
      console.warn("og: page did not settle", host, String(error));
    });
    const image = (await page.screenshot({ type: "jpeg", quality: 80 })) as Uint8Array;
    const body = image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength) as ArrayBuffer;
    const capturedAt = new Date().toISOString();
    await env.SCREENSHOTS.put(shotKey(host), body, {
      httpMetadata: { contentType: "image/jpeg" },
      customMetadata: { commit, capturedAt },
    });
    return { body, contentType: "image/jpeg", commit, capturedAt };
  } catch (error) {
    console.error("og: screenshot failed", host, error);
    return null;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

/** The screenshot of `commit`, taken now if it has not been; else the last one kept. */
export async function screenshotOf(env: ShotEnv, request: ShotRequest): Promise<Shot | null> {
  const kept = await stored(env, request.host);
  if (kept?.commit === request.commit) return kept;
  return (await take(env, request)) ?? kept;
}
