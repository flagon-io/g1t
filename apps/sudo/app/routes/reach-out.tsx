import { CalendarClock, ChevronRight } from "lucide-react";
import { Link } from "react-router";

import type { AdminOwner, Signal } from "@g1t/contracts";

import type { Route } from "./+types/reach-out";
import { Owners } from "~/components/billing";
import { SignalBadge, StaffName, StageBadge } from "~/components/sales";
import { Avatar, EmptyState, Notice, PageHeader, When } from "~/components/ui";
import { usd } from "~/lib/money";
import { identity, admin } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import {
  SIGNAL_KINDS,
  type Who,
  bySignalUrgency,
  countByKind,
  filterSignals,
  followUpsDue,
  isFollowUpDue,
  isSignalKind,
  parseWho,
  reachOutHref,
  today,
} from "~/lib/signals";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = () => [{ title: "Reach out · sudo" }, { name: "robots", content: "noindex, nofollow" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  const staff = requireStaff(context);
  const url = new URL(request.url);
  const rawKind = url.searchParams.get("kind");
  const kind = isSignalKind(rawKind) ? rawKind : null;
  const who = parseWho(url.searchParams.get("who"));
  const due = url.searchParams.get("due") === "1";
  const on = today();

  // Owners and names come from identity's list: one call, newest 500.
  const [signals, workspaces] = await Promise.all([settle(admin.signals()), settle(identity.workspaces())]);
  const every = signals.ok ? bySignalUrgency(signals.value) : [];
  const dueAll = followUpsDue(every, on);
  // Follow-ups due: one line per workspace whose next step is due.
  const all = due ? dueAll : every;
  const people = new Map(
    (workspaces.ok ? workspaces.value : []).map((workspace) => [workspace.slug, { name: workspace.name, owners: workspace.owners }]),
  );
  const forWho = filterSignals(all, { kind: null, who, me: staff.email });
  const rows = filterSignals(forWho, { kind, who: "all", me: staff.email }).map((signal) => ({
    signal,
    name: people.get(signal.workspace)?.name ?? null,
    owners: people.get(signal.workspace)?.owners ?? ([] as AdminOwner[]),
  }));
  return {
    me: staff.email,
    on,
    kind,
    who,
    due,
    dueCount: filterSignals(dueAll, { kind: null, who, me: staff.email }).length,
    rows,
    total: every.length,
    workspaces: new Set(every.map((signal) => signal.workspace)).size,
    counts: countByKind(forWho),
    whoCounts: {
      all: all.length,
      unassigned: filterSignals(all, { kind: null, who: "unassigned", me: staff.email }).length,
      mine: filterSignals(all, { kind: null, who: "mine", me: staff.email }).length,
    },
    error: signals.ok ? null : signals.error,
  };
}

const WHO: { who: Who; label: string }[] = [
  { who: "all", label: "Everyone's" },
  { who: "unassigned", label: "Unassigned" },
  { who: "mine", label: "Mine" },
];

function Pill({ to, active, children, count }: { to: string; active: boolean; children: React.ReactNode; count?: number }) {
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs whitespace-nowrap transition-colors ${
        active ? "border-accent/50 bg-accent/10 text-accent" : "border-line text-muted hover:border-line-strong hover:text-fg"
      }`}
    >
      {children}
      {count != null && <span className={`tabular ${active ? "text-accent/80" : "text-faint"}`}>{count}</span>}
    </Link>
  );
}

type Row = { signal: Signal; name: string | null; owners: AdminOwner[] };

function rowHref(signal: Signal) {
  return `/workspaces/${encodeURIComponent(signal.workspace)}#sales`;
}

export default function ReachOut({ loaderData }: Route.ComponentProps) {
  const { me, on, kind, who, due, dueCount, rows, total, workspaces, counts, whoCounts, error } = loaderData;
  const forWho = Object.values(counts).reduce((sum, count) => sum + count, 0);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <PageHeader
        title="Reach out"
        description={
          <>
            Workspaces worth a word now, most urgent first: stopped, declined, close to their limit, spending more, or newly steady.
            {total > 0 && (
              <>
                {" "}
                {total} signal{total === 1 ? "" : "s"} across {workspaces} workspace{workspaces === 1 ? "" : "s"}.
              </>
            )}
          </>
        }
      />

      {error && (
        <div className="mt-6">
          <Notice tone="warn">Billing did not answer for signals: {error}</Notice>
        </div>
      )}

      <nav aria-label="Filters" className="mt-6 space-y-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 w-10 text-xs text-faint">Whose</span>
          {WHO.map((option) => (
            <Pill key={option.who} to={reachOutHref({ kind, who: option.who, due })} active={who === option.who} count={whoCounts[option.who]}>
              {option.label}
            </Pill>
          ))}
          <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />
          <Pill to={reachOutHref({ kind, who, due: !due })} active={due} count={dueCount}>
            <CalendarClock size={12} />
            Follow-ups due
          </Pill>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 w-10 text-xs text-faint">Why</span>
          <Pill to={reachOutHref({ who, due })} active={kind == null} count={forWho}>
            Any
          </Pill>
          {SIGNAL_KINDS.map((entry) => (
            <Pill key={entry.kind} to={reachOutHref({ kind: entry.kind, who, due })} active={kind === entry.kind} count={counts[entry.kind] ?? 0}>
              {entry.label}
            </Pill>
          ))}
        </div>
      </nav>

      {rows.length === 0 ? (
        <div className="mt-5">
          <EmptyState title={total === 0 ? "Nobody needs a word right now" : "None match"}>
            {due && rows.length === 0 && total > 0
              ? "No next steps are due. Set one on a workspace's Sales section and it shows up here on its day."
              : total === 0
              ? "Workspaces show up here when they stop, come close to their limit, are declined, grow, or pay for the first time."
              : who === "mine"
                ? "No signals for workspaces you own. Take one from Unassigned by setting yourself as its owner on its Sales section."
                : "Try another filter."}
          </EmptyState>
        </div>
      ) : (
        <>
          {/* Phones: one card per signal. */}
          <ul className="mt-5 space-y-2 md:hidden">
            {rows.map((row, index) => (
              <li key={`${row.signal.workspace}-${row.signal.kind}-${index}`}>
                <Link to={rowHref(row.signal)} className="block rounded-lg border border-line bg-surface p-4 transition-colors hover:border-line-strong">
                  <div className="flex items-start justify-between gap-3">
                    <WorkspaceCell row={row} />
                    <ChevronRight size={16} className="mt-0.5 shrink-0 text-faint" />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <SignalBadge kind={row.signal.kind} />
                    <span className="tabular text-sm text-fg-soft">{usd(row.signal.valueMicros)}</span>
                  </div>
                  <p className="mt-1.5 text-sm text-muted">{row.signal.detail}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs">
                    <StageBadge stage={row.signal.stage} />
                    <StaffName email={row.signal.owner} me={me} />
                  </div>
                  <NextStep signal={row.signal} on={on} />
                </Link>
              </li>
            ))}
          </ul>

          {/* Wider screens: a table. */}
          <div className="mt-5 hidden overflow-x-auto rounded-lg border border-line md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface text-left text-xs text-muted">
                  <th className="px-4 py-2.5 font-medium">Workspace</th>
                  <th className="px-4 py-2.5 font-medium">Why</th>
                  <th className="px-4 py-2.5 text-right font-medium">Figure</th>
                  <th className="px-4 py-2.5 font-medium">Stage · next step</th>
                  <th className="px-4 py-2.5 font-medium">Owner at g1t</th>
                  <th className="w-8 px-2 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={`${row.signal.workspace}-${row.signal.kind}-${index}`} className="border-b border-line align-top last:border-0 hover:bg-surface/60">
                    <td className="max-w-64 px-4 py-3">
                      <Link to={rowHref(row.signal)} className="group block">
                        <WorkspaceCell row={row} />
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <SignalBadge kind={row.signal.kind} />
                      <p className="mt-1 max-w-md text-sm text-muted">{row.signal.detail}</p>
                    </td>
                    <td className="tabular px-4 py-3 text-right whitespace-nowrap text-fg-soft">{usd(row.signal.valueMicros)}</td>
                    <td className="max-w-56 px-4 py-3">
                      <StageBadge stage={row.signal.stage} />
                      <NextStep signal={row.signal} on={on} />
                    </td>
                    <td className="max-w-48 px-4 py-3 text-xs">
                      <StaffName email={row.signal.owner} me={me} />
                    </td>
                    <td className="px-2 py-3">
                      <Link to={rowHref(row.signal)} aria-label={`Open ${row.signal.workspace}'s sales`} className="block text-faint hover:text-fg">
                        <ChevronRight size={16} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}

function WorkspaceCell({ row }: { row: Row }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <span className="mt-0.5">
        <Avatar name={row.signal.workspace} size={22} />
      </span>
      <div className="min-w-0">
        <p className="truncate font-medium group-hover:underline group-hover:underline-offset-4">{row.name ?? row.signal.workspace}</p>
        <p className="truncate font-mono text-xs text-faint">{row.signal.workspace}</p>
        {row.owners.length > 0 && (
          <div className="mt-1.5 text-xs">
            <Owners owners={row.owners} compact />
          </div>
        )}
      </div>
    </div>
  );
}

/** The workspace's next step, and its day: amber when it is due. */
function NextStep({ signal, on }: { signal: Signal; on: string }) {
  if (!signal.nextStep && !signal.nextAt) return null;
  const due = isFollowUpDue(signal, on);
  return (
    <p className={`mt-1.5 flex items-start gap-1.5 text-xs ${due ? "text-warn" : "text-muted"}`}>
      <CalendarClock size={12} className="mt-0.5 shrink-0" />
      <span className="min-w-0">
        {signal.nextStep ?? "Next step"}
        {signal.nextAt && (
          <span className={due ? "text-warn" : "text-faint"}>
            {" · "}
            {due ? (signal.nextAt.slice(0, 10) < on ? "overdue since " : "due ") : "on "}
            <When at={`${signal.nextAt.slice(0, 10)}T00:00:00Z`} />
          </span>
        )}
      </span>
    </p>
  );
}