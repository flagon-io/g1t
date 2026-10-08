/**
 * status.g1t.sh: whether each part of g1t is working, how it has done over
 * 90 days, and what staff have said about incidents and maintenance.
 *
 * A Worker of its own, apart from the site, so it stays up when g1t does
 * not. Every minute a cron checks each part over the public internet, as
 * people reach it, and keeps the result in D1. The same run moves planned
 * maintenance along, and drafts an incident for staff when a part keeps
 * failing (detect.ts). Pages are drawn from what is kept, never by
 * checking on the spot, and kept at the edge for 30 seconds.
 *
 * Staff run incidents from sudo, through the `StatusAdmin` entrypoint,
 * which only a service binding reaches. Every change there is audited.
 *
 *   GET  /                    the page
 *   GET  /status.json         the same as JSON (snake_case, CORS open)
 *   GET  /badge.svg           a small badge
 *   GET  /incidents/<id>      an incident's updates and postmortem
 *   GET  /maintenance/<id>    a maintenance window's updates
 *   GET  /history             the last 12 months, by month
 *   GET  /feed.xml, /feed.json  every public update, newest first
 *   GET  /subscribe           subscribing by email
 *   POST /subscribe           asks for a subscription: a confirmation email
 *   GET|POST /subscribe/confirm?token=   confirms (GET shows a button: link scanners must not confirm)
 *   GET|POST /unsubscribe?token=         leaves (POST also takes RFC 8058 one-click)
 *   POST /deploys             the deploy tool: a deploy started or finished (bearer STATUS_DEPLOY_TOKEN)
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type AdminIncident,
  type AdminIncidentDetail,
  type AdminMaintenance,
  type DeclareIncident,
  type FollowUp,
  type IncidentChange,
  type MaintenanceChange,
  type NewMaintenance,
  type Postmortem,
  type PostmortemFields,
  type PublishIncident,
  type Result,
  type RolesChange,
  type StatusAdminApi,
  type StatusAuditEntry,
  type StatusBoard,
  billingClient,
  fail,
  ok,
} from "@g1t/contracts";
import bricolage from "@g1t/theme/fonts/bricolage-grotesque-latin.woff2";
import hanken from "@g1t/theme/fonts/hanken-grotesk-latin.woff2";
import plexMono from "@g1t/theme/fonts/ibm-plex-mono-latin-400.woff2";

import { type Targets, components } from "./components.ts";
import {
  autoDismissText,
  deployChange,
  deployQuiet,
  detect,
  detectedImpact,
  draftTitle,
  minutesWords,
  quietUntil,
  recoverySentence,
  settleDrafts,
  staleDrafts,
  staleText,
  troubleSentence,
  troubledNow,
} from "./detect.ts";
import {
  type EmailBinding,
  type Sender,
  alertLetter,
  bindingSender,
  confirmLetter,
  recoveredLetter,
  render as renderMail,
  staleLetter,
  unsubscribeHeaders,
  updateLetter,
} from "./email.ts";
import { atom, feedItems, jsonFeed } from "./feed.ts";
import {
  type Entry,
  applyChange,
  applyRoles,
  checkChange,
  checkDeclare,
  checkFollowUp,
  checkMaintenance,
  checkMaintenanceChange,
  checkPostmortem,
  checkPublish,
  checkRoles,
  postmortemReady,
  SEVERITY_LABEL,
  shortId,
} from "./incidents.ts";
import { INCIDENT_STATUS, type PageModel, SLOW_MS, buildPage, classify, underMaintenance } from "./model.ts";
import { stamp } from "./postmortem.ts";
import { type StorageReport, probe } from "./probe.ts";
import { readZone } from "./time.ts";
import {
  FAVICON,
  SCRIPT,
  type PageOptions,
  renderBadge,
  renderHistory,
  renderIncident,
  renderMaintenance,
  renderMessage,
  renderPage,
  renderSubscribe,
} from "./render.ts";
import {
  type Observation,
  addFollowUp,
  addSystemLines,
  auditLog,
  autoDismiss,
  board,
  confirmSubscription,
  createIncident,
  dueMaintenance,
  facts,
  incidentDetail,
  load,
  loadDeploy,
  loadHistory,
  loadPublicIncident,
  loadPublicMaintenance,
  loadStreaks,
  maintenanceById,
  maintenanceUrl,
  maintenanceUpdate,
  openCount,
  openRefs,
  publishPostmortem,
  recipients,
  record,
  requestSubscription,
  saveDeploy,
  saveHealthy,
  saveIncident,
  savePostmortem,
  saveReminders,
  saveStreaks,
  scheduleMaintenance,
  setFollowUp,
  unsubscribe,
  watchedDrafts,
} from "./store.ts";
import { CONFIRM_TTL_MS, RESEND_AFTER_MS, chosenParts, hashToken, newToken, normalizeEmail, readUnsubscribeToken, unsubscribeToken } from "./subscribers.ts";

export interface Env extends Partial<Targets> {
  DB: D1Database;
  /** Billing, for reading its price book. Optional: without it, billing is not listed. */
  BILLING?: Fetcher;
  /** The repos service, for git storage's recent health. Optional: without it, git storage is not listed. */
  REPOS?: Fetcher;
  /** Where help is. */
  SUPPORT_URL?: string;
  /**
   * The site's address as people's browsers reach it, for the page's links,
   * when the checks reach it by another (self-hosted: `http://g1t:8787`
   * inside Compose). SITE_URL when empty.
   */
  PUBLIC_SITE_URL?: string;
  /** The page's share card; empty for none. */
  OG_IMAGE?: string;
  /** This page's own address, for links in email and feeds made outside a request. */
  STATUS_URL?: string;
  /** Where sudo is, for the staff alert's link. */
  SUDO_URL?: string;
  /** Who hears about detected drafts. Empty sends none. */
  STATUS_ALERT_EMAIL?: string;
  /** The From of every email. */
  STATUS_FROM?: string;
  /** Signs unsubscribe links (a secret). Without it, email subscriptions are off; the feeds still work. */
  STATUS_SECRET?: string;
  /** Cloudflare Email Sending (`send_email`). Without it, nothing is emailed. */
  EMAIL?: EmailBinding;
  /**
   * The deploy tool's bearer token for `POST /deploys` (a secret). Without
   * it, deploys are not announced and detection does not hold off for them.
   */
  STATUS_DEPLOY_TOKEN?: string;
}

