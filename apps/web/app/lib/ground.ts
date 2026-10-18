/**
 * The workspace overview's ground truth, shaped from one reading of the
 * work (lib/signals.ts) for components/ground-truth.tsx: the pulse, spend
 * threaded to the work, each team's last two weeks, what waits on a first
 * review, and the quiet changes, each list in sentences. Imports only types
 * and pure functions, so the page's parts can be drawn and tested alone.
 */
import type { SignalData } from "./signals.server";
import {
  type Group,
  dailySignal,
  dayList,
  harnessWords,
  namesWords,
  newGround,
  newHabits,
  providerQuarter,
  quarterSpend,
  rhythm,
  silos,
  spendFlow,
  spoken,
  spreading,
  waitingRows,
} from "./signals";

/** Entries each quiet change lists. */
export const QUIET_ROWS = 4;

/** What the rhythm's rows are: teams by their projects, else the projects. Null when identity did not answer. */
export type Groups = { groups: Group[]; by: "team" | "project" } | null;

export function shapeGround(found: SignalData, groups: Groups, now: number) {
  const name = (id: string) => found.repos[id]?.name ?? "a project";
  const path = (id: string) => (found.repos[id] ? `/${found.repos[id]!.namespace}/${found.repos[id]!.name}` : null);
  const quarter = quarterSpend({ repos: found.repos, signals: found.signals, quarterUsage: found.quarterUsage, quarter: found.range.quarter });
  // Practices catching on in each team (else across the workspace), the newest first.
  const scopes =
    groups?.by === "team"
      ? groups.groups.map((group) => ({ key: group.key, label: group.label, only: new Set(group.repoIds) as ReadonlySet<string> | undefined }))
      : [{ key: "all", label: "the workspace", only: undefined }];
  const spreads = scopes.flatMap((scope) => spreading(found.signals.harnesses, now, { only: scope.only }).map((spread) => ({ scope, spread })));
  return {
    tiles: dailySignal(found).tiles,
    complete: found.complete,
    capped: found.signals.pullsCapped,
    flow: spendFlow({ slug: found.slug, repos: found.repos, signals: found.signals, quarterUsage: found.quarterUsage, quarter: found.range.quarter }),
    sized: (quarter?.total ?? 0) > 0 ? ("spend" as const) : ("pulls" as const),
    quarterSpend: quarter?.total ?? null,
    sessionSpend: quarter?.sessions ?? 0,
    rhythm: groups ? { by: groups.by, rows: rhythm(found.signals.days, dayList(found.range.until, found.range.days), groups.groups) } : null,
    waiting: waitingRows(found.signals.waiting, found.repos).map((pull) => ({ ...pull, age: spoken(Math.max(0, (now - Date.parse(pull.createdAt)) / 1000)) })),
    silos: silos(found.signals.authors, now)
      .slice(0, QUIET_ROWS)
      .map((silo) => ({
        key: silo.repoId,
        to: path(silo.repoId),
        where: name(silo.repoId),
        line: `${silo.name} merged ${silo.theirs} of its ${silo.recent} changes in 90 days`,
        more: silo.joining.length > 0 ? `${silo.joining.map((who) => who.name).join(", ")} started this month` : "No one else has started there",
      })),
    newGround: newGround(found.signals.authors, now)
      .slice(0, QUIET_ROWS)
      .map((row) => ({
        key: `${row.ownerId}:${row.repoId}`,
        to: path(row.repoId),
        where: name(row.repoId),
        line: `${row.name} merged a first change here`,
        more: `${row.elsewhere} merges elsewhere first`,
      })),
    spreading: spreads.slice(0, QUIET_ROWS).map(({ scope, spread }) => ({
      key: `${scope.key}:${spread.harness}`,
      to: null,
      where: `${harnessWords(spread.harness)} in ${scope.label}`,
      line: `${namesWords(spread.recent.map((person) => person.name))} started using it this month, after ${spread.first.name}`,
      more: `${spread.people} people use it now`,
    })),
    habits: newHabits(found.signals.pulls, now)
      .slice(0, QUIET_ROWS)
      .map((row) => ({
        key: row.ownerId,
        to: path(row.repoId),
        where: name(row.repoId),
        line: `${row.name} merged a first agent-made change`,
        more: `after ${row.byHand} by hand`,
      })),
  };
}

export type Ground = ReturnType<typeof shapeGround> & { providers: ReturnType<typeof providerQuarter> };
