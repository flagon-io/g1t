/**
 * A cycle's page, apart from its route (routes/workspace/work/cycle.tsx)
 * so the route stays a thin loader and the page can be drawn on its own:
 * the days and what is left of them, the figures, the burn-up, where each
 * work item stands, each person's and agent's share, what is planned into
 * the coming cycle, and the past cycles. A closed cycle's is its report.
 */
import { ArrowRight, ChevronLeft, ChevronRight, History, Settings, Timer } from "lucide-react";
import { Link } from "react-router";

import type { Cycle, CycleDetail } from "@g1t/contracts";

import { STAGES, STAGE_INFO, type Stage } from "../lib/board";
import {
  burnUp,
  byAgent,
  byPerson,
  cycleDays,
  cycleDaysLeft,
  cycleName,
  cyclePath,
  cyclePlanPath,
  cycleReport,
  cycleStageOf,
  dayText,
  daysLeftText,
  doneOfScope,
  shortDay,
  stageCounts,
  workSettingsPath,
} from "../lib/cycles";
import { Unavailable } from "./boundary";
import { BurnUp, CycleItemRow, Figure, Figures, Shares, StageStrip } from "./cycles";
import { ButtonLink } from "./ui";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";

const STATE_BADGE: Record<Cycle["state"], { label: string; tone: "accent" | "neutral" | "info" }> = {
  running: { label: "Running", tone: "accent" },
  upcoming: { label: "Upcoming", tone: "info" },
  closed: { label: "Closed", tone: "neutral" },
};