/** How long the edge keeps a page or the JSON. */
const CACHE_SECONDS = 30;
/** Older than this, a visit asks for a round of checks too (a missed cron, or `wrangler dev`). */
const BEHIND_MS = 3 * 60 * 1000;
/** How many subscribers one update emails at most, within a Worker's limits. */
const MAX_RECIPIENTS = 900;

function parts(env: Env) {
  return components(env, env.BILLING != null, env.REPOS != null);
}

function names(env: Env): Map<string, string> {
  return new Map(parts(env).map((p) => [p.key, p.name]));
}

/** This page's address: the request's own, or STATUS_URL outside a request. */
function originOf(env: Env, url?: URL): string {
  return (url?.origin ?? env.STATUS_URL ?? "https://status.g1t.sh").replace(/\/+$/, "");
}

function sender(env: Env): Sender | null {
  return bindingSender(env.EMAIL, env.STATUS_FROM || undefined);
}

/** Whether subscribers can sign up: a way to send, and a secret to sign their links. */
function emailOn(env: Env): boolean {
  return sender(env) != null && !!env.STATUS_SECRET;
}

/** Git storage's last five minutes, from the repos service (`store_health`). */
async function storeHealth(repos: Fetcher): Promise<StorageReport> {
  const response = await repos.fetch("https://service/rpc/store_health", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ minutes: 5 }),
  });
  if (!response.ok) throw new Error(`store_health failed with status ${response.status}`);
  return (await response.json()) as StorageReport;
}

/** One round of checks, kept. Parts under maintenance are checked but not tallied. */
export async function checkAll(env: Env, now = new Date()): Promise<Observation[]> {
  const billing = env.BILLING;
  const repos = env.REPOS;
  const list = parts(env);
  const results = await Promise.all(
    list.map(async (info) => {
      // A slow answer is asked again at once before it counts (probe.ts `probe`).
      const result = await probe(
        info.check,
        {
          fetch: (url, init) => fetch(url, init),
          billing: billing ? () => billingClient(billing).prices() : null,
          storage: repos ? () => storeHealth(repos) : null,
        },
        info.slowMs ?? SLOW_MS,
      );
      return { info, result };
    }),
  );
  // Checks through a binding have no cf-ray of their own: they ran where the others did.
  const roundColo = results.find((r) => r.result?.colo)?.result?.colo ?? null;
  const observations = results.map(({ info, result }): Observation => {
    const { state, detail } = classify(result, info.slowMs);
    return {
      component: info.key,
      state,
      detail,
      latency_ms: result ? Math.round(result.ms) : null,
      colo: result ? (result.colo ?? roundColo) : null,
      first_ms: result?.first_ms != null ? Math.round(result.first_ms) : null,
    };
  });
  const { maintenance } = await load(env.DB, now, originOf(env));
  await record(env.DB, observations, now, underMaintenance(maintenance, now));
  return observations;
}

// --- Email ---------------------------------------------------------------------------

/**
 * Emails confirmed subscribers who want news about `about`, in the
 * background. Returns how many it will email, or null when email is off.
 */
async function notify(
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void },
  about: string[],
  mail: { heading: string; text: string; url: string },
): Promise<number | null> {
  const send = sender(env);
  const secret = env.STATUS_SECRET;
  if (!send || !secret) return null;
  const list = (await recipients(env.DB, about)).slice(0, MAX_RECIPIENTS);
  const origin = originOf(env);
  const affects = about.map((k) => names(env).get(k) ?? k);
  ctx.waitUntil(
    (async () => {
      let failed = 0;
      for (let i = 0; i < list.length; i += 6) {
        await Promise.all(
          list.slice(i, i + 6).map(async (r) => {
            const link = `${origin}/unsubscribe?token=${encodeURIComponent(await unsubscribeToken(secret, r.id))}`;
            const { text, html } = renderMail(updateLetter({ heading: mail.heading, text: mail.text, url: mail.url, affects, unsubscribe: link }));
            await send.send({ to: r.email, subject: mail.heading, text, html, headers: unsubscribeHeaders(link) }).catch(() => void (failed += 1));
          }),
        );
      }
      console.log(JSON.stringify({ event: "status.notified", sent: list.length - failed, failed }));
    })(),
  );
  return list.length;
}

