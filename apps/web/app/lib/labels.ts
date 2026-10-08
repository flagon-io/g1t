// Labels and milestones as pages show them: a label's chip colors from its
// own color, a milestone's progress and due date in words, and the filters
// lists take. Pure, so it is tested without a browser.

/** A label as a chip needs it. */
export type LabelLike = { name: string; color?: string | null };

/** What a list knows of a repository's labels: their colors, by name. */
export type LabelColors = Record<string, string>;

export function colorsOf(labels: { name: string; color: string }[]): LabelColors {
  return Object.fromEntries(labels.map((label) => [label.name, label.color]));
}

/** Six lowercase hex digits from `#A1B2C3`, `a1b2c3` or `abc`; null otherwise. */
export function tidyColor(color: string | null | undefined): string | null {
  const hex = (color ?? "").trim().replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex)) return null;
  if (hex.length === 6) return hex;
  if (hex.length === 3) return [...hex].map((c) => c + c).join("");
  return null;
}

/**
 * A chip's colors from a label's own: a tinted fill and border, and text
 * mixed toward the page's text color so that it reads on a dark or a light
 * page alike. A label without a usable color is drawn in neutral tones.
 */
export function chipStyle(color: string | null | undefined): Record<string, string> {
  const hex = tidyColor(color);
  if (!hex) return {};
  return {
    color: `color-mix(in oklab, #${hex} 55%, var(--color-fg))`,
    borderColor: `color-mix(in oklab, #${hex} 55%, transparent)`,
    backgroundColor: `color-mix(in oklab, #${hex} 18%, transparent)`,
  };
}

/** Labels that match what someone typed: by name or description. */
export function matchLabels<T extends { name: string; description?: string }>(labels: T[], query: string): T[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return labels;
  return labels.filter((label) => {
    const text = `${label.name} ${label.description ?? ""}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** A label name as g1t keeps them: lowercase, single spaces. */
export function tidyLabelName(name: string): string {
  return name.trim().split(/\s+/).join(" ").toLowerCase();
}

/** A milestone's progress: closed items over all of them, 0 to 100. */
export function percentDone(milestone: { openItems: number; closedItems: number }): number {
  const total = milestone.openItems + milestone.closedItems;
  return total === 0 ? 0 : Math.floor((milestone.closedItems * 100) / total);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** `2026-10-14` as "October 14, 2026". */
export function dayInWords(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return day;
  return `${MONTHS[month - 1]} ${date}, ${year}`;
}

/**
 * When a milestone is due, said against today: "Due by October 14, 2026",
 * "Past due by 3 days", or for a closed one simply when it was due.
 */
export function dueInWords(milestone: { dueOn: string | null; state: string }, today: Date): string | null {
  if (!milestone.dueOn) return null;
  const due = Date.parse(`${milestone.dueOn}T23:59:59Z`);
  const late = Math.floor((today.getTime() - due) / 86_400_000);
  if (milestone.state === "open" && late >= 0) {
    const days = late + 1;
    return `Past due by ${days} ${days === 1 ? "day" : "days"}`;
  }
  return `Due by ${dayInWords(milestone.dueOn)}`;
}

/** Whether an open milestone's day has passed. */
export function isOverdue(milestone: { dueOn: string | null; state: string }, today: Date): boolean {
  return milestone.state === "open" && milestone.dueOn != null && Date.parse(`${milestone.dueOn}T23:59:59Z`) < today.getTime();
}

/**
 * The filters an issue or pull request list reads from its address:
 * `?label=bug&milestone=3`, and `label:bug milestone:3 is:closed` written
 * in `q`, which win over the plain parameters.
 */
export function listFilters(query: URLSearchParams): { label: string; milestone: number | null; state: "open" | "closed"; base: string } {
  let label = query.get("label") ?? "";
  let milestone = Number(query.get("milestone")) || null;
  let state: "open" | "closed" = query.get("state") === "closed" ? "closed" : "open";
  let base = query.get("base") ?? "";
  for (const [, key, quoted, plain] of (query.get("q") ?? "").matchAll(/(\w+):(?:"([^"]*)"|(\S+))/g)) {
    const value = quoted ?? plain ?? "";
    if (key === "label") label = value;
    else if (key === "milestone") milestone = Number(value) || null;
    else if (key === "is" && (value === "open" || value === "closed")) state = value;
    else if (key === "base") base = value;
  }
  return { label: label ? tidyLabelName(label) : "", milestone, state, base };
}

/** A list's address with one filter changed, keeping the others. */
export function withFilter(path: string, current: URLSearchParams, key: string, value: string | null): string {
  const next = new URLSearchParams(current);
  next.delete("q");
  if (value == null || value === "") next.delete(key);
  else next.set(key, value);
  const text = next.toString();
  return text ? `${path}?${text}` : path;
}
