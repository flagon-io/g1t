/**
 * What a request's host is: g1t.page itself, an app's address on it, the
 * hostname custom domains point at, or a custom domain.
 *
 * Kept free of imports so its tests run on Node as they are.
 */

export const DOMAIN = "g1t.page";
/** Where custom domains point (the Cloudflare for SaaS fallback origin). */
export const FALLBACK = `domains.${DOMAIN}`;

export type Route = { kind: "home" } | { kind: "fallback" } | { kind: "app"; label: string } | { kind: "custom"; hostname: string } | { kind: "invalid" };

const LABEL = /^[a-z0-9-]{1,63}$/;
const HOST = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export function route(rawHost: string): Route {
  const host = rawHost.toLowerCase().replace(/\.$/, "");
  if (host === DOMAIN) return { kind: "home" };
  if (host === FALLBACK) return { kind: "fallback" };
  if (host.endsWith(`.${DOMAIN}`)) {
    const label = host.slice(0, -DOMAIN.length - 1);
    return LABEL.test(label) ? { kind: "app", label } : { kind: "invalid" };
  }
  return HOST.test(host) && host.length <= 253 ? { kind: "custom", hostname: host } : { kind: "invalid" };
}

/**
 * What the deployments service notes for an app, under its own hostname,
 * for observability: each request's line names its project and deployment.
 */
export type AppTelemetry = { project: string; deployment: string | null; environment: string | null; service: string; commit: string | null };

/**
 * What the deployments service writes under a custom hostname, an app's
 * old hostname (a redirect), or an app's own hostname (its `telemetry`).
 */
export type DomainEntry = { script: string; redirect: string | null; telemetry?: AppTelemetry | null };

/** Reads a stored entry, or null if it is not one. */
export function parseEntry(value: unknown): DomainEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.script !== "string" || !LABEL.test(entry.script)) return null;
  const redirect = typeof entry.redirect === "string" && HOST.test(entry.redirect) ? entry.redirect : null;
  const t = entry.telemetry as Record<string, unknown> | null | undefined;
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  const telemetry =
    t && typeof t === "object" && typeof t.project === "string"
      ? {
          project: t.project,
          deployment: text(t.deployment),
          environment: text(t.environment),
          service: text(t.service) ?? entry.script,
          commit: text(t.commit),
        }
      : null;
  return { script: entry.script, redirect, telemetry };
}

/** The same path and query on `target`, over https. */
export function redirectTo(requestUrl: string, target: string): string {
  const url = new URL(requestUrl);
  return `https://${target}${url.pathname}${url.search}`;
}

/**
 * What one request to an app may use: CPU time, not counting time spent
 * waiting on the network, and requests it makes of its own. Static assets
 * are served without running the app, and use neither. No plan sets
 * others; the Deployments guide names these.
 */
export const APP_LIMITS = { cpuMs: 50, subRequests: 50 } as const;

/** Whether an app's failure was going over `APP_LIMITS`, as the runtime words it. */
export function overLimits(error: unknown): boolean {
  return /exceeded (its )?cpu|cpu time limit|too many subrequests|subrequest limit/i.test(String(error));
}

/**
 * Whether a request is a crawler's or a scanner's, not a person's. A
 * preview answers these itself, without running the app, so they never
 * count as visits: the deployments service takes down a preview nobody has
 * visited for its project's idle days, and crawlers fetched every preview's
 * robots.txt and sitemap.xml daily. A link unfurler (Slack, Discord and the
 * like) fetches a preview because someone shared it, and is let through.
 */
export function crawler(userAgent: string | null): boolean {
  if (!userAgent) return true;
  if (/slackbot|discordbot|twitterbot|facebookexternalhit|linkedinbot|telegrambot|whatsapp|mastodon/i.test(userAgent)) return false;
  return /bot\b|bot\/|crawl|spider|slurp|scrapy|curl\/|wget\/|python-requests|go-http-client|security-research/i.test(userAgent);
}

/** What a preview answers for robots.txt: nothing on it is for crawlers. */
export const PREVIEW_ROBOTS = "User-agent: *\nDisallow: /\n";

/** The header each app is handed with its request's id, which its logs can name. */
export const REQUEST_ID_HEADER = "x-g1t-request-id";
/** The first word of each request's line, which observability reads (services/telemetry). */
export const REQUEST_MARK = "g1t-request";

function hex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A request's id and trace: the trace the caller's `traceparent` began,
 * or a new one. The id is the dispatcher's span in it, which the app's
 * own spans (from an OpenTelemetry SDK that reads `traceparent`) are under.
 */
export function traceFor(traceparent: string | null): { id: string; trace: string; traceparent: string; flags: string } {
  const m = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-([0-9a-f]{2})$/.exec((traceparent ?? "").trim().toLowerCase());
  const trace = m && !/^0+$/.test(m[1]) ? m[1] : hex(16);
  const flags = m ? m[2] : "01";
  const id = hex(8);
  return { id, trace, traceparent: `00-${trace}-${id}-${flags}`, flags };
}
