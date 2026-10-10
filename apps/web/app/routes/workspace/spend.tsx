import { ArrowRight } from "lucide-react";
import { type ReactNode, Suspense } from "react";
import { Await, Link, data } from "react-router";

import type { AgentPolicy, AgentSpendBreakdown, SpendSlice, UsageReport } from "@g1t/contracts";

import type { Route } from "./+types/spend";
import { answer, agentsAction } from "../../components/agents/actions.server";
import { RowsSkeleton } from "../../components/today";
import {
  BudgetLadder,
  ComingNote,
  PricingCard,
  Section,
  SliceList,
  SlicePanel,
  type SliceKey,
  SLICES,
  SliceTabs,
  SpendBars,
  TaskList,
  Tile,
  TileSkeleton,
} from "../../components/spend";
import { Meter } from "../../components/agents/parts";
import { Skeleton } from "../../components/ui/skeleton";
import { microsFromDollars } from "../../lib/agent-form";
import { cn } from "../../lib/cn";
import { page } from "../../lib/meta";
import { workspaceAgents } from "../../lib/services.server";
import { managesBilling, requireUser, roleIn } from "../../lib/session.server";
import { SPEND_PERIODS, type SpendScope, daySeries, periodLabel, readPeriod, readScope, spanFor, usageByDay, withoutSelf } from "../../lib/spend";
import { loadBreakdown, loadBudgets, loadPricing, loadUsage } from "../../lib/spend.server";
import { money } from "../../lib/usage";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Spend · ${params.owner} · g1t` });
}

/**
 * Spend: the front of the workspace's money. What was spent over a
 * period, where it went (by agent, person, channel, model, kind of work and
 * product), the budgets from the workspace down to one task with what
 * happens at each, the costliest tasks with their receipts, and how it is
 * priced. Owners and billing managers see the workspace's, or their own;
 * everyone else sees their own: what agents did for them. Each part
 * streams in from its own service. Definitions: lib/spend.ts.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  const role = roleIn(viewer, slug);
  if (!role) throw data(null, { status: 404 });
  const url = new URL(request.url);
  const mayWorkspace = managesBilling(viewer, slug);
  const scope = readScope(url.searchParams.get("scope"), mayWorkspace);
  const period = readPeriod(url.searchParams.get("period"));
  const by = readSlice(url.searchParams.get("by"), scope);
  const now = new Date();

  const breakdown = loadBreakdown(viewer, slug, scope, period);
  // The budgets are monthly: every agent's month, read once when the page is on it already.
  const month = scope === "workspace" && period === "month" ? breakdown : loadBreakdown(viewer, slug, "workspace", "month");
  const usage = scope === "workspace" ? loadUsage(viewer, slug, period, now) : Promise.resolve(null);
  return {
    slug,
    me: viewer.username.toLowerCase(),
    owner: role === "owner",
    mayWorkspace,
    scope,
    period,
    by,
    span: spanFor(period, now),
    breakdown,
    usage,
    budgets: loadBudgets(viewer, slug, month),
    pricing: loadPricing(),
  };
}

function readSlice(raw: string | null, scope: SpendScope): SliceKey {
  const found = SLICES.find((s) => s.key === raw && (scope === "workspace" || !s.workspaceOnly));
  return found?.key ?? "agent";
}

/** Owners set the agent budgets: every agent together, each person, a new agent, a session; and one person's own. */
export async function action({ params, context, request }: Route.ActionArgs) {
  const { viewer, slug, isOwner, form } = await agentsAction(request, context, params.owner);
  if (!isOwner) return { ok: false as const, error: "Only the workspace's owners set budgets." };
  const intent = form.get("intent");
  if (intent === "policy") {
    const monthly = microsFromDollars(form.get("monthly"));
    const person = microsFromDollars(form.get("person"));
    const agent = microsFromDollars(form.get("default_agent"));
    const session = microsFromDollars(form.get("default_session"));
    if ([monthly, person, agent, session].some((v) => v != null && Number.isNaN(v))) return { ok: false as const, intent, error: "Write each amount in dollars, such as 250 or 2.50." };
    const changes: Partial<AgentPolicy> = { monthly_micros: monthly, person_monthly_micros: person, default_agent_monthly_micros: agent };
    if (session != null) changes.default_session_micros = session;
    return answer("policy", workspaceAgents.setPolicy(slug, viewer, changes));
  }
  if (intent === "person") {
    const username = String(form.get("username") ?? "").trim();
    const amount = microsFromDollars(form.get("amount"));
    if (amount != null && Number.isNaN(amount)) return { ok: false as const, intent, error: "Write the amount in dollars, such as 50, or 0 for no budget." };
    return answer("person", workspaceAgents.setPersonBudget(slug, viewer, username, amount));
  }
  return { ok: false as const, error: "Unknown request." };
}

/** The page's address with some of its query changed. */
function hrefFor(slug: string, q: { scope: SpendScope; period: string; by: SliceKey }, change: Partial<{ scope: SpendScope; period: string; by: SliceKey }>): string {
  const next = { ...q, ...change };
  const params = new URLSearchParams();
  if (next.scope === "me") params.set("scope", "me");
  if (next.period !== "month") params.set("period", next.period);
  if (next.by !== "agent") params.set("by", next.by);
  const query = params.toString();
  return `/${slug}/-/spend${query ? `?${query}` : ""}`;
}

export default function SpendPage({ loaderData }: Route.ComponentProps) {
  const { slug, me, owner, mayWorkspace, scope, period, by, span, breakdown, usage, budgets, pricing } = loaderData;
  const q = { scope, period, by };
  const href = (change: Partial<typeof q>) => hrefFor(slug, q, change);
  const label = periodLabel(period).toLowerCase();
  return (
    <div className="mx-auto w-full max-w-[1040px] space-y-8 px-4 py-5 md:px-10 md:py-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight">Spend</h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">
            {scope === "workspace"
              ? "What the workspace spent, where it went, and the budgets that hold it, from the workspace down to one task."
              : "What agents spent working for you: your chats with them and the sessions you started, against your budget."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {mayWorkspace && (
            <div role="group" aria-label="Whose spend" className="inline-flex rounded-lg border border-line bg-surface p-0.5">
              {(["workspace", "me"] as const).map((key) => (
                <Link
                  key={key}
                  to={href({ scope: key, by: "agent" })}
                  aria-current={scope === key ? "page" : undefined}
                  className={cn("inline-flex h-7 items-center rounded-md px-3 text-[0.8125rem] transition-colors", scope === key ? "bg-raised text-fg ring-1 ring-line-strong" : "text-muted hover:text-fg")}
                >
                  {key === "workspace" ? "Workspace" : "You"}
                </Link>
              ))}
            </div>
          )}
          <nav aria-label="Period" className="inline-flex rounded-lg border border-line bg-surface p-0.5">
            {SPEND_PERIODS.map((p) => (
              <Link
                key={p.key}
                to={href({ period: p.key })}
                preventScrollReset
                aria-current={period === p.key ? "page" : undefined}
                className={cn(
                  "inline-flex h-7 items-center rounded-md px-2.5 text-[0.8125rem] whitespace-nowrap transition-colors",
                  period === p.key ? "bg-raised text-fg ring-1 ring-line-strong" : "text-muted hover:text-fg",
                )}
              >
                {p.short}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      {/* The figures at the top. */}
      <Suspense
        fallback={
          <div className="grid gap-3 sm:grid-cols-3">
            <TileSkeleton />
            <TileSkeleton />
            <TileSkeleton />
          </div>
        }
      >
        <Await resolve={Promise.all([breakdown, usage, budgets])}>
          {([spent, used, levels]) => (
            <div className="grid gap-3 sm:grid-cols-3">
              {scope === "workspace" ? (
                <>
                  <Tile label={`Spent, ${label}`} value={used ? money(used.free ? used.totals.costMicros : used.totals.priceMicros) : "—"} sub={used ? (used.free ? "At cost: g1t charges nothing for now" : "Usage at price, every product") : "Usage couldn't be read"} />
                  <Tile label={`Agents, ${label}`} value={spent ? money(spent.total_micros) : "—"} sub={spent ? `${countOf(spent.by_kind)} replies and sessions` : "The agents service didn't answer"} />
                  <Tile
                    label="Charged, this month"
                    value={levels.limit?.spentMicros != null ? money(levels.limit.spentMicros) : "—"}
                    sub={levels.limit ? limitLine(levels.limit.spentMicros ?? 0, levels.limit.spendLimitMicros ?? levels.limit.ceilingMicros) : "Billing couldn't be read"}
                  >
                    {levels.limit && (levels.limit.spendLimitMicros ?? levels.limit.ceilingMicros) != null && (
                      <Meter spent={levels.limit.spentMicros ?? 0} cap={levels.limit.spendLimitMicros ?? levels.limit.ceilingMicros} label="Charged of the spend limit" size="sm" className="mt-2.5" />
                    )}
                  </Tile>
                </>
              ) : (
                <MyTiles spent={spent} levels={levels} me={me} label={label} />
              )}
            </div>
          )}
        </Await>
      </Suspense>

      {/* Spend by day. */}
      <Section id="by-day" title="By day" aside={`${periodLabel(period)}, UTC`}>
        <div className="rounded-xl border border-line bg-surface px-4 pt-4 pb-3">
          <Suspense fallback={<Skeleton className="h-32 w-full" />}>
            <Await resolve={Promise.all([breakdown, usage])}>
              {([spent, used]) => {
                const days = scope === "workspace" && used ? usageByDay(used.days) : (spent?.days ?? null);
                return days ? <SpendBars days={daySeries(span.from, span.until, days)} /> : <p className="py-8 text-center text-sm text-muted">Spend by day couldn&apos;t be read right now.</p>;
              }}
            </Await>
          </Suspense>
        </div>
      </Section>

      {/* Where it went. */}
      <Section id="where" title="Where it went" aside={scope === "workspace" ? "Agent work by who and where; every product from usage" : "Agent work you asked for"}>
        <SliceTabs current={by} scope={scope} href={(key) => href({ by: key })} />
        <Suspense
          fallback={
            <SlicePanel>
              <RowsSkeleton />
            </SlicePanel>
          }
        >
          <Await resolve={Promise.all([breakdown, usage])}>{([spent, used]) => <Slices by={by} spent={spent} used={used} slug={slug} me={me} scope={scope} />}</Await>
        </Suspense>
      </Section>

      {/* Budgets. */}
      <Section id="budgets" title="Budgets" aside="Monthly, UTC. Checked before work starts, widest first">
        <Suspense
          fallback={
            <SlicePanel>
              <RowsSkeleton rows={5} />
            </SlicePanel>
          }
        >
          <Await resolve={budgets}>{(levels) => <BudgetLadder slug={slug} budgets={levels} owner={owner} me={me} action={`/${slug}/-/spend`} workspaceFigures={mayWorkspace} />}</Await>
        </Suspense>
      </Section>

      {/* Receipts. */}
      <Section id="tasks" title="Costliest tasks" aside="Open one for its receipt">
        <SlicePanel>
          <Suspense fallback={<RowsSkeleton />}>
            <Await resolve={breakdown}>{(spent) => (spent ? <TaskList slug={slug} sessions={spent.top_sessions} /> : <p className="px-4 py-6 text-center text-sm text-muted">Tasks couldn&apos;t be read right now.</p>)}</Await>
          </Suspense>
        </SlicePanel>
      </Section>

      {/* Pricing. */}
      <Section
        id="pricing"
        title="How it's priced"
        aside={
          <Link to={`/${slug}/-/usage`} className="inline-flex items-center gap-1 hover:text-fg">
            Every meter on Usage <ArrowRight size={11} />
          </Link>
        }
      >
        <Suspense fallback={<Skeleton className="h-36 w-full rounded-xl" />}>
          <Await resolve={pricing}>{(value) => <PricingCard pricing={value} />}</Await>
        </Suspense>
      </Section>

      <p className="text-xs text-faint">
        Agent figures count every reply and session at list price, as budgets do. What the workspace is charged, after included usage, credit and any
        discount, is on{" "}
        <Link to={`/${slug}/-/billing`} className="hover:text-fg hover:underline">
          Billing
        </Link>
        .
      </p>
    </div>
  );
}

function countOf(slices: SpendSlice[]): string {
  return slices.reduce((n, s) => n + s.count, 0).toLocaleString("en-US");
}

function limitLine(spent: number, limit: number | null): string {
  if (limit == null) return "No spend limit set";
  return `Of a ${money(limit)} spend limit · ${Math.round((spent / Math.max(1, limit)) * 100)}%`;
}

/** Your own figures: what agents spent for you, and your budget. */
function MyTiles({ spent, levels, me, label }: { spent: AgentSpendBreakdown | null; levels: Awaited<Route.ComponentProps["loaderData"]["budgets"]>; me: string; label: string }) {
  const people = levels.people;
  const mine = people?.people.find((p) => p.username === me) ?? null;
  const budget = mine ? mine.monthly_micros : (people?.default_micros ?? null);
  const month = mine?.spent_micros ?? null;
  const replies = spent?.by_kind.find((s) => s.key === "reply");
  return (
    <>
      <Tile label={`Agents for you, ${label}`} value={spent ? money(spent.total_micros) : "—"} sub={spent ? `${countOf(spent.by_kind)} replies and sessions you asked for` : "The agents service didn't answer"} />
      <Tile label="Your budget, this month" value={budget != null ? money(budget) : "None"} sub={budget != null ? `${month != null ? money(month) : "—"} spent · ${mine?.own ? "set for you" : "the workspace's default"}` : "The workspace's limits apply"}>
        {budget != null && month != null && <Meter spent={month} cap={budget} label="Spent of your budget" size="sm" className="mt-2.5" />}
      </Tile>
      <Tile label={`Your chats with agents, ${label}`} value={replies ? money(replies.micros) : spent ? money(0) : "—"} sub={replies ? `${replies.count.toLocaleString("en-US")} replies` : "Talking costs only what the model answers"} />
    </>
  );
}

/** The breakdown for the slice chosen. */
function Slices({ by, spent, used, slug, me, scope }: { by: SliceKey; spent: AgentSpendBreakdown | null; used: UsageReport | null; slug: string; me: string; scope: SpendScope }) {
  if (by === "extension") {
    return (
      <SlicePanel>
        <ComingNote title="Spend by extension">Once extensions can be installed, what each one runs and what agents do in it will show here, priced like everything else.</ComingNote>
      </SlicePanel>
    );
  }
  if (by === "product") {
    if (!used) return <Unavailable what="Usage" />;
    const slices: SpendSlice[] = used.products.map((p) => ({ key: p.key, label: p.label, micros: p.micros, count: 0 }));
    return (
      <SlicePanel foot="Every product, at price, from Usage. Code and Deployments are built in.">
        <SliceList slices={slices} empty="Nothing used in this period." href={() => `/${slug}/-/usage`} />
      </SlicePanel>
    );
  }
  if (!spent) return <Unavailable what="The agents service" />;
  const pick: Record<Exclude<SliceKey, "extension" | "product">, { slices: SpendSlice[]; unit: string; foot?: ReactNode; link?: (s: SpendSlice) => string | null }> = {
    agent: {
      slices: spent.by_agent,
      unit: "runs",
      foot: "A session's helpers and subagents count on the agent that started it.",
      link: (s) => {
        const handle = /\(@([^)]+)\)$/.exec(s.label)?.[1];
        return handle ? `/${slug}/-/agents/${handle}/spend` : null;
      },
    },
    person: { slices: spent.by_person, unit: "runs", foot: "Who asked. Routines and agent-to-agent work have no asker." },
    channel: { slices: spent.by_channel, unit: "runs", foot: "Where it was asked. Channels you aren't in show only what they cost." },
    model: { slices: spent.by_model, unit: "runs" },
    kind: { slices: spent.by_kind, unit: "" },
  };
  const chosen = pick[by];
  const slices = scope === "me" && by === "person" ? withoutSelf(chosen.slices, me) : chosen.slices;
  return (
    <SlicePanel foot={chosen.foot}>
      <SliceList slices={slices} unit={chosen.unit} empty="Nothing spent in this period." href={chosen.link} />
    </SlicePanel>
  );
}

function Unavailable({ what }: { what: string }) {
  return (
    <SlicePanel>
      <p className="px-4 py-6 text-center text-sm text-muted">{what} didn&apos;t answer. Reload in a moment.</p>
    </SlicePanel>
  );
}