// --- The cron: detection and maintenance --------------------------------------------------

async function afterChecks(env: Env, ctx: { waitUntil(p: Promise<unknown>): void }, observations: Observation[], now: Date): Promise<void> {
  const origin = originOf(env);
  const named = names(env);
  // Maintenance whose window opened or closed.
  for (const m of await dueMaintenance(env.DB, now, origin)) {
    const ended = Date.parse(m.ends_at) <= now.getTime();
    const text = ended ? "The maintenance is complete." : "The maintenance has begun.";
    const notified = m.notify ? await notify(env, ctx, m.components, { heading: `${ended ? "Completed" : "In progress"}: ${m.title}`, text, url: m.url }) : null;
    await maintenanceUpdate(env.DB, m.id, ended ? "completed" : "in_progress", text, "status", notified, now, {
      action: ended ? "maintenance_completed" : "maintenance_started",
      detail: `${m.title} (on schedule)`,
    });
  }
  // Detection. A deploy restarts services: during one, and briefly after, trouble is counted but not drafted.
  const [streaks, open, page, deploy] = await Promise.all([loadStreaks(env.DB), openRefs(env.DB), load(env.DB, now, origin), loadDeploy(env.DB)]);
  const quiet = deployQuiet(deploy, now);
  const found = detect(streaks, observations, open, underMaintenance(page.maintenance, now), now, { quiet });
  await saveStreaks(env.DB, found.streaks);
  if (found.held.length) console.log(JSON.stringify({ event: "status.held_for_deploy", parts: found.held, deploy: deploy?.id ?? null }));
  const name = (key: string) => named.get(key) ?? key;
  const slowMs = (key: string) => parts(env).find((p) => p.key === key)?.slowMs ?? SLOW_MS;
  const lines = [
    ...found.failing.map((f) => ({ incident: f.incident, kind: "failing" as const, text: troubleSentence(name(f.key), f, stamp(f.since), slowMs(f.key)) })),
    ...found.recovered.map((r) => ({ incident: r.incident, kind: "recovered" as const, text: recoverySentence(name(r.key), r, stamp(r.since)) })),
  ];
  await addSystemLines(env.DB, lines, now);
  const sudo = (id: string) => `${(env.SUDO_URL || "https://sudo.g1t.sh").replace(/\/+$/, "")}/incidents/${id}`;
  const alertTo = (env.STATUS_ALERT_EMAIL ?? "").trim();
  const send = sender(env);
  if (found.draft.length) {
    const core = new Set(parts(env).filter((p) => p.core).map((p) => p.key));
    const title = draftTitle(found.draft.map((d) => ({ name: name(d.key), state: d.state })));
    const since = found.draft.map((d) => d.since).sort()[0]!;
    const said = found.draft.map((d) => troubleSentence(name(d.key), d, stamp(d.since), slowMs(d.key)));
    // Trouble that began in a deploy and outlasted it: say so, it is the first thing to rule out.
    const note = deploy && deployQuiet(deploy, new Date(since)) ? `It began during a deploy (started ${stamp(deploy.started_at)}) and outlasted it.` : null;
    const id = await createIncident(
      env.DB,
      {
        title,
        severity: found.draft.some((d) => d.state === "down" && core.has(d.key)) ? "sev2" : "sev3",
        status: "investigating",
        visibility: "draft",
        source: "detected",
        components: found.draft.map((d) => ({ key: d.key, impact: detectedImpact(d.state) })),
        started_at: since,
        acknowledged_at: null,
        commander: null,
        communications: null,
        by: "status",
      },
      [
        {
          kind: "detected",
          public: false,
          status: null,
          text: `${said.join(" ")}${note ? ` ${note}` : ""} Not on the status page until it is published.`,
        },
      ],
      now,
      { action: "incident_detected", detail: title },
    );
    console.warn(JSON.stringify({ event: "status.detected", id, parts: found.draft.map((d) => d.key), since }));
    if (alertTo && send) {
      const { text, html } = renderMail(alertLetter({ title, lines: said, link: sudo(id), ...(note ? { note } : {}) }));
      ctx.waitUntil(send.send({ to: alertTo, subject: `[g1t status] ${title}`, text, html }).catch((e) => console.error(JSON.stringify({ event: "status.alert_failed", error: String(e) }))));
    }
  }
  // Detected drafts no one picked up, whose parts have stayed healthy long enough: dismissed, with a word to staff.
  // A part counts as healthy from its first good check; a run that is still going but answered well last time does not hold a draft up.
  const troubled = new Set(found.streaks.filter(troubledNow).map((s) => s.component));
  const watched = await watchedDrafts(env.DB);
  const settled = settleDrafts(watched, troubled, now);
  await saveHealthy(env.DB, settled.healthy);
  const dismissed = new Set<string>();
  for (const d of settled.dismiss) {
    const text = autoDismissText(d.lasted_ms, stamp(d.recovered_at));
    if (!(await autoDismiss(env.DB, d.id, d.recovered_at, text, now))) continue;
    dismissed.add(d.id);
    console.log(JSON.stringify({ event: "status.auto_dismissed", id: d.id, lasted_ms: d.lasted_ms }));
    if (alertTo && send) {
      const letter = recoveredLetter({ title: d.title, text, link: sudo(d.id) });
      const { text: body, html } = renderMail(letter);
      ctx.waitUntil(send.send({ to: alertTo, subject: `[g1t status] ${letter.heading}`, text: body, html }).catch((e) => console.error(JSON.stringify({ event: "status.alert_failed", error: String(e) }))));
    }
  }
  // Drafts still waiting for someone: the alert goes out again after 45 minutes, then every 6 hours.
  const waiting = watched.filter((d) => !dismissed.has(d.id));
  const stale = staleDrafts(waiting, now);
  const emailed = !!(alertTo && send);
  await saveReminders(
    env.DB,
    waiting.map((d) => d.id),
    stale.map((d) => ({ id: d.id, text: staleText(d.waiting_ms, emailed) })),
    now,
  );
  for (const d of stale) {
    console.warn(JSON.stringify({ event: "status.draft_waiting", id: d.id, waiting_ms: d.waiting_ms }));
    if (!emailed) continue;
    const letter = staleLetter({ title: d.title, waiting: minutesWords(d.waiting_ms), link: sudo(d.id) });
    const { text: body, html } = renderMail(letter);
    ctx.waitUntil(send!.send({ to: alertTo, subject: `[g1t status] ${letter.heading}`, text: body, html }).catch((e) => console.error(JSON.stringify({ event: "status.alert_failed", error: String(e) }))));
  }
}

