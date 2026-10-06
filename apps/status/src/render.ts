/**
 * The pages at status.g1t.sh, drawn on the server as plain HTML: no
 * framework, a small stylesheet inline, and a few lines of script (served
 * at /status.js) that only add hover and keyboard detail to the bars and
 * say times in the browser's own zone. Without it, times are already in
 * the reader's zone as Cloudflare places them (PageOptions `zone`), with
 * the zone's abbreviation; `datetime` attributes and feeds stay in UTC. Every page works without it:
 * subscribing, confirming and leaving are plain forms. No Workers
 * imports, so it is tested under Node.
 *
 *   /                  the status now, maintenance, recent incidents, subscribing
 *   /incidents/<id>    one incident's every public update, and its postmortem
 *   /maintenance/<id>  one maintenance window and its updates
 *   /history           past incidents and maintenance, by month
 *   /subscribe         subscribing by email, to every part or some
 */
import type { PostmortemFields, StatusComponent, StatusIncident, StatusMaintenance, StatusOverallState } from "@g1t/contracts";

import { type DayBar, HISTORY_DAYS, IMPACT_WORD, INCIDENT_STATUS, type PageModel, maintenanceState, percent } from "./model.ts";
import { timeIn, validZone } from "./time.ts";

export type PageOptions = {
  /** The site the page is about: `https://g1t.sh`. */
  siteUrl: string;
  /** Where help is: `https://g1t.sh/support`. */
  supportUrl: string;
  /** The share card, or empty for none. */
  ogImage: string;
  /** This page's own address, for its canonical link. */
  selfUrl: string;
  now: Date;
  /** Whether email subscriptions can be offered (a sender and a secret). */
  email?: boolean;
  /** The reader's time zone (time.ts `readZone`); UTC when absent. */
  zone?: string;
};

export function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "5 Oct 2026". */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

/**
 * The zone the page being drawn says its times in. Each page's renderer
 * sets it from its options before drawing (drawing is synchronous, so one
 * page never sees another's).
 */
let zone = "UTC";

function zoned(options: PageOptions): void {
  zone = validZone(options.zone) ? options.zone : "UTC";
}

/** "5 Oct 2026, 14:03 UTC", or in the reader's zone: "5 Oct 2026, 07:03 PDT". */
export function timeLabel(at: string, tz = zone): string {
  return timeIn(at, tz);
}

/** A time in the reader's zone; the UTC instant in `datetime` and, in words, on hover. */
function time(at: string, relative = false): string {
  return `<time datetime="${escape(at)}" title="${escape(timeIn(at, "UTC"))}"${relative ? " data-relative" : ""}>${escape(timeLabel(at))}</time>`;
}

/** "1h 05m", "3d 4h". */
export function lasted(fromIso: string, toIso: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** What a day's square says on hover, and to a screen reader. */
export function dayDetail(bar: DayBar): string {
  const parts = [dayLabel(bar.day)];
  if (bar.checks === 0) parts.push("No data");
  else {
    parts.push(`${percent(bar.uptime)} answered`);
    if (bar.failed > 0) parts.push(`${bar.failed} failed check${bar.failed === 1 ? "" : "s"} of ${bar.checks}`);
    if (bar.slow > 0) parts.push(`${bar.slow} slow`);
    if (bar.avg_ms != null) parts.push(`average ${bar.avg_ms} ms`);
  }
  for (const title of bar.incidents) parts.push(`Incident: ${title}`);
  return parts.join(" · ");
}

export const STATE_WORD: Record<StatusComponent["state"], string> = {
  up: "Operational",
  degraded: "Degraded",
  partial: "Partial outage",
  down: "Outage",
  maintenance: "Under maintenance",
  unmonitored: "Not monitored",
};

/** The pixel G1T: 5×7 capitals, the 1 in lavender, as in the site's logo. */
const G = [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."];
const ONE = ["..#..", ".##..", "#.#..", "..#..", "..#..", "..#..", "#####"];
const T = ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."];

function pixels(rows: string[], dx: number, cls: string): string {
  return rows
    .flatMap((row, y) => [...row].flatMap((c, x) => (c === "#" ? [`<rect x="${(dx + x) * 10 + 1}" y="${y * 10 + 1}" width="8" height="8"${cls}/>`] : [])))
    .join("");
}

export const LOGO = `<svg class="logo" viewBox="1 1 148 68" role="img" aria-label="g1t">${pixels(G, 0, "")}${pixels(ONE, 6, ' class="one"')}${pixels(T, 10, "")}</svg>`;

/** The favicon: the pixel 1. */
export const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges"><style>rect{fill:#6b56e8}@media (prefers-color-scheme: dark){rect{fill:#b6a8ff}}</style>${ONE.flatMap(
  (row, y) => [...row].flatMap((c, x) => (c === "#" ? [`<rect x="${x * 2 + 3}" y="${y * 2 + 1}" width="2" height="2"/>`] : [])),
).join("")}</svg>`;

function bar(component: StatusComponent, days: DayBar[]): string {
  if (component.check_state === "unmonitored" && component.uptime_90d == null) {
    return `<p class="unchecked">${escape(component.checks)}</p>`;
  }
  const cells = days
    .map((d) => {
      const detail = dayDetail(d);
      return `<li class="${d.state}" title="${escape(detail)}" data-detail="${escape(detail)}"></li>`;
    })
    .join("");
  const label = `${component.name}: ${percent(component.uptime_90d)} of checks answered over ${HISTORY_DAYS} days. Use the arrow keys for each day.`;
  return `<div class="history">
