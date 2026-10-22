import { Link, data, useNavigation } from "react-router";

import type { Harness, PersonSpend, Spend } from "@g1t/contracts";

import type { Route } from "./+types/spend";
import { ButtonLink } from "../../components/ui";
import { Alert } from "../../components/ui/alert";
import { Card } from "../../components/ui/card";
import { Hint } from "../../components/ui/hint";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { cn } from "../../lib/cn";
import { harnessName } from "../../lib/coordination";
import { page } from "../../lib/meta";
import { money } from "../../lib/money";
import { work } from "../../lib/services.server";
import { requireUser, roleIn } from "../../lib/session.server";
import {
  SPEND_DAYS,
  SPEND_VISIBILITY,
  type SpendGroup,
  type SpendKey,
  type SpendSpan,
  landedShare,
  spendBy,
  spendDays,
  spendSpan,
  usdMicros,
} from "../../lib/spend";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Spend · ${params.owner} · g1t` });
}

/**
 * Spend: what one person's harness sessions cost in the workspace over a
 * span of days, and how much of it went into work that landed. Everyone
 * sees their own; someone else's (`?person=`) only as the workspace's
 * setting allows, which Work checks and refuses with why. People are
 * listed by name, never by what they spent.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  const query = new URL(request.url).searchParams;
  const span = spendSpan(query, new Date().toISOString().slice(0, 10));
  const person = query.get("person")?.trim() || null;
  const found = await work.getSpend(slug, viewer, { person: person ?? undefined, since: span.since, until: span.until }).catch(() => null);
  if (!found) return { slug, span, person, spend: null, refused: null, error: "Work didn't answer, so spend can't be shown right now. Try again in a moment." };
  if (!found.ok) {
    // Someone else's spend the viewer may not see: said, with the way back to their own.
    const refused = found.error.code === "forbidden";
    return { slug, span, person, spend: null, refused: refused ? found.error.message : null, error: refused ? null : found.error.message };
  }
  return { slug, span, person, spend: found.value, refused: null, error: null };
}

/** This page's address for `person` (null for the viewer's own) over `span`. */
function spendHref(slug: string, person: string | null, span: Pick<SpendSpan, "days" | "since" | "until">): string {
  const query = new URLSearchParams();
  if (person) query.set("person", person);
  if (span.days == null) {
    query.set("since", span.since);
    query.set("until", span.until);
  } else if (span.days !== 30) query.set("days", String(span.days));
  const search = query.toString();
  return `/${slug}/-/spend${search ? `?${search}` : ""}`;
}

const usd = (amount: number) => money(usdMicros(amount));

const shortDay = (day: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(Date.parse(`${day}T12:00:00Z`));

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Landed and not, in the chart and every bar on the page (app.css --color-series-*). */
const LANDED = "bg-series-1";
const NOT_LANDED = "bg-series-1/30";

export default function SpendPage({ loaderData: d }: Route.ComponentProps) {
  const pending = useNavigation().state !== "idle";
  const spend = d.spend;
  const own = spend ? spend.person.own : !d.person;
  const whose = own ? "Your spend" : `${spend?.person.username ?? d.person}'s spend`;
  return (
    <div className="space-y-6" aria-busy={pending}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 grow">
          <h2 className="text-lg font-semibold tracking-tight">{whose}</h2>
          <p className="text-xs text-muted">
            {shortDay(d.span.since)} – {shortDay(d.span.until)}, inclusive, UTC.
            {!own && (
              <>
                {" "}
                <Link to={spendHref(d.slug, null, d.span)} className="text-fg-soft underline decoration-line-strong underline-offset-2 hover:text-accent">
                  See yours
                </Link>
              </>
            )}
          </p>
        </div>
        <SpanSwitch slug={d.slug} person={own ? null : d.person} span={d.span} />
      </div>
      {d.refused != null ? (
        <Card className="p-6">
          <h3 className="font-medium">You can&apos;t see {d.person}&apos;s spend</h3>
          <p className="mt-2 text-sm text-muted">{d.refused} Everyone always sees their own.</p>
          <ButtonLink to={spendHref(d.slug, null, d.span)} variant="link" size="inline" className="mt-4">
            See your spend
          </ButtonLink>
        </Card>
      ) : !spend ? (
        <Alert tone="warn" role="status">
          {d.error}
        </Alert>
      ) : (
        <SpendBody slug={d.slug} spend={spend} span={d.span} />
      )}
    </div>
  );
}

