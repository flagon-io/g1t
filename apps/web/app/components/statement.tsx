import { ChevronRight, Download } from "lucide-react";
import { useState } from "react";
import { Link, useFetcher, useNavigate } from "react-router";

import { MICROS_PER_DOLLAR, type LedgerEntry, type Statement } from "@g1t/contracts";

import { EmptyState, TimeAgo } from "./ui";
import { SkeletonRows } from "./ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

/** Millionths of a dollar as dollars, to the cent or finer. */
function dollars(micros: number, digits = 2): string {
  const sign = micros < 0 ? "−" : "";
  return `${sign}$${(Math.abs(micros) / MICROS_PER_DOLLAR).toFixed(digits)}`;
}

/** Charges to the cent, but a fraction of a cent shown as such rather than $0.00. */
function charge(micros: number): string {
  return micros !== 0 && Math.abs(micros) < 10_000 ? dollars(micros, 4) : dollars(micros);
}

function monthLabel(month: string): string {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * A month of the workspace's ledger: totals, then a group per day (or per
 * project) with one line per kind of charge. A line opens to its entries,
 * 50 at a time.
 */
export function StatementView({
  slug,
  statement,
  group,
}: {
  slug: string;
  statement: Statement;
  group: "day" | "project";
}) {
  const navigate = useNavigate();
  const go = (month: string, by: string) =>
    navigate(`/${slug}/-/billing?month=${month}&group=${by}#statement`, { preventScrollReset: true });
  const months = statement.months.includes(statement.month) ? statement.months : [statement.month, ...statement.months];
  const { totals } = statement;

  return (
    <section id="statement" className="mt-10 scroll-mt-20">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="grow text-sm font-medium text-muted">Statement</h3>
        <Select value={statement.month} onValueChange={(month) => go(month, group)}>
          <SelectTrigger size="sm" className="w-40" aria-label="Month">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {months.map((month) => (
              <SelectItem key={month} value={month}>
                {monthLabel(month)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Tabs value={group} onValueChange={(by) => go(statement.month, by)}>
          <TabsList>
            <TabsTrigger value="day">By day</TabsTrigger>
            <TabsTrigger value="project">By project</TabsTrigger>
          </TabsList>
        </Tabs>
        {totals.entries > 0 && (
          <a
            href={`/${slug}/-/billing/statement.csv?month=${statement.month}`}
            className="flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-[0.8125rem] text-muted hover:border-line-strong hover:text-fg"
            download
          >
            <Download size={13} /> CSV
          </a>
        )}
      </div>

      <dl className="mt-3 grid grid-cols-3 divide-x divide-line rounded-xl border border-line bg-surface text-sm">
        <div className="px-4 py-3">
          <dt className="text-xs text-faint">Charged</dt>
          <dd className="mt-0.5 font-mono tabular-nums">{charge(totals.chargedMicros)}</dd>
        </div>
        <div className="px-4 py-3">
          <dt className="text-xs text-faint">Paid and credited</dt>
          <dd className="mt-0.5 font-mono tabular-nums">{dollars(totals.paidMicros)}</dd>
        </div>
        <div className="px-4 py-3">
          <dt className="text-xs text-faint">Entries</dt>
          <dd className="mt-0.5 font-mono tabular-nums">{totals.entries.toLocaleString("en-US")}</dd>
        </div>
      </dl>

      {((totals.covered?.length ?? 0) > 0 || (totals.carriedMicros ?? 0) > 0) && (
        <ul className="mt-2 space-y-1 rounded-xl border border-line bg-surface px-4 py-3 text-sm">
          {totals.covered?.map((paid) => (
            <li key={paid.source} className="flex justify-between gap-4">
              <span className="text-muted">{paid.label}</span>
              <span className="font-mono tabular-nums text-accent">{charge(paid.micros)}</span>
            </li>
          ))}
          {(totals.carriedMicros ?? 0) > 0 && (
            <li className="flex justify-between gap-4">
              <span className="text-muted">Under the minimum charge, so carried over to the next invoice</span>
              <span className="font-mono tabular-nums">{charge(totals.carriedMicros ?? 0)}</span>
            </li>
          )}
        </ul>
      )}

      <div className="mt-3">
        {statement.groups.length === 0 ? (
          <EmptyState title={`Nothing in ${monthLabel(statement.month)}`}>
            Agent runs, sandbox time, deployments and payments appear here, a line per kind each day.
          </EmptyState>
        ) : (
          <div className="overflow-hidden rounded-xl border border-line">
            {statement.groups.map((g) => (
              <div key={g.key} className="border-b border-line last:border-b-0">
                <div className="flex items-center gap-4 bg-surface px-4 py-2 text-xs">
                  <span className="grow truncate font-medium text-muted">
                    {group === "day" ? dayLabel(g.key) : g.label}
                  </span>
                  <span className="font-mono tabular-nums text-faint">{charge(g.chargedMicros)}</span>
                </div>
                <ul className="divide-y divide-line">
                  {g.lines.map((line) => (
                    <StatementLineRow
                      key={line.kind}
                      slug={slug}
                      month={statement.month}
                      kind={line.kind}
                      count={line.count}
                      chargedMicros={line.chargedMicros}
                      coveredMicros={line.coveredMicros ?? 0}
                      day={group === "day" ? g.key : null}
                      project={group === "project" ? g.key : null}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function StatementLineRow({
  slug,
  month,
  kind,
  count,
  chargedMicros,
  coveredMicros,
  day,
  project,
}: {
  slug: string;
  month: string;
  kind: string;
  count: number;
  chargedMicros: number;
  coveredMicros: number;
  day: string | null;
  project: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [done, setDone] = useState(false);
  const fetcher = useFetcher<LedgerEntry[] | { error: string }>();
  const [seen, setSeen] = useState<LedgerEntry[] | undefined>(undefined);
  const failed = fetcher.data && !Array.isArray(fetcher.data) ? fetcher.data.error : null;

  // Each page that arrives is added once. A page can come again: the page
  // reloads what fetchers loaded after every change made on it, so an entry
  // already listed is not listed twice.
  if (Array.isArray(fetcher.data) && fetcher.data !== seen) {
    const page = fetcher.data;
    setSeen(page);
    setEntries((before) => {
      const listed = new Set(before.map((entry) => entry.id));
      return [...before, ...page.filter((entry) => !listed.has(entry.id))];
    });
    if (page.length < 50) setDone(true);
  }

  const load = (before: string | null) => {
    const query = new URLSearchParams({ month, kind });
    if (day) query.set("day", day);
    if (project !== null) query.set("project", project);
    if (before) query.set("before", before);
    fetcher.load(`/${slug}/-/billing/entries?${query}`);
  };

  const toggle = () => {
    if (!open && entries.length === 0) load(null);
    setOpen(!open);
  };
  const moneyIn = chargedMicros < 0;

  return (
    <li>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-surface/60"
      >
        <ChevronRight size={14} className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="grow truncate font-medium">{kind}</span>
        <span className="shrink-0 text-xs text-faint tabular-nums">
          {count.toLocaleString("en-US")} {count === 1 ? "entry" : "entries"}
          {coveredMicros > 0 && ` · ${charge(coveredMicros)} paid for`}
        </span>
        <span
          className={`w-24 shrink-0 text-right font-mono tabular-nums ${moneyIn ? "text-accent" : "text-fg"}`}
        >
          {moneyIn ? `+${dollars(-chargedMicros)}` : charge(chargedMicros)}
        </span>
      </button>
      {open && (
        <div className="border-t border-line bg-bg/40 pb-2">
          <ul className="divide-y divide-line/60">
            {entries.map((entry) => (
              <li key={entry.id} className="flex items-center gap-4 py-2 pr-4 pl-11 text-[0.8125rem]">
                <div className="min-w-0 grow">
                  {entry.repo && entry.number ? (
                    <Link to={`/${entry.repo}/pull/${entry.number}`} className="block truncate hover:underline">
                      {entry.description}
                    </Link>
                  ) : (
                    <p className="truncate">{entry.description}</p>
                  )}
                  <p className="mt-0.5 text-xs text-faint">
                    <TimeAgo at={entry.createdAt} />
                    {entry.model && ` · ${entry.model}`}
                    {entry.createdBy && ` · ${entry.createdBy}`}
                  </p>
                </div>
                <span className="shrink-0 font-mono text-xs tabular-nums text-muted">
                  {entry.amountMicros > 0 ? `+${dollars(entry.amountMicros)}` : charge(-entry.amountMicros)}
                </span>
              </li>
            ))}
          </ul>
          {failed && fetcher.state === "idle" && <p className="py-2 pl-11 text-xs text-danger">{failed}</p>}
          {fetcher.state === "loading" && (
            <div aria-busy="true" className="pl-8">
              <SkeletonRows rows={3} rowClassName="h-12" />
            </div>
          )}
          {!done && entries.length > 0 && entries.length < count && fetcher.state === "idle" && (
            <button
              type="button"
              onClick={() => load(entries[entries.length - 1].id)}
              className="mt-1 ml-11 text-xs text-muted hover:text-fg"
            >
              Show {Math.min(50, count - entries.length)} more of {count - entries.length}
            </button>
          )}
        </div>
      )}
    </li>
  );
}