/**
 * The deploy tool's word that a deploy started or finished:
 * `POST /deploys` with `Authorization: Bearer <STATUS_DEPLOY_TOKEN>` and
 * `{"phase": "started" | "finished", "id": "<run or commit>"}`. Without
 * the secret set, there is no such address.
 */
async function deployHook(request: Request, env: Env): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store", ...COMMON } });
  const token = (env.STATUS_DEPLOY_TOKEN ?? "").trim();
  if (!token) return json({ error: { code: "not_found", message: "Not found." } }, 404);
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!(await sameSecret(given, token))) return json({ error: { code: "unauthorized", message: "A valid deploy token is required." } }, 401);
  let body: { phase?: unknown; id?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // Checked below.
  }
  const phase = body.phase === "started" || body.phase === "finished" ? body.phase : null;
  if (!phase) return json({ error: { code: "invalid", message: 'phase must be "started" or "finished".' } }, 400);
  const id = typeof body.id === "string" && body.id.trim() ? body.id.trim().slice(0, 100) : null;
  const now = new Date();
  const window = deployChange(await loadDeploy(env.DB), phase, id, now);
  await saveDeploy(env.DB, window);
  console.log(JSON.stringify({ event: `status.deploy_${phase}`, id, running: window.running }));
  return json({ deploy: window, quiet_until: quietUntil(window) });
}

/** Compares two secrets in constant time, by their hashes. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const digest = async (v: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = a.length === 0 ? 1 : 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

// --- Pages -------------------------------------------------------------------------------

async function model(env: Env, now: Date, origin: string): Promise<PageModel> {
  const stored = await load(env.DB, now, origin);
  return buildPage({
    parts: parts(env),
    current: stored.current,
    checkedAt: stored.checkedAt,
    days: stored.days,
    incidents: stored.incidents,
    maintenance: stored.maintenance,
    now,
  });
}

/** When this isolate last asked for a catch-up round, so a busy page asks once. */
let caughtUpAt = 0;

function catchUp(env: Env, ctx: ExecutionContext, page: PageModel, now: Date) {
  const checked = page.report.checked_at ? Date.parse(page.report.checked_at) : 0;
  if (now.getTime() - checked < BEHIND_MS || now.getTime() - caughtUpAt < BEHIND_MS) return;
  caughtUpAt = now.getTime();
  ctx.waitUntil(checkAll(env, now).catch((error) => console.error(JSON.stringify({ event: "status.catch_up_failed", error: String(error) }))));
}

const PAGE_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const COMMON = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

function edgeCache(): Cache | null {
  return (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default ?? null;
}

/**
 * A response from the edge cache, or made and kept there. Pages that say
 * times pass the reader's zone, and are kept once per zone.
 */
async function cached(request: Request, ctx: ExecutionContext, make: () => Promise<Response>, zone?: string): Promise<Response> {
  const cache = edgeCache();
  const url = new URL(request.url);
  const key = new Request(`${url.origin}${url.pathname}${zone ? `?zone=${encodeURIComponent(zone)}` : ""}`, { method: "GET" });
  if (cache) {
    const hit = await cache.match(key).catch(() => undefined);
    if (hit) return hit;
  }
  const response = await make();
  if (cache && response.ok) ctx.waitUntil(cache.put(key, response.clone()).catch(() => undefined));
  return response;
}

const FONTS: Record<string, ArrayBuffer> = {
  "/fonts/hanken-grotesk.woff2": hanken,
  "/fonts/bricolage-grotesque.woff2": bricolage,
  "/fonts/ibm-plex-mono.woff2": plexMono,
};

function html(body: string, cacheControl: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": cacheControl, "content-security-policy": PAGE_POLICY, ...COMMON },
  });
}

async function form(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    return new FormData();
  }
}

