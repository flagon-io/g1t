/**
 * Workflow status badges: an SVG saying how a workflow's latest finished
 * run went, at `/{workspace}/{repo}/actions/workflows/{file}/badge.svg`,
 * and the Markdown that shows one.
 */

import type { WorkflowRun } from "@g1t/contracts";

export type BadgeState = "passing" | "failing" | "cancelled" | "no status";

const COLORS: Record<BadgeState, string> = {
  passing: "#2ea043",
  failing: "#cf222e",
  cancelled: "#6e7681",
  "no status": "#6e7681",
};
const LABEL_COLOR = "#2b2a33";

/** What the newest finished run among `runs` (newest first) came to. */
export function badgeState(runs: WorkflowRun[]): BadgeState {
  const run = runs.find((candidate) => candidate.status === "completed");
  switch (run?.conclusion) {
    case "success":
    case "skipped":
      return "passing";
    case "failure":
      return "failing";
    case "cancelled":
      return "cancelled";
    default:
      return "no status";
  }
}

/** Roughly how wide `text` is in 11px Verdana, as badges are drawn. */
export function textWidth(text: string): number {
  let width = 0;
  for (const c of text) {
    if ("iljtfI.,:;'|!".includes(c)) width += 3.5;
    else if ("mwMW@%".includes(c)) width += 10.5;
    else if (c === " ") width += 3.8;
    else if (/[A-Z0-9]/.test(c)) width += 7.6;
    else width += 6.6;
  }
  return Math.ceil(width);
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** A flat badge: `label` on dark gray, `state` in its color. */
export function badgeSvg(label: string, state: BadgeState): string {
  const shown = label.length > 60 ? `${label.slice(0, 59)}…` : label;
  const left = textWidth(shown) + 12;
  const right = textWidth(state) + 12;
  const width = left + right;
  const title = escape(`${shown}: ${state}`);
  const text = (x: number, value: string) =>
    `<text x="${x}" y="15" fill="#010101" fill-opacity=".3">${escape(value)}</text><text x="${x}" y="14">${escape(value)}</text>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${title}">`,
    `<title>${title}</title>`,
    `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>`,
    `<clipPath id="r"><rect width="${width}" height="20" rx="3" fill="#fff"/></clipPath>`,
    `<g clip-path="url(#r)"><rect width="${left}" height="20" fill="${LABEL_COLOR}"/><rect x="${left}" width="${right}" height="20" fill="${COLORS[state]}"/><rect width="${width}" height="20" fill="url(#s)"/></g>`,
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">`,
    text(left / 2, shown),
    text(left + right / 2, state),
    `</g></svg>`,
  ].join("");
}

/** The badge's address, with its branch and event when chosen. */
export function badgeUrl(site: string, repo: string, file: string, options: { branch?: string; event?: string } = {}): string {
  const query = new URLSearchParams();
  if (options.branch) query.set("branch", options.branch);
  if (options.event) query.set("event", options.event);
  const tail = query.size > 0 ? `?${query}` : "";
  return `${site}/${repo}/actions/workflows/${encodeURIComponent(file)}/badge.svg${tail}`;
}

/** Markdown for a badge that links to the workflow's runs. */
export function badgeMarkdown(site: string, repo: string, workflow: { name: string; file: string }, options: { branch?: string; event?: string } = {}): string {
  const alt = workflow.name.replace(/[[\]]/g, "");
  const runs = `${site}/${repo}/actions?workflow=${encodeURIComponent(workflow.file)}`;
  return `[![${alt}](${badgeUrl(site, repo, workflow.file, options)})](${runs})`;
}