<ol class="bar" tabindex="0" aria-label="${escape(label)}">${cells}</ol>
<div class="legend"><span><span class="long">${HISTORY_DAYS}</span><span class="short">30</span> days ago</span><span class="uptime">${escape(percent(component.uptime_90d))} uptime</span><span>Today</span></div>
<p class="detail" aria-live="polite"></p>
</div>`;
}

function componentRow(component: StatusComponent, days: DayBar[]): string {
  const seen = component.check_state !== "unmonitored" ? `<p class="seen">${escape(component.detail)}</p>` : "";
  return `<li class="component">
<div class="row">
<div class="name"><h3>${escape(component.name)}</h3><span class="address">${escape(component.address)}</span></div>
<div class="state s-${component.state}"><span class="dot ${component.state}" aria-hidden="true"></span>${STATE_WORD[component.state]}</div>
</div>
${seen}
${bar(component, days)}
</li>`;
}

/**
 * Text as HTML: blank lines between paragraphs, and a block whose lines
 * all start with "- " as a list. Everything is escaped.
 */
export function prose(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n").filter((l) => l.trim() !== "");
      if (lines.length && lines.every((l) => /^\s*[-*] /.test(l))) {
        return `<ul>${lines.map((l) => `<li>${escape(l.replace(/^\s*[-*] /, ""))}</li>`).join("")}</ul>`;
      }
      return `<p>${escape(block).replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
}

function impactLine(incident: StatusIncident, names: Map<string, string>): string {
  return incident.component_impacts
    .map((c) => `<span class="affects">${escape(names.get(c.key) ?? c.key)} <span class="impact i-${c.impact}">${escape(IMPACT_WORD[c.impact])}</span></span>`)
    .join("");
}

function pill(incident: StatusIncident): string {
  const open = incident.resolved_at == null;
  const impact = incident.impact === "down" ? "Major outage" : "Partial outage";
  return `<span class="pill ${open ? incident.impact : "done"}">${open ? `${escape(INCIDENT_STATUS[incident.status])} · ${impact}` : "Resolved"}</span>`;
}

function updatesList(incident: StatusIncident): string {
  return `<ol class="updates">${incident.updates
    .map(
      (u) =>
        `<li id="update-${escape(u.id)}"><p class="when"><strong>${escape(INCIDENT_STATUS[u.status])}</strong> ${time(u.at)}</p><div class="text">${prose(u.text)}</div></li>`,
    )
    .join("")}</ol>`;
}

/** An incident on the front page: its title links to its own page. */
function incidentBlock(incident: StatusIncident, names: Map<string, string>): string {
  const open = incident.resolved_at == null;
  return `<article class="incident ${open ? `open ${incident.impact}` : "resolved"}">
<header>
<h3><a href="/incidents/${escape(incident.id)}">${escape(incident.title)}</a></h3>
${pill(incident)}
</header>
<p class="meta">Started ${time(incident.started_at)}${incident.resolved_at ? ` · resolved ${time(incident.resolved_at)}` : ""}</p>
<div class="impacts">${impactLine(incident, names)}</div>
${updatesList(incident)}
</article>`;
}

/** A line for a past incident: title, when, how long, and its postmortem. */
function incidentLine(incident: StatusIncident): string {
  const how = incident.resolved_at ? `lasted ${lasted(incident.started_at, incident.resolved_at)}` : escape(INCIDENT_STATUS[incident.status]);
  const latest = incident.updates[0];
  return `<li class="line">
<div class="line-head"><a href="/incidents/${escape(incident.id)}">${escape(incident.title)}</a>${incident.postmortem_published_at ? `<a class="tag" href="/incidents/${escape(incident.id)}#postmortem">Postmortem</a>` : ""}</div>
<p class="meta">${time(incident.started_at)} · ${how}</p>
${latest ? `<p class="last">${escape(latest.text.split("\n")[0]!.slice(0, 220))}</p>` : ""}
</li>`;
}

function maintenanceWindow(m: StatusMaintenance): string {
  return `${time(m.starts_at)} to ${time(m.ends_at)} · ${lasted(m.starts_at, m.ends_at)}`;
}