export function CyclePageBody({
  detail,
  past,
  pastFailed,
  workspace,
  canConfigure,
  now,
  today,
}: {
  detail: CycleDetail;
  past: Cycle[];
  pastFailed: boolean;
  workspace: string;
  canConfigure: boolean;
  now: number;
  today: string;
}) {
  const { cycle, members } = detail;
  const closed = cycle.state === "closed";
  const current = !closed && detail.settings.enabled;
  const days = Math.max(1, Math.round((Date.parse(`${cycle.endsOn}T00:00:00Z`) - Date.parse(`${cycle.startsOn}T00:00:00Z`)) / 86_400_000) + 1);
  const points = burnUp(detail, today);
  const counts = stageCounts(detail, now);
  const people = byPerson(detail);
  const agents = byAgent(detail);
  const report = cycleReport(detail);
  const memberOf = (number: number) => members.find((one) => one.number === number);
  const trail = {
    numbers: detail.items.map((item) => item.number),
    label: cycleName(cycle),
    href: current ? cyclePath(workspace) : cyclePath(workspace, cycle.number),
  };
  const badge = STATE_BADGE[cycle.state];
  const percent = cycle.scope ? Math.round((cycle.done / cycle.scope) * 100) : 0;
  const previous = cycle.number > 1 ? cycle.number - 1 : null;
  const newer = closed ? cycle.number + 1 : null;
  // Where each still in it stands, Up next to Done.
  const byStage = new Map<Stage, typeof detail.items>();
  for (const item of detail.items) {
    const stage = cycleStageOf(item, memberOf(item.number), cycle, now);
    if (stage) byStage.set(stage, [...(byStage.get(stage) ?? []), item]);
  }
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Timer size={17} className="text-accent" />
            {cycleName(cycle)}
            <Badge tone={badge.tone}>{badge.label}</Badge>
          </h1>
          <p className="mt-1 text-sm text-muted">
            {cycleDays(cycle)} · <span className="text-fg-soft">{daysLeftText(cycle, today)}</span>
            {current && <span className="max-sm:hidden"> · Now is this cycle</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <nav aria-label="Other cycles" className="flex items-center">
            {previous != null && (
              <ButtonLink to={cyclePath(workspace, previous)} variant="ghost" size="sm" aria-label={`Cycle ${previous}`} className="max-sm:h-10">
                <ChevronLeft size={15} />
                {previous}
              </ButtonLink>
            )}
            {newer != null && (
              <ButtonLink to={cyclePath(workspace, newer)} variant="ghost" size="sm" aria-label={`Cycle ${newer}`} className="max-sm:h-10">
                {newer}
                <ChevronRight size={15} />
              </ButtonLink>
            )}
          </nav>
          {current && detail.next && (
            <ButtonLink to={cyclePlanPath(workspace)} variant="outline" className="max-sm:h-10">
              Plan {cycleName(detail.next)}
              <ArrowRight size={14} />
            </ButtonLink>
          )}
        </div>
      </div>

      <div className="mt-5">
        <Figures label={`${cycleName(cycle)} in figures`}>
          <Figure label="Scope" value={cycle.scope} note={cycle.added > 0 ? `+${cycle.added} added mid-cycle` : "nothing added mid-cycle"} />
          <Figure label="Done" value={cycle.done} note={cycle.scope ? `${percent}% of its scope` : undefined} />
          <Figure label="Carried in" value={cycle.carriedIn} note={previous != null ? `from Cycle ${previous}` : "the first cycle"} />
          {closed ? (
            <Figure label="Carried out" value={cycle.carriedOut} note={`into Cycle ${cycle.number + 1}`} />
          ) : (
            <Figure
              label={cycle.state === "upcoming" ? "Starts" : "Days left"}
              value={cycle.state === "upcoming" ? shortDay(cycle.startsOn) : cycleDaysLeft(cycle, today)}
              note={cycle.state === "upcoming" ? "after the cooldown" : `of ${days}`}
            />
          )}
        </Figures>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 content-start gap-4">
          <Card asChild className="min-w-0">
            <section aria-labelledby="cycle-burn" className="px-4 pt-3 pb-3">
              <header className="mb-2 flex items-center gap-2">
                <h2 id="cycle-burn" className="text-sm font-semibold">
                  Burn-up
                </h2>
                <span className="text-xs text-faint">what it took on, and what is done</span>
              </header>
              <BurnUp points={points} days={days} label={`${cycleName(cycle)}: ${doneOfScope(cycle)} done, day by day`} />
            </section>
          </Card>

          {!closed && (
            <Card asChild className="min-w-0">
              <section aria-labelledby="cycle-stages" className="px-4 pt-3 pb-4">
                <header className="mb-3 flex items-center gap-2">
                  <h2 id="cycle-stages" className="text-sm font-semibold">
                    Where it stands
                  </h2>
                  <span className="text-xs text-faint">read from the record, never set by hand</span>
                </header>
                <StageStrip counts={counts} />
              </section>
            </Card>
          )}

          <Card asChild className="min-w-0">
            <section aria-labelledby="cycle-items">
              <header className="flex items-center gap-2 px-4 pt-3 pb-2">
                <h2 id="cycle-items" className="text-sm font-semibold">
                  {closed ? "Report" : "Work items"}
                </h2>
                <span className="ml-auto font-mono text-xs tabular-nums text-faint">{doneOfScope(cycle)}</span>
              </header>
              {detail.items.length === 0 ? (
                <p className="mx-4 mb-3 rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-faint">
                  {closed ? "This cycle took on nothing." : "Nothing in this cycle yet. Move work into Now from the plan, or press Y on a work item."}
                </p>
              ) : closed ? (
                <div className="pb-2">
                  <ReportGroup title="Finished" items={report.finished} hint="closed in this cycle" {...{ workspace, trail, memberOf }} />
                  <ReportGroup
                    title={`Carried into Cycle ${cycle.number + 1}`}
                    items={report.carried}
                    hint="still open when it ended"
                    {...{ workspace, trail, memberOf }}
                  />
                  <ReportGroup title="Added mid-cycle" items={report.added} hint="taken on after its first day" {...{ workspace, trail, memberOf }} />
                </div>
              ) : (
                <div className="pb-2">
                  {STAGES.filter((stage) => byStage.has(stage)).map((stage) => (
                    <div key={stage} className="border-t border-line first:border-t-0">
                      <h3 className="flex items-center gap-2 px-4 pt-2.5 pb-1 text-xs font-medium text-muted">
                        {STAGE_INFO[stage].label}
                        <span className="font-mono tabular-nums text-faint">{byStage.get(stage)!.length}</span>
                      </h3>
                      <ul className="px-2">
                        {byStage.get(stage)!.map((item) => (
                          <CycleItemRow key={item.id} item={item} member={memberOf(item.number)} workspace={workspace} trail={trail} />
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </Card>
        </div>

        <div className="grid min-w-0 content-start gap-4">
          <Card asChild className="min-w-0">
            <section aria-labelledby="cycle-people" className="px-4 pt-3 pb-4">
              <h2 id="cycle-people" className="mb-3 text-sm font-semibold">
                By person
              </h2>
              <Shares tallies={people} kind="person" empty="Nobody's work yet." />
              <h2 className="mt-5 mb-3 text-sm font-semibold">By agent</h2>
              <Shares tallies={agents} kind="agent" empty="No agent has opened a pull request for this cycle's work." />
            </section>
          </Card>

          {current && detail.next && (
            <Card asChild className="min-w-0">
              <section aria-labelledby="cycle-next" className="pt-3">
                <header className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pb-2">
                  <h2 id="cycle-next" className="text-sm font-semibold">
                    {cycleName(detail.next)}
                  </h2>
                  <span className="text-xs text-faint">from {dayText(detail.next.startsOn)}</span>
                  <span className="ml-auto font-mono text-xs tabular-nums text-faint">{detail.planned.length} planned</span>
                </header>
                {detail.planned.length === 0 ? (
                  <p className="px-4 pb-3 text-xs text-faint">Nothing planned into it yet. What is still open here carries into it by itself.</p>
                ) : (
                  <ul className="px-2 pb-1">
                    {detail.planned.slice(0, 5).map((item) => (
                      <CycleItemRow key={item.id} item={item} workspace={workspace} />
                    ))}
                  </ul>
                )}
                <footer className="border-t border-line px-4 py-2.5 text-xs">
                  <Link to={cyclePlanPath(workspace)} className="inline-flex items-center gap-1 text-fg hover:text-accent">
                    Plan {cycleName(detail.next)} from Next
                    <ArrowRight size={13} />
                  </Link>
                </footer>
              </section>
            </Card>
          )}

          {pastFailed ? <Unavailable what="Past cycles" /> : <PastCycles past={past} workspace={workspace} current={cycle.number} />}
          {canConfigure && (
            <Link to={workSettingsPath(workspace)} className="inline-flex items-center gap-1.5 px-1 text-xs text-muted hover:text-fg">
              <Settings size={13} />
              {detail.settings.lengthDays === 7 ? "One-week" : "Two-week"} cycles · change in Work&apos;s settings
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

function ReportGroup({
  title,
  hint,
  items,
  workspace,
  trail,
  memberOf,
}: {
  title: string;
  hint: string;
  items: CycleDetail["items"];
  workspace: string;
  trail: { numbers: number[]; label: string; href: string };
  memberOf: (number: number) => CycleDetail["members"][number] | undefined;
}) {
  return (
    <div className="border-t border-line first:border-t-0">
      <h3 className="flex items-center gap-2 px-4 pt-2.5 pb-1 text-xs font-medium text-muted">
        {title}
        <span className="font-mono tabular-nums text-faint">{items.length}</span>
        <span className="font-normal text-faint max-sm:hidden">· {hint}</span>
      </h3>
      {items.length === 0 ? (
        <p className="px-4 pb-2 text-xs text-faint">None.</p>
      ) : (
        <ul className="px-2">
          {items.map((item) => (
            <CycleItemRow key={item.id} item={item} member={memberOf(item.number)} workspace={workspace} trail={trail} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** The cycles before, each with how much it did and carried. */
export function PastCycles({ past, workspace, current }: { past: Cycle[]; workspace: string; current: number | null }) {
  const shown = past.filter((one) => one.number !== current);
  return (
    <Card asChild className="min-w-0">
      <section aria-labelledby="cycle-past" className="pt-3">
        <header className="flex items-center gap-2 px-4 pb-2">
          <History size={14} className="text-faint" />
          <h2 id="cycle-past" className="text-sm font-semibold">
            Past cycles
          </h2>
        </header>
        {shown.length === 0 ? (
          <p className="px-4 pb-3 text-xs text-faint">None yet. A cycle&apos;s report is here once it ends.</p>
        ) : (
          <ul className="px-2 pb-2">
            {shown.map((one) => (
              <li key={one.number}>
                <Link
                  to={cyclePath(workspace, one.number)}
                  prefetch="intent"
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2 py-1.5 transition-colors hover:bg-raised/60"
                >
                  <span className="min-w-0 truncate text-sm">
                    {cycleName(one)}
                    <span className="ml-2 text-xs text-faint">{cycleDays(one)}</span>
                  </span>
                  <span className="font-mono text-xs tabular-nums text-muted">
                    <span className="text-fg">{one.done}</span>/{one.scope}
                    {one.carriedOut > 0 && <span className="ml-2 text-faint">{one.carriedOut} carried</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Card>
  );
}
