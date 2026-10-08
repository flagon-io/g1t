/**
 * An incident's parts, check by check, as the status worker keeps them
 * (7 days, `AdminIncidentDetail.checks`): the layout of the latency chart
 * on the incident page, and the words over it. Drawn on the server as SVG;
 * nothing here runs in the browser.
 */
import type { CheckHistory, CheckSample } from "@g1t/contracts";

import { median } from "./incidents.ts";

/** Checks further apart than this are drawn as a gap, not a line across it. */
const GAP_MS = 3 * 60_000;

export type LatencyPlot = {
  width: number;
  height: number;
  plot: { x: number; y: number; width: number; height: number };
  /** The top of the scale, in milliseconds. */
  max: number;
  /** The answered checks as one path; a check that failed, or a gap, breaks it. */
  line: string;
  /** Where the slow line is; null when the part's limit is not known. */
  slowY: number | null;
  /** Slow checks, as dots on the line. */
  slow: { x: number; y: number }[];
  /** Checks that failed, as marks along the top. */
  down: { x: number }[];
  /** Gridlines, with their label. */
  ticks: { y: number; label: string }[];
};

/** "800 ms", "1.5 s". */
export function msWords(ms: number): string {
  return ms >= 1000 ? `${Number((ms / 1000).toFixed(1))} s` : `${Math.round(ms)} ms`;
}

/** A round top for the scale: the next 250 ms under a second, then the next half second. */
function niceMax(ms: number): number {
  const step = ms <= 1000 ? 250 : 500;
  return Math.max(step, Math.ceil(ms / step) * step);
}

export function latencyPlot(history: CheckHistory, { width = 640, height = 120 } = {}): LatencyPlot {
  const plot = { x: 44, y: 8, width: width - 52, height: height - 26 };
  const answered = history.samples.filter((s) => s.outcome !== "down" && s.ms != null);
  const top = Math.max(history.slow_ms != null ? history.slow_ms * 1.5 : 0, ...answered.map((s) => s.ms!), 1);
  const max = niceMax(top);
  const from = Date.parse(history.from);
  const span = Math.max(1, Date.parse(history.to) - from);
  const xOf = (at: string) => plot.x + (Math.min(Math.max(Date.parse(at) - from, 0), span) / span) * plot.width;
  const yOf = (ms: number) => plot.y + plot.height - (Math.min(ms, max) / max) * plot.height;
  const round = (n: number) => Math.round(n * 10) / 10;

  let line = "";
  let last: CheckSample | null = null;
  for (const s of history.samples) {
    if (s.outcome === "down" || s.ms == null) {
      last = null;
      continue;
    }
    const joined = last != null && Date.parse(s.at) - Date.parse(last.at) <= GAP_MS;
    line += `${joined ? "L" : "M"}${round(xOf(s.at))} ${round(yOf(s.ms))}`;
    last = s;
  }
  const ticks = [0, max / 2, max].map((v) => ({ y: round(yOf(v)), label: v === 0 ? "0" : msWords(v) }));
  return {
    width,
    height,
    plot,
    max,
    line,
    slowY: history.slow_ms != null ? round(yOf(history.slow_ms)) : null,
    slow: history.samples.filter((s) => s.outcome === "degraded" && s.ms != null).map((s) => ({ x: round(xOf(s.at)), y: round(yOf(s.ms!)) })),
    down: history.samples.filter((s) => s.outcome === "down").map((s) => ({ x: round(xOf(s.at)) })),
    ticks,
  };
}

export type LatencySummary = {
  checks: number;
  slow: number;
  down: number;
  /** Of the checks that answered. */
  median_ms: number | null;
  slowest_ms: number | null;
  /** Slow at first and asked again at once. */
  asked_again: number;
  /** Where the checks ran from, most first. */
  colos: string[];
};

export function latencySummary(samples: CheckSample[]): LatencySummary {
  const answered = samples.filter((s) => s.outcome !== "down" && s.ms != null).map((s) => s.ms!);
  const colos = new Map<string, number>();
  for (const s of samples) if (s.colo) colos.set(s.colo, (colos.get(s.colo) ?? 0) + 1);
  return {
    checks: samples.length,
    slow: samples.filter((s) => s.outcome === "degraded").length,
    down: samples.filter((s) => s.outcome === "down").length,
    median_ms: median(answered),
    slowest_ms: answered.length ? Math.max(...answered) : null,
    asked_again: samples.filter((s) => s.first_ms != null).length,
    colos: [...colos].sort((a, b) => b[1] - a[1]).map(([c]) => c),
  };
}

/** The summary in a line: "62 checks · 14 slow · 2 not answering · median 640 ms · slowest 2.4 s · from IAD". */
export function summaryWords(s: LatencySummary): string {
  const parts = [`${s.checks} check${s.checks === 1 ? "" : "s"}`, `${s.slow} slow`, `${s.down} not answering`];
  if (s.median_ms != null) parts.push(`median ${msWords(s.median_ms)}`);
  if (s.slowest_ms != null) parts.push(`slowest ${msWords(s.slowest_ms)}`);
  if (s.asked_again) parts.push(`${s.asked_again} asked again`);
  if (s.colos.length) parts.push(`from ${s.colos.join(", ")}`);
  return parts.join(" · ");
}