const MAINTENANCE_WORD: Record<StatusMaintenance["state"], string> = {
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

function maintenanceBlock(m: StatusMaintenance, names: Map<string, string>, now: Date): string {
  const state = maintenanceState(m, now);
  const latest = m.updates[0];
  return `<article class="incident maint ${state}">
<header>
<h3><a href="/maintenance/${escape(m.id)}">${escape(m.title)}</a></h3>
<span class="pill maint">${MAINTENANCE_WORD[state]}</span>
</header>
<p class="meta">${maintenanceWindow(m)}</p>
<p class="meta">Affects ${escape(m.components.map((k) => names.get(k) ?? k).join(", "))}</p>
<div class="text">${prose(m.message)}</div>
${latest && latest.text !== m.message ? `<p class="when latest"><strong>Latest</strong> ${time(latest.at)} · ${escape(latest.text.split("\n")[0]!)}</p>` : ""}
</article>`;
}

const BANNER_CLASS: Record<StatusOverallState, string> = { up: "up", degraded: "degraded", down: "down", maintenance: "maintenance", unknown: "unknown" };

type Layout = { title: string; description: string; body: string; live?: boolean; feeds?: boolean };

function layout(options: PageOptions, page: Layout): string {
  const site = options.siteUrl.replace(/\/+$/, "");
  const siteHost = site.replace(/^https?:\/\//, "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(page.title)}</title>
<meta name="description" content="${escape(page.description)}">
<meta name="theme-color" content="#0f0f11">
<meta name="color-scheme" content="dark">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="canonical" href="${escape(options.selfUrl)}">
<link rel="alternate" type="application/json" href="/status.json">
<link rel="alternate" type="application/atom+xml" title="g1t status" href="/feed.xml">
<link rel="alternate" type="application/feed+json" title="g1t status" href="/feed.json">
<link rel="preload" href="/fonts/hanken-grotesk.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/bricolage-grotesque.woff2" as="font" type="font/woff2" crossorigin>
<meta property="og:site_name" content="g1t">
<meta property="og:type" content="website">
<meta property="og:url" content="${escape(options.selfUrl)}">
<meta property="og:title" content="${escape(page.title)}">
<meta property="og:description" content="${escape(page.description)}">
${options.ogImage ? `<meta property="og:image" content="${escape(options.ogImage)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${escape(options.ogImage)}">` : ""}
<style>${STYLE}</style>
<script src="/status.js" defer></script>
</head>
<body${page.live ? " data-live" : ""}>
<div class="page">
<header class="top">
<a class="brand" href="/" aria-label="g1t status">${LOGO}<span>Status</span></a>
<a class="out" href="${escape(site)}/">${escape(siteHost)} <span aria-hidden="true">→</span></a>
</header>
<main>
${page.body}
</main>
<footer class="foot">
<a href="/history">History</a><span aria-hidden="true">·</span><a href="/subscribe">Subscribe</a><span aria-hidden="true">·</span><a href="/feed.xml">Atom feed</a><span aria-hidden="true">·</span><a href="/feed.json">JSON feed</a><span aria-hidden="true">·</span><a href="/status.json">status.json</a><span aria-hidden="true">·</span><a href="${escape(options.supportUrl)}">Support</a><span aria-hidden="true">·</span><a href="${escape(site)}/">${escape(siteHost)}</a>
</footer>
</div>
</body>
</html>`;
}

const FEEDS = `the <a href="/feed.xml">Atom feed</a> or the <a href="/feed.json">JSON feed</a>`;

function subscribeForm(options: PageOptions, compact: boolean): string {
  if (!options.email) return `<p class="muted">Email updates are not available here. Follow ${FEEDS} instead.</p>`;
  return `<form class="subscribe" method="post" action="/subscribe">
<label class="sr" for="sub-email">Email address</label>
<input id="sub-email" type="email" name="email" required maxlength="254" autocomplete="email" placeholder="you@example.com">
<input class="trap" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
<button type="submit">Subscribe</button>
</form>
<p class="feeds">Get an email when an incident or planned maintenance is posted${compact ? `, or <a href="/subscribe">choose which parts</a>` : ""}. Or follow ${FEEDS}.</p>`;
}

/** The front page. */
export function renderPage(model: PageModel, options: PageOptions): string {
  zoned(options);
  const { report, bars, stale } = model;
  const { overall, components, incidents, maintenance, checked_at } = report;
  const names = new Map(components.map((c) => [c.key, c.name]));
  const open = incidents.filter((i) => i.resolved_at == null);
  const recentSince = options.now.getTime() - 14 * 24 * 60 * 60 * 1000;
  const past = incidents.filter((i) => i.resolved_at != null && Date.parse(i.resolved_at) >= recentSince);
  const inProgress = maintenance.filter((m) => maintenanceState(m, options.now) === "in_progress");
  const upcoming = maintenance.filter((m) => maintenanceState(m, options.now) === "scheduled");
  const description = `${overall.title}. Live status of g1t: the website, API, git, MCP, docs, deployments, agents and billing, with 90 days of history.`;
  const checkedLine = checked_at
    ? stale
      ? `The checks have not run since ${time(checked_at, true)}, so what follows may be out of date.`
      : `Checked ${time(checked_at, true)}, and every minute.`
    : "Waiting for the first checks.";
  const body = `<section class="banner ${BANNER_CLASS[overall.state]}" aria-live="polite">
<span class="dot big ${overall.state}" aria-hidden="true"></span>
<div>
<h1>${escape(overall.title)}</h1>
<p>${overall.state === "up" ? "" : `${escape(overall.line)} `}${checkedLine}</p>
</div>
</section>
${open.length ? `<section class="block"><h2>Happening now</h2>${open.map((i) => incidentBlock(i, names)).join("")}</section>` : ""}
${inProgress.length ? `<section class="block"><h2>Maintenance in progress</h2>${inProgress.map((m) => maintenanceBlock(m, names, options.now)).join("")}</section>` : ""}
${upcoming.length ? `<section class="block"><h2>Upcoming maintenance</h2>${upcoming.map((m) => maintenanceBlock(m, names, options.now)).join("")}</section>` : ""}
<section class="block">
<h2>Components</h2>
<ul class="components">${components.map((c) => componentRow(c, bars[c.key] ?? [])).join("")}</ul>
</section>
<section class="block">
<div class="block-head"><h2>Past incidents</h2><a href="/history">Full history <span aria-hidden="true">→</span></a></div>
${past.length ? `<ul class="lines">${past.map(incidentLine).join("")}</ul>` : `<p class="empty">No incidents in the last 14 days.</p>`}
</section>
<section class="block" id="subscribe">
<h2>Subscribe to updates</h2>
<div class="card">${subscribeForm(options, true)}</div>
</section>
<section class="block about">
<h2>About these checks</h2>
<p>Each part is checked every minute with one quick request, the same a visitor's would make, from outside g1t. A part that answers in over 1.5 seconds counts as slow; one that fails, or takes over 5 seconds, as down. A day shows green when at least 99.9% of its checks answered; checks during planned maintenance are not counted. This page runs apart from g1t itself, so it stays up when g1t does not.</p>
<dl>${components.map((c) => `<dt>${escape(c.name)}</dt><dd>${escape(c.checks)}</dd>`).join("")}</dl>
</section>`;
  return layout(options, { title: `${overall.title} · g1t status`, description, body, live: true });
}

const POSTMORTEM_SECTIONS: { key: keyof PostmortemFields; title: string }[] = [
  { key: "summary", title: "Summary" },
  { key: "impact", title: "Impact" },
  { key: "timeline", title: "Timeline" },
  { key: "root_cause", title: "Root cause" },
  { key: "went_well", title: "What went well" },
  { key: "went_badly", title: "What went badly" },
  { key: "action_items", title: "Action items" },
];

/** A postmortem's sections, those with something in them. */
export function postmortemHtml(p: PostmortemFields): string {
  return POSTMORTEM_SECTIONS.filter((s) => p[s.key].trim())
    .map((s) => `<section class="pm-section"><h3>${s.title}</h3><div class="text">${prose(p[s.key])}</div></section>`)
    .join("");
}

/** One incident's page: every public update, oldest last, and its postmortem once published. */
export function renderIncident(
  incident: StatusIncident,
  postmortem: (PostmortemFields & { published_at: string | null }) | null,
  names: Map<string, string>,
  options: PageOptions,
): string {
  zoned(options);
  const open = incident.resolved_at == null;
  const body = `<p class="crumbs"><a href="/">Status</a> <span aria-hidden="true">/</span> <a href="/history">History</a></p>
<article class="incident-page">
<header class="page-head">
<h1>${escape(incident.title)}</h1>
${pill(incident)}
</header>
<p class="meta">Started ${time(incident.started_at)}${incident.resolved_at ? ` · resolved ${time(incident.resolved_at)} · lasted ${lasted(incident.started_at, incident.resolved_at)}` : ""}</p>
<div class="impacts">${impactLine(incident, names)}</div>
${postmortem?.published_at ? `<p class="note">A postmortem was published ${time(postmortem.published_at)}. <a href="#postmortem">Read it</a>.</p>` : ""}
<section class="block"><h2>Updates</h2><div class="card">${updatesList(incident)}</div></section>
${
  postmortem?.published_at
    ? `<section class="block" id="postmortem"><h2>Postmortem</h2><div class="card postmortem">${postmortemHtml(postmortem)}</div></section>`
    : !open
      ? `<p class="muted">If a postmortem is written for this incident, it will appear on this page.</p>`
      : ""
}
</article>`;
  return layout(options, {
    title: `${incident.title} · g1t status`,
    description: `${open ? INCIDENT_STATUS[incident.status] : "Resolved"}: ${incident.title}. ${incident.updates[0]?.text.slice(0, 140) ?? ""}`,
    body,
  });
}

export function renderMaintenance(m: StatusMaintenance, names: Map<string, string>, options: PageOptions): string {
  zoned(options);
  const state = maintenanceState(m, options.now);
  const body = `<p class="crumbs"><a href="/">Status</a> <span aria-hidden="true">/</span> <a href="/history">History</a></p>
<header class="page-head"><h1>${escape(m.title)}</h1><span class="pill maint">${MAINTENANCE_WORD[state]}</span></header>
<p class="meta">${maintenanceWindow(m)}</p>
<p class="meta">Affects ${escape(m.components.map((k) => names.get(k) ?? k).join(", "))}</p>
<section class="block"><h2>Updates</h2><div class="card"><ol class="updates">${m.updates
    .map((u) => `<li id="update-${escape(u.id)}"><p class="when">${time(u.at)}</p><div class="text">${prose(u.text)}</div></li>`)
    .join("")}</ol></div></section>`;
  return layout(options, { title: `${m.title} · g1t status`, description: `Planned maintenance: ${m.title}.`, body });
}

/** Months, newest first, each with its incidents and maintenance. */
export function byMonth(incidents: StatusIncident[], maintenance: StatusMaintenance[]): { month: string; incidents: StatusIncident[]; maintenance: StatusMaintenance[] }[] {
  const months = new Map<string, { incidents: StatusIncident[]; maintenance: StatusMaintenance[] }>();
  const slot = (month: string) => months.get(month) ?? months.set(month, { incidents: [], maintenance: [] }).get(month)!;
  for (const i of incidents) slot(i.started_at.slice(0, 7)).incidents.push(i);
  for (const m of maintenance) slot(m.starts_at.slice(0, 7)).maintenance.push(m);
  return [...months]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, v]) => ({
      month,
      incidents: v.incidents.sort((a, b) => b.started_at.localeCompare(a.started_at)),
      maintenance: v.maintenance.sort((a, b) => b.starts_at.localeCompare(a.starts_at)),
    }));
}

export function renderHistory(incidents: StatusIncident[], maintenance: StatusMaintenance[], options: PageOptions, months = 12): string {
  zoned(options);
  const groups = byMonth(incidents, maintenance);
  const now = options.now;
  const list: string[] = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = d.toISOString().slice(0, 7);
    const group = groups.find((g) => g.month === key);
    const items = [
      ...(group?.incidents.map(incidentLine) ?? []),
      ...(group?.maintenance.map(
        (m) =>
          `<li class="line"><div class="line-head"><a href="/maintenance/${escape(m.id)}">${escape(m.title)}</a><span class="tag">Maintenance · ${MAINTENANCE_WORD[maintenanceState(m, now)]}</span></div><p class="meta">${maintenanceWindow(m)}</p></li>`,
      ) ?? []),
    ];
    list.push(`<section class="month"><h2>${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}</h2>${items.length ? `<ul class="lines">${items.join("")}</ul>` : `<p class="none">No incidents or maintenance.</p>`}</section>`);
  }
  const body = `<p class="crumbs"><a href="/">Status</a></p>
<header class="page-head"><h1>History</h1></header>
<p class="muted">Every incident and planned maintenance of the last ${months} months, newest first.</p>
${list.join("")}`;
  return layout(options, { title: "History · g1t status", description: "Past incidents and maintenance on g1t, by month.", body });
}

export function renderSubscribe(options: PageOptions, parts: { key: string; name: string }[]): string {
  const form = options.email
    ? `<form class="stack" method="post" action="/subscribe">
<label for="email">Email address</label>
<input id="email" type="email" name="email" required maxlength="254" autocomplete="email" placeholder="you@example.com">
<input class="trap" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
<fieldset>
<legend>Which parts</legend>
<p class="muted">Leave every box clear to hear about everything.</p>
<div class="checks">${parts.map((p) => `<label class="check"><input type="checkbox" name="components" value="${escape(p.key)}"> ${escape(p.name)}</label>`).join("")}</div>
</fieldset>
<button type="submit">Subscribe</button>
<p class="muted">We email you a link to confirm first. Every email has a link to unsubscribe. Your address is used for nothing else.</p>
</form>`
    : `<p class="muted">Email updates are not available on this installation.</p>`;
  const body = `<p class="crumbs"><a href="/">Status</a></p>
<header class="page-head"><h1>Subscribe to updates</h1></header>
<div class="card">${form}</div>
<section class="block"><h2>Feeds</h2><div class="card"><p class="muted">Every public update and maintenance notice, newest first: the <a href="/feed.xml">Atom feed</a> for feed readers and chat apps, the <a href="/feed.json">JSON feed</a>, and <a href="/status.json">status.json</a> for the state right now.</p></div></section>`;
  return layout(options, { title: "Subscribe · g1t status", description: "Get an email when g1t posts an incident or planned maintenance.", body });
}

/** A short page: a heading, a line, and perhaps a form with one button. */
export function renderMessage(
  options: PageOptions,
  input: { title: string; text: string; form?: { action: string; fields: Record<string, string>; button: string } },
): string {
  const form = input.form
    ? `<form method="post" action="${escape(input.form.action)}">${Object.entries(input.form.fields)
        .map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`)
        .join("")}<button type="submit">${escape(input.form.button)}</button></form>`
    : `<p><a href="/">Back to the status page</a></p>`;
  const body = `<p class="crumbs"><a href="/">Status</a></p>
<section class="card message"><h1>${escape(input.title)}</h1><p>${escape(input.text)}</p>${form}</section>`;
  return layout(options, { title: `${input.title} · g1t status`, description: input.text, body });
}

/** A small badge: "g1t | all systems normal", coloured by state. */
export function renderBadge(state: StatusOverallState, title: string): string {
  const color = { up: "#86efc4", degraded: "#ffbd8c", down: "#ff8394", maintenance: "#8ec5ff", unknown: "#86868e" }[state];
  const label = "g1t";
  const value = title.toLowerCase();
  // Widths from an average glyph of 6.5px at 11px: close enough to centre.
  const left = Math.round(label.length * 6.5 + 14);
  const right = Math.round(value.length * 6.2 + 14);
  const width = left + right;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${escape(`${label}: ${value}`)}">
<title>${escape(`${label}: ${value}`)}</title>
<clipPath id="r"><rect width="${width}" height="20" rx="4"/></clipPath>
<g clip-path="url(#r)"><rect width="${left}" height="20" fill="#1e1e21"/><rect x="${left}" width="${right}" height="20" fill="${color}"/></g>
<g font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">
<text x="${left / 2}" y="14" fill="#ededef">${escape(label)}</text>
<text x="${left + right / 2}" y="14" fill="#0f0f11">${escape(value)}</text>
</g></svg>`;
}

/** The page's script: day detail on hover, tap and arrow keys; times in the reader's words. */
export const SCRIPT = `(() => {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const fmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  function ago(at) {
    const s = (Date.parse(at) - Date.now()) / 1000;
    const a = Math.abs(s);
    if (a < 45) return rtf.format(Math.round(s), "second");
    if (a < 2700) return rtf.format(Math.round(s / 60), "minute");
    if (a < 79200) return rtf.format(Math.round(s / 3600), "hour");
    return rtf.format(Math.round(s / 86400), "day");
  }
  function times() {
    for (const t of document.querySelectorAll("time[datetime]")) {
      const at = t.getAttribute("datetime");
      if (t.hasAttribute("data-relative")) {
        t.title = fmt.format(new Date(at));
        t.textContent = ago(at);
      } else t.textContent = fmt.format(new Date(at));
    }
  }
  times();
  setInterval(times, 30000);
  for (const bar of document.querySelectorAll(".bar")) {
    const detail = bar.parentElement.querySelector(".detail");
    const days = [...bar.children];
    let at = -1;
    function show(i) {
      days.forEach((d, j) => d.classList.toggle("on", j === i));
      at = i;
      detail.textContent = i >= 0 ? days[i].dataset.detail : "";
    }
    bar.addEventListener("pointerover", (e) => { const i = days.indexOf(e.target); if (i >= 0) show(i); });
    bar.addEventListener("click", (e) => { const i = days.indexOf(e.target); if (i >= 0) show(i); });
    bar.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse" && document.activeElement !== bar) show(-1); });
    bar.addEventListener("blur", () => show(-1));
    bar.addEventListener("keydown", (e) => {
      const visible = days.filter((d) => d.offsetParent !== null);
      const first = days.indexOf(visible[0]);
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const next = at < 0 ? days.length - 1 : at + (e.key === "ArrowLeft" ? -1 : 1);
        show(Math.min(days.length - 1, Math.max(first, next)));
      } else if (e.key === "Home") { e.preventDefault(); show(first); }
      else if (e.key === "End") { e.preventDefault(); show(days.length - 1); }
    });
    bar.addEventListener("focus", () => { if (at < 0) show(days.length - 1); });
  }
  // Fresh numbers without a reload, while the front page is in view and no one is typing.
  if (document.body.hasAttribute("data-live")) {
    setInterval(() => {
      const busy = document.querySelector(".bar:focus") || (document.activeElement && document.activeElement.tagName === "INPUT");
      if (document.visibilityState === "visible" && !busy) location.reload();
    }, 120000);
  }
})();
`;

const STYLE = `
@font-face{font-family:"Hanken Grotesk";font-weight:400 700;font-display:swap;src:url(/fonts/hanken-grotesk.woff2) format("woff2")}
@font-face{font-family:"Bricolage Grotesque";font-weight:500 700;font-display:swap;src:url(/fonts/bricolage-grotesque.woff2) format("woff2")}
@font-face{font-family:"IBM Plex Mono";font-weight:400;font-display:swap;src:url(/fonts/ibm-plex-mono.woff2) format("woff2")}
:root{--bg:#0f0f11;--surface:#161618;--raised:#1e1e21;--line:#28282c;--line-strong:#38383e;--fg:#ededef;--soft:#dcdce0;--muted:#a0a0a8;--faint:#86868e;
--up:#86efc4;--warn:#ffbd8c;--down:#ff8394;--lav:#b6a8ff;--info:#8ec5ff;
--sans:"Hanken Grotesk",ui-sans-serif,system-ui,sans-serif;--display:"Bricolage Grotesque",ui-sans-serif,system-ui,sans-serif;--mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color-scheme:dark}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
a{color:inherit}
a:focus-visible,.bar:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid var(--lav);outline-offset:3px;border-radius:4px}
.page{max-width:760px;margin:0 auto;padding:0 16px 48px}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;height:72px;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:12px;text-decoration:none}
.brand span{font:600 20px/1 var(--display);letter-spacing:-.01em;color:var(--muted);padding-left:12px;border-left:1px solid var(--line-strong)}
.logo{height:22px;width:auto;display:block}.logo rect{fill:var(--fg)}.logo rect.one{fill:var(--lav)}
.out{font-size:13px;color:var(--muted);text-decoration:none}.out:hover{color:var(--fg)}
.banner{display:flex;gap:14px;align-items:flex-start;margin-top:32px;padding:20px 22px;border:1px solid var(--line);border-radius:14px;background:var(--surface)}
.banner.up{border-color:rgba(134,239,196,.28);background:linear-gradient(0deg,rgba(134,239,196,.04),rgba(134,239,196,.04)),var(--surface)}
.banner.degraded{border-color:rgba(255,189,140,.4);background:linear-gradient(0deg,rgba(255,189,140,.06),rgba(255,189,140,.06)),var(--surface)}
.banner.down{border-color:rgba(255,131,148,.45);background:linear-gradient(0deg,rgba(255,131,148,.07),rgba(255,131,148,.07)),var(--surface)}
.banner.maintenance{border-color:rgba(142,197,255,.4);background:linear-gradient(0deg,rgba(142,197,255,.06),rgba(142,197,255,.06)),var(--surface)}
.banner h1{margin:0;font:600 26px/1.2 var(--display);letter-spacing:-.02em}
.banner p{margin:6px 0 0;color:var(--muted);font-size:14px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--faint);flex:none}
.dot.big{width:12px;height:12px;margin-top:9px;box-shadow:0 0 0 4px rgba(134,239,196,.12)}
.dot.up{background:var(--up)}.dot.degraded,.dot.partial{background:var(--warn)}.dot.down{background:var(--down)}.dot.maintenance{background:var(--info)}.dot.unmonitored,.dot.unknown{background:var(--faint)}
.dot.big.degraded{box-shadow:0 0 0 4px rgba(255,189,140,.14)}.dot.big.down{box-shadow:0 0 0 4px rgba(255,131,148,.16)}.dot.big.maintenance{box-shadow:0 0 0 4px rgba(142,197,255,.14)}.dot.big.unknown{box-shadow:none}
.block{margin-top:40px}
.block h2,.month h2{margin:0 0 12px;font:600 13px/1.4 var(--sans);color:var(--muted);letter-spacing:.02em}
.block-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.block-head a{font-size:13px;color:var(--muted);text-decoration:none}.block-head a:hover{color:var(--fg)}
.components{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:14px;background:var(--surface)}
.component{padding:16px 18px 14px}
.component+.component{border-top:1px solid var(--line)}
.row{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.name{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px;min-width:0}
.name h3{margin:0;font-size:15px;font-weight:600}
.address{font:12px/1.4 var(--mono);color:var(--faint);overflow-wrap:anywhere}
.state{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:500;white-space:nowrap}
.s-up{color:var(--up)}.s-degraded,.s-partial{color:var(--warn)}.s-down{color:var(--down)}.s-maintenance{color:var(--info)}.s-unmonitored{color:var(--faint)}
.seen{margin:2px 0 0;font-size:12px;color:var(--faint)}
.unchecked{margin:8px 0 2px;font-size:13px;color:var(--faint)}
.history{margin-top:12px}
.bar{list-style:none;margin:0;padding:0;display:flex;gap:2px;height:30px}
.bar li{flex:1 1 0;min-width:0;border-radius:2px;background:var(--line);transition:opacity .12s}
.bar li.up{background:var(--up);opacity:.85}.bar li.degraded{background:var(--warn)}.bar li.down{background:var(--down)}
.bar:hover li,.bar:focus li{opacity:.55}.bar li.on,.bar:hover li:hover{opacity:1;transform:scaleY(1.08)}
.legend{display:flex;justify-content:space-between;margin-top:6px;font-size:12px;color:var(--faint)}
.legend .uptime{color:var(--muted)}
.legend .short{display:none}
.detail{margin:4px 0 0;min-height:18px;font-size:12px;color:var(--soft)}
.incident,.card{border:1px solid var(--line);border-radius:14px;background:var(--surface);padding:16px 18px;margin-bottom:12px}
.incident.open.degraded{border-color:rgba(255,189,140,.4)}.incident.open.down{border-color:rgba(255,131,148,.45)}.incident.maint{border-color:rgba(142,197,255,.35)}
.incident header,.page-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:6px 12px}
.incident h3{margin:0;font-size:15px;font-weight:600}
.incident h3 a,.line-head a{text-decoration:none}.incident h3 a:hover,.line-head a:hover{text-decoration:underline;text-underline-offset:3px}
.page-head{margin-top:20px}
.page-head h1{margin:0;font:600 24px/1.25 var(--display);letter-spacing:-.02em;overflow-wrap:anywhere}
.crumbs{margin:24px 0 0;font-size:13px;color:var(--faint)}.crumbs a{color:var(--muted);text-decoration:none}.crumbs a:hover{color:var(--fg)}
.pill{font-size:12px;font-weight:500;padding:1px 8px;border-radius:999px;border:1px solid var(--line-strong);color:var(--muted);white-space:nowrap}
.pill.degraded{color:var(--warn);border-color:rgba(255,189,140,.4)}.pill.down{color:var(--down);border-color:rgba(255,131,148,.45)}.pill.maint{color:var(--info);border-color:rgba(142,197,255,.4)}
.meta{margin:4px 0 0;font-size:12px;color:var(--faint)}
.impacts{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:6px}
.affects{font-size:12px;color:var(--muted)}
.impact{margin-left:4px;font-weight:500}.i-degraded,.i-partial_outage{color:var(--warn)}.i-major_outage{color:var(--down)}.i-operational{color:var(--up)}
.updates{list-style:none;margin:12px 0 0;padding:0 0 0 14px;border-left:1px solid var(--line-strong)}
.card>.updates{margin-top:0}
.updates li+li{margin-top:12px}
.when{margin:0;font-size:12px;color:var(--faint)}.when.latest{margin-top:8px}.when strong{color:var(--soft);font-weight:600;margin-right:4px}
.text p,.text li{margin:4px 0 0;font-size:14px;color:var(--soft)}
.text ul{margin:4px 0 0;padding-left:20px}
.empty{margin:0;color:var(--muted);font-size:14px;padding:16px 18px;border:1px dashed var(--line-strong);border-radius:14px}
.muted{color:var(--muted);font-size:14px}
.note{margin:14px 0 0;font-size:14px;color:var(--soft);padding:10px 14px;border:1px solid rgba(182,168,255,.35);border-radius:10px;background:rgba(182,168,255,.06)}
.lines{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:14px;background:var(--surface)}
.line{padding:12px 18px}.line+.line{border-top:1px solid var(--line)}
.line-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;font-weight:600;font-size:15px}
.tag{font-size:12px;font-weight:500;color:var(--lav);text-decoration:none;white-space:nowrap}
.last{margin:4px 0 0;font-size:13px;color:var(--muted)}
.month{margin-top:28px}.month:has(.none){margin-top:18px}.month:has(.none) h2{margin-bottom:2px}
.postmortem .pm-section+.pm-section{margin-top:18px}
.pm-section h3{margin:0;font-size:15px;font-weight:600}
form.subscribe{display:flex;gap:8px;flex-wrap:wrap}
input[type=email]{flex:1 1 220px;min-width:0;font:inherit;font-size:14px;color:var(--fg);background:var(--bg);border:1px solid var(--line-strong);border-radius:8px;padding:9px 12px}
input[type=email]::placeholder{color:var(--faint)}
button{font:inherit;font-size:14px;font-weight:600;color:var(--bg);background:var(--lav);border:0;border-radius:8px;padding:9px 16px;cursor:pointer}
button:hover{background:#c8bdff}
.trap{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.feeds{margin:10px 0 0;font-size:13px;color:var(--faint)}.feeds a,.muted a,.note a{color:var(--soft)}
.stack{display:flex;flex-direction:column;gap:10px}.stack label{font-size:13px;color:var(--muted)}
.stack button{align-self:flex-start}.stack input[type=email]{flex:none}
.page-head+.card,.page-head+.muted+.card{margin-top:16px}
.month .none{margin:0;font-size:13px;color:var(--faint)}
fieldset{border:0;padding:0;margin:6px 0 0}legend{font-size:13px;color:var(--muted);padding:0}
fieldset .muted{margin:2px 0 8px;font-size:13px}
.checks{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:6px}
.check{display:flex;align-items:center;gap:8px;font-size:14px;color:var(--soft)!important;padding:6px 10px;border:1px solid var(--line);border-radius:8px}
.check input{accent-color:var(--lav)}
.message{margin-top:24px}.message h1{margin:0;font:600 22px/1.25 var(--display)}.message p{color:var(--muted);font-size:14px}
.about p{margin:0;font-size:13px;color:var(--muted);max-width:68ch}
.about dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:16px 0 0;font-size:13px}
.about dt{color:var(--soft)}.about dd{margin:0;color:var(--faint)}
.foot{display:flex;flex-wrap:wrap;gap:8px;margin-top:48px;padding-top:20px;border-top:1px solid var(--line);font-size:13px;color:var(--faint)}
.foot a{text-decoration:none;color:var(--muted)}.foot a:hover{color:var(--fg)}
@media (max-width:640px){
.bar li:nth-child(-n+${HISTORY_DAYS - 30}){display:none}
.bar{gap:3px}
.legend .long{display:none}.legend .short{display:inline}
.banner{padding:16px}.banner h1{font-size:22px}
.component,.incident,.card,.line{padding:14px}
.about dl{grid-template-columns:1fr;gap:2px}.about dd{margin-bottom:8px}
}
@media (prefers-reduced-motion:reduce){.bar li{transition:none}}
`;