/** Subscribing, confirming and leaving: the page's only writes. */
async function subscriptions(request: Request, env: Env, ctx: ExecutionContext, url: URL, options: PageOptions): Promise<Response | null> {
  const path = url.pathname;
  const noStore = "no-store";
  const message = (title: string, text: string, status = 200, f?: { action: string; fields: Record<string, string>; button: string }) =>
    html(renderMessage({ ...options, selfUrl: `${url.origin}${path}` }, { title, text, form: f }), noStore, status);
  const post = request.method === "POST";

  if (path === "/subscribe" && post) {
    if (!emailOn(env)) return message("Email updates are not available", "Follow the Atom or JSON feed instead.", 503);
    const data = await form(request);
    if (String(data.get("website") ?? "")) return message("Check your inbox", "If the address is right, a confirmation link is on its way.");
    const email = normalizeEmail(data.get("email"));
    if (!email) return message("That is not an email address", "Go back and check it.", 400);
    const chosen = chosenParts(data.getAll("components").map(String), parts(env).map((p) => p.key));
    const token = newToken();
    const { send } = await requestSubscription(env.DB, email, chosen, await hashToken(token), new Date(), CONFIRM_TTL_MS, RESEND_AFTER_MS);
    if (send) {
      const link = `${url.origin}/subscribe/confirm?token=${encodeURIComponent(token)}`;
      const { text, html: body } = renderMail(confirmLetter(link, chosen ? chosen.map((k) => names(env).get(k) ?? k) : null));
      ctx.waitUntil(sender(env)!.send({ to: email, subject: "Confirm your subscription to g1t status", text, html: body }).catch((e) => console.error(JSON.stringify({ event: "status.confirm_failed", error: String(e) }))));
    }
    return message("Check your inbox", "If the address is right, a confirmation link is on its way. It works for 24 hours.");
  }
  if (path === "/subscribe/confirm") {
    const token = url.searchParams.get("token") ?? (post ? String((await form(request)).get("token") ?? "") : "");
    if (!token) return message("That link is incomplete", "Copy the whole link from the email.", 400);
    if (!post) return message("Confirm your subscription", "One more step: confirm to start getting emails about incidents and maintenance.", 200, { action: "/subscribe/confirm", fields: { token }, button: "Confirm subscription" });
    const done = await confirmSubscription(env.DB, await hashToken(token), new Date());
    if (!done) return message("That link has expired", "Confirmation links work for 24 hours and once. Subscribe again for a new one.", 410);
    return message("You are subscribed", `${done.email} will get an email when g1t posts an incident or maintenance${done.parts ? ` affecting ${done.parts.map((k) => names(env).get(k) ?? k).join(", ")}` : ""}. Every email has a link to unsubscribe.`);
  }
  if (path === "/unsubscribe") {
    const token = url.searchParams.get("token") ?? (post ? String((await form(request)).get("token") ?? "") : "");
    const id = env.STATUS_SECRET && token ? await readUnsubscribeToken(env.STATUS_SECRET, token) : null;
    if (!id) return message("That link is not valid", "Use the unsubscribe link at the bottom of any email from g1t status.", 400);
    if (!post) return message("Unsubscribe", "Stop getting emails from g1t status?", 200, { action: "/unsubscribe", fields: { token }, button: "Unsubscribe" });
    await unsubscribe(env.DB, id);
    return message("You are unsubscribed", "You will not get any more emails from g1t status. You can subscribe again at any time.");
  }
  return null;
}

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  if (request.method === "OPTIONS" && (path === "/status.json" || path === "/feed.json")) {
    return new Response(null, {
      status: 204,
      headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, HEAD", "access-control-max-age": "86400" },
    });
  }
  const now = new Date();
  const origin = originOf(env, url);
  const site = env.PUBLIC_SITE_URL || env.SITE_URL || url.origin;
  const options: PageOptions = {
    siteUrl: site,
    supportUrl: env.SUPPORT_URL || `${site}/support`,
    ogImage: env.OG_IMAGE ?? "",
    selfUrl: `${url.origin}${path === "/" ? "/" : path}`,
    now,
    email: emailOn(env),
    zone: readZone(request.headers.get("cookie"), (request as { cf?: { timezone?: unknown } }).cf?.timezone),
  };

  if (request.method === "POST" && path === "/deploys") return deployHook(request, env);
  if (request.method === "POST") {
    const answer = await subscriptions(request, env, ctx, url, options);
    return answer ?? new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD", ...COMMON } });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD, POST", ...COMMON } });
  }
  const fresh = (cacheSeconds = CACHE_SECONDS) => `public, max-age=${cacheSeconds}`;
  const notFound = () => html(renderMessage(options, { title: "Not found", text: "There is nothing at this address." }), fresh(), 404);

  switch (path) {
    case "/":
      return cached(request, ctx, async () => {
        const page = await model(env, now, origin);
        catchUp(env, ctx, page, now);
        return html(renderPage(page, options), fresh());
      }, options.zone);
    case "/status.json":
      return cached(request, ctx, async () => {
        const page = await model(env, now, origin);
        catchUp(env, ctx, page, now);
        return Response.json(page.report, { headers: { "cache-control": fresh(), "access-control-allow-origin": "*", ...COMMON } });
      });
    case "/badge.svg":
      return cached(request, ctx, async () => {
        const page = await model(env, now, origin);
        return new Response(renderBadge(page.report.overall.state, page.report.overall.title), {
          headers: { "content-type": "image/svg+xml", "cache-control": fresh(), "access-control-allow-origin": "*", ...COMMON },
        });
      });
    case "/history":
      return cached(request, ctx, async () => {
        const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
        const { incidents, maintenance } = await loadHistory(env.DB, since, origin);
        return html(renderHistory(incidents, maintenance, options), fresh());
      }, options.zone);
    case "/feed.xml":
    case "/feed.json":
      return cached(request, ctx, async () => {
        const { incidents, maintenance } = await loadHistory(env.DB, new Date(now.getTime() - 365 * 86_400_000), origin);
        const items = feedItems(incidents, maintenance);
        const feed = { origin, title: "g1t status", updated: now.toISOString() };
        const headers = { "cache-control": fresh(60), "access-control-allow-origin": "*", ...COMMON };
        return path === "/feed.xml"
          ? new Response(atom(items, feed), { headers: { "content-type": "application/atom+xml; charset=utf-8", ...headers } })
          : Response.json(jsonFeed(items, feed), { headers: { "content-type": "application/feed+json; charset=utf-8", ...headers } });
      });
    case "/subscribe":
      return html(renderSubscribe(options, parts(env).map(({ key, name }) => ({ key, name }))), fresh(300));
    case "/subscribe/confirm":
    case "/unsubscribe":
      return (await subscriptions(request, env, ctx, url, options))!;
    case "/status.js":
      return new Response(SCRIPT, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": fresh(3600), ...COMMON } });
    case "/favicon.svg":
    case "/favicon.ico":
      return new Response(FAVICON, { headers: { "content-type": "image/svg+xml", "cache-control": fresh(86400), ...COMMON } });
    case "/robots.txt":
      return new Response("User-agent: *\nAllow: /\nDisallow: /subscribe/confirm\nDisallow: /unsubscribe\n", {
        headers: { "content-type": "text/plain", "cache-control": fresh(86400) },
      });
  }
  const incident = /^\/incidents\/([a-z0-9-]{1,64})$/.exec(path);
  if (incident) {
    return cached(request, ctx, async () => {
      const found = await loadPublicIncident(env.DB, incident[1]!, origin);
      return found ? html(renderIncident(found.incident, found.postmortem, names(env), options), fresh()) : notFound();
    }, options.zone);
  }
  const maintenance = /^\/maintenance\/([a-z0-9-]{1,64})$/.exec(path);
  if (maintenance) {
    return cached(request, ctx, async () => {
      const found = await loadPublicMaintenance(env.DB, maintenance[1]!, origin);
      return found ? html(renderMaintenance(found, names(env), options), fresh()) : notFound();
    }, options.zone);
  }
  const font = FONTS[path];
  if (font) {
    return new Response(font, { headers: { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable", ...COMMON } });
  }
  return notFound();
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (error) {
      console.error(JSON.stringify({ event: "status.failed", path: new URL(request.url).pathname, error: String(error) }));
      return new Response("The status page could not be drawn. Try again in a minute.", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "60", ...COMMON },
      });
    }
  },
  async scheduled(_controller, env, ctx) {
    const now = new Date();
    ctx.waitUntil(
      checkAll(env, now)
        .then(async (observations) => {
          const failing = observations.filter((o) => o.state === "down" || o.state === "degraded");
          if (failing.length) console.warn(JSON.stringify({ event: "status.trouble", parts: failing }));
          await afterChecks(env, ctx, observations, now);
        })
        .catch((error) => console.error(JSON.stringify({ event: "status.cron_failed", error: String(error) }))),
    );
  },
} satisfies ExportedHandler<Env>;

