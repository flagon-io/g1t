
import type { Contributor, WeekCommits } from "@g1t/contracts";

import type { Route } from "./+types/contributors";
import { CommitAvatar, CommitName } from "../../components/commit-person";
import { EmptyState, TimeAgo } from "../../components/ui";
import { Hint } from "../../components/ui/hint";
import { requireRepo } from "../../lib/access.server";
import { alignWeeks, count, peak } from "../../lib/about";
import { contributorPerson } from "../../lib/commit-people";
import { page } from "../../lib/meta";
import { repos } from "../../lib/services.server";
import { unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Contributors · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const { viewer } = await requireRepo(context, params, "read");
  return { contributors: unwrap(await repos.contributors({ namespace: params.owner, name: params.repo }, viewer)) };
}

/** The most weeks a chart shows: the latest. */
const WEEKS = 52;

function weekLabel(week: string): string {
  return new Date(`${week}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** Commits per week as bars, newest on the right, each with its week on hover. */
function WeekBars({ weeks, values, height, label, scale }: { weeks: WeekCommits[]; values: number[]; height: number; label: string; scale?: number }) {
  // One scale for every contributor, so their bars compare.
  const top = scale ?? Math.max(1, ...values);
  return (
    <div role="img" aria-label={label} className="flex items-end gap-[2px]" style={{ height }}>
      {values.map((value, at) => (
        <Hint key={weeks[at].week} label={`${count(value, "commit")} · week of ${weekLabel(weeks[at].week)}`}>
          <span className="flex h-full min-w-0 flex-1 items-end">
            <span
              className={`w-full rounded-t-[2px] ${value > 0 ? "bg-accent" : "bg-line"}`}
              style={{ height: value > 0 ? `${Math.max(6, (value / top) * 100)}%` : 2 }}
            />
          </span>
        </Hint>
      ))}
    </div>
  );
}

function Person({ contributor, rank, weeks, scale }: { contributor: Contributor; rank: number; weeks: WeekCommits[]; scale: number }) {
  // The same person, avatar, link and card as on their commits.
  const person = contributorPerson(contributor);
  return (
    <li className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center gap-3">
        <CommitAvatar person={person} size={36} />
        <div className="min-w-0 grow">
          <p className="flex items-center gap-2 truncate text-sm">
            <CommitName person={person} className="font-medium" />
          </p>
          <p className="text-xs text-muted">
            {count(contributor.commits, "commit")} · last <TimeAgo at={contributor.lastAt} />
          </p>
        </div>
        <span className="text-xs text-faint tabular-nums">#{rank}</span>
      </div>
      {contributor.weeks.length > 0 && weeks.length > 0 && (
        <div className="mt-3">
          <WeekBars weeks={weeks} values={alignWeeks(weeks, contributor.weeks)} height={40} label={`${contributor.name}'s commits by week`} scale={scale} />
        </div>
      )}
    </li>
  );
}

export default function Contributors({ loaderData }: Route.ComponentProps) {
  const { contributors } = loaderData;
  const weeks = contributors.weeks.slice(-WEEKS);
  const all = weeks.map((week) => week.commits);
  const scale = Math.max(1, ...contributors.contributors.flatMap((contributor) => alignWeeks(weeks, contributor.weeks)));
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">
          Contributors <span className="font-normal text-faint">{contributors.total}</span>
        </h2>
        <p className="mt-1 text-sm text-muted">
          Commits on the default branch by who made them: people by the addresses they confirmed, g1t as itself, anyone else by
          the name on their commits.
          {contributors.partial && ` The newest ${contributors.commits.toLocaleString("en-US")} commits are counted.`}
        </p>
      </div>
      {contributors.pending ? (
        <EmptyState title="Reading the history">The default branch is being read for the first time. This page has it in a few seconds.</EmptyState>
      ) : contributors.contributors.length === 0 ? (
        <EmptyState title="No commits yet">Push a first commit and who made it shows here.</EmptyState>
      ) : (
        <>
          <section className="rounded-xl border border-line bg-surface p-5">
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold">Commits per week</h3>
              <span className="text-xs text-muted">
                {count(contributors.commits, "commit")} · peak {peak(weeks)} a week
              </span>
            </div>
            <WeekBars weeks={weeks} values={all} height={120} label="Commits per week" />
            <div className="mt-2 flex justify-between text-xs text-faint">
              <span>{weeks[0] && weekLabel(weeks[0].week)}</span>
              <span>{weeks.at(-1) && weekLabel(weeks.at(-1)!.week)}</span>
            </div>
          </section>
          <ul className="grid gap-3 md:grid-cols-2">
            {contributors.contributors.map((contributor, at) => (
              <Person key={`${contributor.kind}:${contributor.name}`} contributor={contributor} rank={at + 1} weeks={weeks} scale={scale} />
            ))}
          </ul>
          {contributors.computedAt && (
            <p className="text-xs text-faint">
              Counted <TimeAgo at={contributors.computedAt} />
              {contributors.commit && contributors.head && contributors.commit !== contributors.head && ", and being counted again for the newest commits"}.
            </p>
          )}
        </>
      )}
    </div>
  );
}