/** 7, 30 or 90 days: links, so the span is in the address and works without script. */
function SpanSwitch({ slug, person, span }: { slug: string; person: string | null; span: SpendSpan }) {
  return (
    <nav aria-label="Span" className="flex shrink-0 self-start rounded-lg border border-line bg-surface p-0.5">
      {SPEND_DAYS.map((days) => {
        const current = span.days === days;
        return (
          <Link
            key={days}
            to={spendHref(slug, person, { days, since: "", until: "" })}
            preventScrollReset
            aria-current={current ? "true" : undefined}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors",
              current ? "bg-raised text-fg shadow-[0_0_0_1px_var(--color-line-strong)]" : "text-muted hover:text-fg",
            )}
          >
            {days} days
          </Link>
        );
      })}
    </nav>
  );
}

function Stat({ label, value, note, className }: { label: string; value: string; note?: string | null; className?: string }) {
  return (
    <Card className={cn("p-4", className)}>
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
      {note && <p className="mt-1 text-xs text-muted">{note}</p>}
    </Card>
  );
}

function SpendBody({ slug, spend, span }: { slug: string; spend: Spend; span: SpendSpan }) {
  const share = landedShare(spend.costUsd, spend.landedUsd);
  const empty = spend.sessions === 0;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="What it cost" value={usd(spend.costUsd)} />
        <Stat label="Into work that landed" value={usd(spend.landedUsd)} note={share == null ? null : `${share}% of it`} />
        <Stat
          className="col-span-2 sm:col-span-1"
          label="Sessions"
          value={spend.sessions.toLocaleString("en-US")}
          note={spend.unknownSessions ? `${spend.unknownSessions.toLocaleString("en-US")} with no known cost` : null}
        />
      </div>
      {spend.unknownSessions > 0 && (
        <p className="text-xs leading-relaxed text-muted">
          {plural(spend.unknownSessions, "session")} reported no usage, so {spend.unknownSessions === 1 ? "its" : "their"} cost isn&apos;t known and isn&apos;t
          counted: an older g1t plugin, or a harness that doesn&apos;t report usage.
        </p>
      )}
      {empty ? (
        <Card className="p-8 text-center">
          <h3 className="font-medium">No sessions in these days</h3>
          <p className="mt-2 text-sm text-muted">
            {spend.person.own ? "What your" : `What ${spend.person.username}'s`} agent sessions cost shows here once they run with the g1t plugin.
          </p>
        </Card>
      ) : (
        <>
          <DayChart spend={spend} />
          <div className="grid gap-6 lg:grid-cols-2">
            <Breakdown
              title="By work item"
              groups={spendBy(spend.rows, "item")}
              name={(key) => (key == null ? "No work item" : `#${key}`)}
              href={(key) => (key == null ? null : `/${slug}/-/work/${key}`)}
            />
            <Breakdown
              title="By repository"
              groups={spendBy(spend.rows, "repo")}
              name={(key) => (key == null ? "Elsewhere" : String(key))}
              href={(key) => (key == null ? null : `/${key}`)}
              none="Elsewhere is repositories you can't read."
            />
            <Breakdown title="By harness" groups={spendBy(spend.rows, "harness")} name={(key) => harnessName(String(key) as Harness) ?? String(key)} />
            <Breakdown title="By model" groups={spendBy(spend.rows, "model")} name={(key) => (key == null ? "Not reported" : String(key))} />
          </div>
        </>
      )}
      {(spend.canSeePeople || spend.workspaceUsd != null) && <People slug={slug} spend={spend} span={span} />}
      <p className="text-xs leading-relaxed text-muted">
        Figures are estimates at list price, from the tokens each session reported; subagents count with their session. A session&apos;s cost goes to its pull
        request, else to the work item it claimed, landed or said it works on, split evenly when there are several. It landed when its pull request merged, or a
        push whose commit names the session landed its work item.
      </p>
    </>
  );
}