// --- Staff ---------------------------------------------------------------------------------

/**
 * Staff only: running incidents and maintenance. Reached only through a
 * service binding (sudo's `STATUS`); status.g1t.sh's own address cannot.
 */
export class StatusAdmin extends WorkerEntrypoint<Env> implements StatusAdminApi {
  private known() {
    return parts(this.env).map((p) => p.key);
  }

  private origin() {
    return originOf(this.env);
  }

  private async detail(id: string): Promise<AdminIncidentDetail | null> {
    const limits = new Map(parts(this.env).map((p) => [p.key, p.slowMs ?? SLOW_MS]));
    return incidentDetail(this.env.DB, String(id), this.origin(), names(this.env), { limits });
  }

  private async summary(id: string): Promise<AdminIncident> {
    const { timeline: _t, followups: _f, postmortem: _p, postmortem_draft: _d, url: _u, checks: _c, ...incident } = (await this.detail(id))!;
    return incident;
  }

  /** Emails a public update to subscribers when asked; the count to keep with it. */
  private async announce(incident: { id: string; title: string; components: { key: string; impact: string }[] }, status: keyof typeof INCIDENT_STATUS, text: string, wanted: boolean) {
    if (!wanted) return null;
    const about = incident.components.filter((c) => c.impact !== "operational").map((c) => c.key);
    return notify(this.env, this.ctx, about, {
      heading: `${INCIDENT_STATUS[status]}: ${incident.title}`,
      text,
      url: `${this.origin()}/incidents/${incident.id}`,
    });
  }

  async components(): Promise<{ key: string; name: string }[]> {
    return parts(this.env).map(({ key, name }) => ({ key, name }));
  }

  async board(): Promise<StatusBoard> {
    return { ...(await board(this.env.DB, new Date(), this.origin())), email: emailOn(this.env) };
  }

  async incident(id: string): Promise<AdminIncidentDetail | null> {
    return this.detail(id);
  }