/** Each day's cost as a bar, what went into work that landed at its foot; the values are in a table under it. */
function DayChart({ spend }: { spend: Spend }) {
  const days = spendDays(spend.since, spend.until, spend.rows);
  const peak = Math.max(...days.map((day) => day.costUsd), 0) || 1;
  return (
    <section>
      <h3 className="mb-3 font-medium">By day</h3>
      <Card className="p-4">
        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          <span className="flex items-center gap-1.5">
            <span className={cn("size-2.5 rounded-[3px]", LANDED)} aria-hidden />
            Landed
          </span>
          <span className="flex items-center gap-1.5">
            <span className={cn("size-2.5 rounded-[3px]", NOT_LANDED)} aria-hidden />
            Not landed
          </span>
          <span className="ml-auto tabular-nums">Top {usd(peak)}</span>
        </div>
        <div
          className={cn("flex h-36 items-end", days.length > 45 ? "gap-px" : "gap-0.5")}
          role="img"
          aria-label={`${usd(spend.costUsd)} from ${spend.since} through ${spend.until}, ${usd(spend.landedUsd)} of it landed. Daily values are in the table below.`}
        >
          {days.map((day) => (
            <Hint key={day.day} label={`${shortDay(day.day)}: ${usd(day.costUsd)}, ${usd(day.landedUsd)} landed`}>
              <div className="flex h-full min-w-0 flex-1 items-end">
                <div
                  className="flex w-full flex-col-reverse overflow-hidden rounded-t-sm"
                  style={{ height: `${day.costUsd ? Math.max(2, (day.costUsd / peak) * 100) : 0}%` }}
                >
                  <div className={LANDED} style={{ flexGrow: day.landedUsd }} />
                  <div className={NOT_LANDED} style={{ flexGrow: day.costUsd - day.landedUsd }} />
                </div>
              </div>
            </Hint>
          ))}
        </div>
        <div className="mt-2 flex justify-between text-xs text-muted">
          <span>{shortDay(spend.since)}</span>
          <span>{shortDay(spend.until)}</span>
        </div>
        <details className="mt-3 text-xs text-muted">
          <summary className="cursor-pointer">View daily values</summary>
          <Table className="mt-2 text-xs">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">UTC day</TableHead>
                <TableHead scope="col">Cost</TableHead>
                <TableHead scope="col">Landed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {days
                .filter((day) => day.costUsd > 0)
                .map((day) => (
                  <TableRow key={day.day}>
                    <TableHead scope="row" className="font-normal">
                      {day.day}
                    </TableHead>
                    <TableCell className="tabular-nums">{usd(day.costUsd)}</TableCell>
                    <TableCell className="tabular-nums">{usd(day.landedUsd)}</TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </details>
      </Card>
    </section>
  );
}

/** The most rows a breakdown shows before the rest fold away. */
const SHOWN = 8;

/** One way of summing it: each group with what it cost and what of it landed, the costliest first. */
function Breakdown({
  title,
  groups,
  name,
  href,
  none,
}: {
  title: string;
  groups: SpendGroup[];
  name: (key: SpendGroup["key"]) => string;
  href?: (key: SpendGroup["key"]) => string | null;
  /** Said under the list when a group has no name. */
  none?: string;
}) {
  const top = groups[0]?.costUsd || 1;
  const row = (group: SpendGroup) => {
    const to = href?.(group.key) ?? null;
    const label = name(group.key);
    return (
      <li key={String(group.key)} className="px-4 py-3">
        <div className="flex items-baseline gap-3 text-sm">
          {to ? (
            <Link to={to} className="min-w-0 grow truncate text-fg hover:text-accent">
              {label}
            </Link>
          ) : (
            <span className={cn("min-w-0 grow truncate", group.key == null ? "text-muted" : "text-fg")}>{label}</span>
          )}
          <span className="shrink-0 text-fg tabular-nums">{usd(group.costUsd)}</span>
        </div>
        <div className="mt-1.5 flex items-center gap-3">
          <span className="flex h-1.5 grow overflow-hidden rounded-full bg-line/60" aria-hidden>
            <span className={LANDED} style={{ width: `${(group.landedUsd / top) * 100}%` }} />
            <span className={NOT_LANDED} style={{ width: `${((group.costUsd - group.landedUsd) / top) * 100}%` }} />
          </span>
          <span className="w-24 shrink-0 text-right text-xs text-muted tabular-nums">{usd(group.landedUsd)} landed</span>
        </div>
      </li>
    );
  };
  return (
    <section>
      <h3 className="mb-3 font-medium">{title}</h3>
      <Card asChild divided>
        <ul>
          {groups.slice(0, SHOWN).map(row)}
          {groups.length > SHOWN && (
            <li>
              <details>
                <summary className="cursor-pointer px-4 py-2.5 text-xs text-muted hover:text-fg">{plural(groups.length - SHOWN, "more")}</summary>
                <ul className="divide-y divide-line border-t border-line">{groups.slice(SHOWN).map(row)}</ul>
              </details>
            </li>
          )}
        </ul>
      </Card>
      {none && groups.some((group) => group.key == null) && <p className="mt-2 text-xs text-muted">{none}</p>}
    </section>
  );
}

/**
 * Everyone's spend: each person by name (never by what they spent), for
 * whoever the workspace lets see them; else only the total, once it
 * covers enough people that it says nothing about any one of them.
 */
function People({ slug, spend, span }: { slug: string; spend: Spend; span: SpendSpan }) {
  const people = [...spend.people].sort((a, b) => a.username.localeCompare(b.username, "en", { sensitivity: "base" }));
  return (
    <section>
      <h3 className="mb-1 font-medium">People</h3>
      <p className="mb-3 text-xs leading-relaxed text-muted">
        {spend.canSeePeople
          ? `Each person's spend is for budgets and plan fit, not a score: it's listed by name. In this workspace ${SPEND_VISIBILITY[spend.visibility].who} can see it; everyone always sees their own.`
          : "Only the total shows: who sees each person's spend is up to the workspace's owners."}
      </p>
      {spend.workspaceUsd != null && (
        <p className="mb-3 text-sm text-fg-soft">
          Everyone: <span className="font-medium text-fg tabular-nums">{usd(spend.workspaceUsd)}</span> across{" "}
          {plural(spend.workspacePeople, "person", "people")}
        </p>
      )}
      {spend.canSeePeople && people.length > 0 && (
        <Card asChild divided>
          <ul>
            {people.map((person: PersonSpend) => {
              const current = person.username.toLowerCase() === spend.person.username.toLowerCase();
              return (
                <li key={person.id} className="flex items-baseline gap-3 px-4 py-2.5 text-sm">
                  <Link
                    to={spendHref(slug, person.username, span)}
                    aria-current={current ? "page" : undefined}
                    className={cn("min-w-0 grow truncate hover:text-accent", current ? "font-medium text-fg" : "text-fg-soft")}
                  >
                    {person.username}
                  </Link>
                  <span className="shrink-0 text-xs text-muted tabular-nums">{plural(person.sessions, "session")}</span>
                  <span className="w-20 shrink-0 text-right text-fg tabular-nums">{usd(person.costUsd)}</span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </section>
  );
}