  async openCount(): Promise<number> {
    return openCount(this.env.DB);
  }

  async declare(input: DeclareIncident): Promise<Result<AdminIncident>> {
    const checked = checkDeclare(input, this.known());
    if (!checked.ok) return fail("invalid", checked.error);
    const v = checked.value;
    const now = new Date();
    const entries: (Entry & { notified?: number | null })[] = [
      { kind: "declared", public: false, status: null, text: `Declared ${SEVERITY_LABEL[v.severity]}.` },
    ];
    if (v.commander) entries.push({ kind: "role", public: false, status: null, text: `Incident commander: ${v.commander}.` });
    if (v.communications) entries.push({ kind: "role", public: false, status: null, text: `Communications: ${v.communications}.` });
    const id = shortId();
    const status = v.status ?? "investigating";
    const notified = await this.announce({ id, title: v.title, components: v.components }, status, v.message, v.notify);
    entries.push({ kind: "update", public: true, status, text: v.message, notified });
    await createIncident(
      this.env.DB,
      {
        title: v.title,
        severity: v.severity,
        status,
        visibility: "public",
        source: "declared",
        components: v.components,
        started_at: v.started_at ?? now.toISOString(),
        acknowledged_at: now.toISOString(),
        commander: v.commander ?? null,
        communications: v.communications ?? null,
        by: v.by,
      },
      entries,
      now,
      { action: "incident_declared", detail: `${SEVERITY_LABEL[v.severity]}: ${v.title}` },
      id,
    );
    console.log(JSON.stringify({ event: "status.incident_declared", id, by: v.by }));
    return ok(await this.summary(id));
  }

  async update(id: string, change: IncidentChange): Promise<Result<AdminIncident>> {
    const checked = checkChange(change, this.known());
    if (!checked.ok) return fail("invalid", checked.error);
    const existing = await this.detail(id);
    if (!existing) return fail("not_found", "No such incident.");
    const now = new Date();
    const applied = applyChange(facts(existing), checked.value, now, names(this.env));
    if (!applied.ok) return fail("invalid", applied.error);
    const { next, entries } = applied.value;
    const update = entries.find((e) => e.kind === "update");
    const notified = update
      ? await this.announce({ id: existing.id, title: existing.title, components: next.components }, next.status, update.text, checked.value.notify === true)
      : null;
    const lines = entries.map((e) => (e === update ? { ...e, notified } : e));
    const action = next.status === "resolved" && existing.status !== "resolved" ? "incident_resolved" : update ? "incident_update" : "incident_note";
    await saveIncident(this.env.DB, existing.id, next, lines, now, checked.value.by, {
      action,
      detail: entries.map((e) => (e.kind === "update" || e.kind === "note" ? `${e.kind === "update" ? "Public" : "Note"}: ${e.text}` : e.text)).join(" ").slice(0, 500),
    });
    return ok(await this.summary(existing.id));
  }

  async roles(id: string, change: RolesChange): Promise<Result<AdminIncident>> {
    const checked = checkRoles(change);
    if (!checked.ok) return fail("invalid", checked.error);
    const existing = await this.detail(id);
    if (!existing) return fail("not_found", "No such incident.");
    const now = new Date();
    const { next, entries } = applyRoles(facts(existing), checked.value, now);
    if (!entries.length) return ok(await this.summary(existing.id));
    await saveIncident(this.env.DB, existing.id, next, entries, now, checked.value.by, { action: "incident_roles", detail: entries.map((e) => e.text).join(" ") });
    return ok(await this.summary(existing.id));
  }

  async publish(id: string, input: PublishIncident): Promise<Result<AdminIncident>> {
    const checked = checkPublish(input);
    if (!checked.ok) return fail("invalid", checked.error);
    const existing = await this.detail(id);
    if (!existing) return fail("not_found", "No such incident.");
    if (existing.visibility !== "draft") return fail("conflict", "Only a draft can be published.");
    const now = new Date();
    const at = now.toISOString();
    const title = checked.value.title ?? existing.title;
    const next = { ...facts(existing), visibility: "public" as const, acknowledged_at: existing.acknowledged_at ?? at, title, published_at: at };
    const notified = await this.announce({ id: existing.id, title, components: existing.components }, existing.status, checked.value.message, checked.value.notify);
    await saveIncident(
      this.env.DB,
      existing.id,
      next,
      [
        ...(existing.acknowledged_at ? [] : [{ kind: "acknowledged" as const, public: false, status: null, text: "Acknowledged." }]),
        { kind: "published", public: false, status: null, text: title !== existing.title ? `Published as “${title}”.` : "Published to the status page." },
        { kind: "update", public: true, status: existing.status, text: checked.value.message, notified },
      ],
      now,
      checked.value.by,
      { action: "incident_published", detail: title },
    );
    return ok(await this.summary(existing.id));
  }

  async dismiss(id: string, input: { reason: string; by: string }): Promise<Result<AdminIncident>> {
    const existing = await this.detail(id);
    if (!existing) return fail("not_found", "No such incident.");
    if (existing.visibility !== "draft") return fail("conflict", "Only a draft can be dismissed; resolve a published incident instead.");
    const by = String(input?.by ?? "").trim();
    if (!by) return fail("invalid", "Who is making the change is missing.");
    const reason = String(input?.reason ?? "").trim().slice(0, 500) || "No reason given.";
    const now = new Date();
    const at = now.toISOString();
    const next = { ...facts(existing), visibility: "dismissed" as const, status: "resolved" as const, acknowledged_at: existing.acknowledged_at ?? at, resolved_at: at };
    await saveIncident(this.env.DB, existing.id, next, [{ kind: "dismissed", public: false, status: null, text: `Dismissed: ${reason}` }], now, by, {
      action: "incident_dismissed",
      detail: `${existing.title}: ${reason}`,
    });
    return ok(await this.summary(existing.id));
  }

  async addFollowUp(id: string, input: { title: string; owner: string | null; by: string }): Promise<Result<FollowUp>> {
    const checked = checkFollowUp(input);
    if (!checked.ok) return fail("invalid", checked.error);
    if (!(await this.detail(id))) return fail("not_found", "No such incident.");
    return ok(await addFollowUp(this.env.DB, String(id), checked.value, new Date()));
  }

  async setFollowUp(id: string, followUp: string, input: { done: boolean; by: string }): Promise<Result<FollowUp>> {
    const by = String(input?.by ?? "").trim();
    if (!by) return fail("invalid", "Who is making the change is missing.");
    const done = await setFollowUp(this.env.DB, String(id), String(followUp), input.done === true, by, new Date());
    return done ? ok(done) : fail("not_found", "No such follow-up.");
  }

  async savePostmortem(id: string, input: PostmortemFields & { by: string }): Promise<Result<Postmortem>> {
    const checked = checkPostmortem(input);
    if (!checked.ok) return fail("invalid", checked.error);
    const existing = await this.detail(id);
    if (!existing) return fail("not_found", "No such incident.");
    if (existing.visibility !== "public") return fail("conflict", "Only a published incident has a postmortem.");
    const { by, ...fields } = checked.value;
    await savePostmortem(this.env.DB, existing.id, fields, by, new Date());
    return ok((await this.detail(existing.id))!.postmortem!);
  }

  async publishPostmortem(id: string, input: { publish: boolean; by: string }): Promise<Result<Postmortem>> {
    const by = String(input?.by ?? "").trim();
    if (!by) return fail("invalid", "Who is making the change is missing.");
    const existing = await this.detail(id);
    if (!existing) return fail("not_found", "No such incident.");
    if (!existing.postmortem) return fail("conflict", "Save the postmortem before publishing it.");
    if (input.publish) {
      if (!existing.resolved_at) return fail("conflict", "Resolve the incident before publishing its postmortem.");
      const missing = postmortemReady(existing.postmortem);
      if (missing) return fail("invalid", missing);
    }
    await publishPostmortem(this.env.DB, existing.id, input.publish === true, by, new Date());
    return ok((await this.detail(existing.id))!.postmortem!);
  }

  async scheduleMaintenance(input: NewMaintenance): Promise<Result<AdminMaintenance>> {
    const checked = checkMaintenance(input, this.known());
    if (!checked.ok) return fail("invalid", checked.error);
    const v = checked.value;
    const now = new Date();
    const id = shortId();
    const notified = v.notify
      ? await notify(this.env, this.ctx, v.components, {
          heading: `Planned maintenance: ${v.title}`,
          text: `${v.message}\n\nWhen: ${stamp(v.starts_at)} to ${stamp(v.ends_at)}.`,
          url: maintenanceUrl(this.origin(), id),
        })
      : null;
    const made = await scheduleMaintenance(this.env.DB, v, notified, now, id);
    return ok((await maintenanceById(this.env.DB, made, this.origin()))!);
  }

  async changeMaintenance(id: string, change: MaintenanceChange): Promise<Result<AdminMaintenance>> {
    const checked = checkMaintenanceChange(change);
    if (!checked.ok) return fail("invalid", checked.error);
    const existing = await maintenanceById(this.env.DB, String(id), this.origin());
    if (!existing) return fail("not_found", "No such maintenance.");
    const v = checked.value;
    if (existing.state === "completed" || existing.state === "cancelled") return fail("conflict", `This maintenance is ${existing.state}.`);
    if (v.action === "start" && existing.state !== "scheduled") return fail("conflict", "It has already started.");
    const state = v.action === "start" ? "in_progress" : v.action === "complete" ? "completed" : v.action === "cancel" ? "cancelled" : null;
    const text =
      v.message ||
      (v.action === "start" ? "The maintenance has begun." : v.action === "complete" ? "The maintenance is complete." : "This maintenance is cancelled.");
    const word = { update: "Update", start: "In progress", complete: "Completed", cancel: "Cancelled" }[v.action];
    const notified = v.notify ? await notify(this.env, this.ctx, existing.components, { heading: `${word}: ${existing.title}`, text, url: existing.url }) : null;
    await maintenanceUpdate(this.env.DB, existing.id, state, text, v.by, notified, new Date(), {
      action: `maintenance_${v.action === "update" ? "update" : v.action === "start" ? "started" : v.action === "complete" ? "completed" : "cancelled"}`,
      detail: `${existing.title}: ${text}`,
    });
    return ok((await maintenanceById(this.env.DB, existing.id, this.origin()))!);
  }

  async audit(filter?: { before?: string | null }): Promise<StatusAuditEntry[]> {
    const before = filter?.before && !Number.isNaN(Date.parse(filter.before)) ? filter.before : null;
    return auditLog(this.env.DB, before);
  }
}

