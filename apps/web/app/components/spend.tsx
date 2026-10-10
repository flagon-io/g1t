/**
 * Spend's parts: the tiles at the top, spend by day, where it went, the
 * budgets from the workspace down to a task with what happens at each,
 * the costliest tasks with their receipts, pricing, and the top bar's
 * spend pill. Every figure is one a service returned (lib/spend.server.ts).
 */
import { ArrowRight, Building2, Coins, Cpu, KeyRound, MessagesSquare, Puzzle, ReceiptText, Sparkles, UserRound, Users } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { Link, useFetcher } from "react-router";

import type { AgentPolicy, AgentSession, PersonBudget } from "@g1t/contracts";

import { AgentAvatar } from "./agent-avatar";
import { DollarsInput, useDialogFetcher } from "./agents/dialogs";
import { Meter, PrivateTitle, SliceList, stepsLine } from "./agents/parts";
import { monthName, shortDay } from "./agents/format";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "./ui/field";
import { Hint } from "./ui/hint";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Skeleton } from "./ui/skeleton";
import { ButtonLink, TimeAgo } from "./ui";
import { Card } from "./ui/card";
import { dollarsField } from "../lib/agent-form";
import { cn } from "../lib/cn";
import type { AgentBudgetRow, Budgets, PillData } from "../lib/spend.server";
import { AT_LIMIT, type Pricing, type SpendScope, agentRateLabel, markupLabel, percentLabel, shareOfBudget } from "../lib/spend";
import { money } from "../lib/money";


/** A figure at the top of the page: what it is, the amount, and a line under it. */
export function Tile({ label, value, sub, children }: { label: ReactNode; value: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <Card className="min-w-0 p-4">
      <p className="flex items-center gap-1.5 text-xs text-muted">{label}</p>
      <p className="mt-1.5 truncate text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-faint">{sub}</p>}
      {children}
    </Card>
  );
}

export function TileSkeleton() {
  return (
    <Card className="p-4">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-7 w-28" />
      <Skeleton className="mt-2 h-3 w-36" />
    </Card>
  );
}

/**
 * Spend by day over any span, one bar a day with its amount on hover or
 * focus, and a table for screen readers.
 */
export function SpendBars({ days, className }: { days: { day: string; micros: number }[]; className?: string }) {
  const max = Math.max(0, ...days.map((d) => d.micros));
  return (
    <div className={className}>
      <div className="flex h-28 items-end gap-0.5" aria-hidden="true">
        {days.map((d) => (
          <Hint key={d.day} label={`${shortDay(d.day)} · ${money(d.micros)}`}>
            <span className="flex h-full min-w-0 flex-1 items-end rounded-t-[3px] hover:bg-raised/60">
              <span
                className={cn("block w-full rounded-t-[3px]", d.micros > 0 ? "bg-accent/80" : "bg-line/70")}
                style={{ height: max > 0 && d.micros > 0 ? `${Math.max(4, (d.micros / max) * 100)}%` : "2px" }}
              />
            </span>
          </Hint>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[0.6875rem] text-faint" aria-hidden="true">
        <span>{days[0] ? shortDay(days[0].day) : ""}</span>
        <span>{days.length > 1 ? shortDay(days[days.length - 1]!.day) : ""}</span>
      </div>
      <table className="sr-only">
        <caption>Spend by day</caption>
        <tbody>
          {days.map((d) => (
            <tr key={d.day}>
              <th scope="row">{shortDay(d.day)}</th>
              <td>{money(d.micros)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A section with a heading, an aside, and what it holds. */
export function Section({ id, title, aside, children, className }: { id: string; title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section aria-labelledby={id} className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id={id} className="text-base font-semibold tracking-tight">
          {title}
        </h2>
        {aside && <div className="text-xs text-faint">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

/** The ways to slice spend, as the page's tabs. */
export type SliceKey = "agent" | "person" | "channel" | "model" | "kind" | "product" | "extension";

export const SLICES: { key: SliceKey; label: string; icon: ReactNode; workspaceOnly?: boolean }[] = [
  { key: "agent", label: "Agents", icon: <Sparkles size={13} /> },
  { key: "person", label: "People", icon: <Users size={13} />, workspaceOnly: true },
  { key: "channel", label: "Channels", icon: <MessagesSquare size={13} /> },
  { key: "model", label: "Models", icon: <Cpu size={13} /> },
  { key: "kind", label: "Kind of work", icon: <ReceiptText size={13} /> },
  { key: "product", label: "Products", icon: <Building2 size={13} />, workspaceOnly: true },
  { key: "extension", label: "Extensions", icon: <Puzzle size={13} />, workspaceOnly: true },
];

/** The tabs over the breakdown: each a link, so a slice is an address. */
export function SliceTabs({ current, scope, href }: { current: SliceKey; scope: SpendScope; href: (key: SliceKey) => string }) {
  const shown = SLICES.filter((s) => scope === "workspace" || !s.workspaceOnly);
  return (
    <nav aria-label="Slice spend by" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
      {shown.map((s) => (
        <Link
          key={s.key}
          to={href(s.key)}
          preventScrollReset
          replace
          aria-current={s.key === current ? "page" : undefined}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[0.8125rem] transition-colors",
            s.key === current ? "bg-raised text-fg ring-1 ring-line-strong" : "text-muted hover:bg-raised/60 hover:text-fg",
          )}
        >
          <span className="text-faint">{s.icon}</span>
          {s.label}
          {s.key === "extension" && <span className="ml-0.5 text-[0.625rem] tracking-wide text-faint uppercase">Coming</span>}
        </Link>
      ))}
    </nav>
  );
}

/** Spend in a panel, the slices ranked. */
export function SlicePanel({ children, foot }: { children: ReactNode; foot?: ReactNode }) {
  return (
    <Card className="overflow-hidden">
      {children}
      {foot && <p className="border-t border-line px-4 py-2.5 text-xs text-faint">{foot}</p>}
    </Card>
  );
}

export { SliceList };

/** Something not built yet, said plainly where it will be. */
export function ComingNote({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="px-4 py-8 text-center">
      <p className="flex items-center justify-center gap-2 text-sm font-medium">
        {title}
        <Badge>Coming</Badge>
      </p>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-muted">{children}</p>
    </div>
  );
}

// ── Budgets ──────────────────────────────────────────────────────────────

/** One level of budget: its name, its amount, what is spent against it, and what happens at 100%. */
function Level({
  icon,
  title,
  amount,
  spent,
  budget,
  atLimit,
  action,
  children,
}: {
  icon: ReactNode;
  title: string;
  amount: ReactNode;
  spent?: number | null;
  budget?: number | null;
  atLimit: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  const share = spent != null ? shareOfBudget(spent, budget) : null;
  return (
    <li className="px-4 py-4">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-raised text-muted ring-1 ring-line">{icon}</span>
        <div className="min-w-0 grow basis-56">
          <p className="text-sm font-medium">{title}</p>
          <p className="mt-0.5 text-xs text-muted">
            <span className="font-medium text-fg-soft">At 100%:</span> {atLimit}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3 max-sm:w-full max-sm:justify-between max-sm:pl-10">
          <div className="sm:text-right">
            <p className="text-sm tabular-nums">{amount}</p>
            {spent != null && (
              <p className="text-xs text-faint tabular-nums">
                {money(spent)} spent{share != null ? ` · ${percentLabel(spent, budget)}` : ""}
              </p>
            )}
          </div>
          {action}
        </div>
      </div>
      {share != null && <Meter spent={spent!} cap={budget} label={`${title}: spent of its budget`} size="sm" className="mt-3 ml-10" />}
      {children}
    </li>
  );
}

/**
 * The budgets, widest first: the workspace's spend limit, every agent
 * together, each person, each agent, and each task. Owners change the
 * agent levels here; the spend limit is on Billing, an agent's own on its
 * profile.
 */
export function BudgetLadder({ slug, budgets, owner, me, action, workspaceFigures }: { slug: string; budgets: Budgets; owner: boolean; me: string; action: string; workspaceFigures: boolean }) {
  const { limit, caps, policy, people, agents } = budgets;
  const limitMicros = limit ? (limit.spendLimitMicros ?? limit.ceilingMicros) : null;
  const mine = people?.people.find((p) => p.username === me) ?? null;
  return (
    <Card asChild divided className="overflow-hidden">
      <ol>
        <Level
          icon={<Building2 size={14} />}
          title="The workspace"
          amount={limit ? (limitMicros != null ? `${money(limitMicros)} a month` : "No limit") : <span className="text-faint">Unavailable</span>}
          spent={limit && workspaceFigures ? (limit.spentMicros ?? null) : null}
          budget={limitMicros}
          atLimit={AT_LIMIT.workspace(limit?.pauseAtLimit ?? true)}
          action={
            <ButtonLink to={`/${slug}/-/billing`} variant="outline" size="sm">
              {owner ? "Change" : "Billing"}
            </ButtonLink>
          }
        >
          {limit?.defaultSpendLimit && <p className="mt-2 ml-10 text-xs text-faint">Automatic until owners set one: $200, or twice last month&apos;s spend, whichever is more.</p>}
        </Level>
        <Level
          icon={<Sparkles size={14} />}
          title="All agents together"
          amount={policy ? (policy.monthly_micros != null ? `${money(policy.monthly_micros)} a month` : "No budget of its own") : <span className="text-faint">Unavailable</span>}
          spent={workspaceFigures ? budgets.agentsMonthMicros : null}
          budget={policy?.monthly_micros ?? null}
          atLimit={AT_LIMIT.agents}
          action={owner && policy ? <PolicyDialog policy={policy} action={action} trigger={<Button type="button" variant="outline" size="sm">Change</Button>} /> : null}
        />
        <Level
          icon={<UserRound size={14} />}
          title="Each person"
          amount={policy ? (policy.person_monthly_micros != null ? `${money(policy.person_monthly_micros)} a month each` : "No budget per person") : <span className="text-faint">Unavailable</span>}
          spent={!owner && mine ? mine.spent_micros : null}
          budget={!owner && mine ? mine.monthly_micros : null}
          atLimit={AT_LIMIT.person}
          action={owner && policy ? <PolicyDialog policy={policy} action={action} trigger={<Button type="button" variant="outline" size="sm">Change</Button>} /> : null}
        >
          <p className="mt-2 ml-10 text-xs text-faint">What agents spend on work a person asks for: their chats with agents and the sessions they start.</p>
          {owner && people && <PeopleBudgets people={people.people} defaultMicros={people.default_micros} action={action} />}
        </Level>
        <Level
          icon={<Sparkles size={14} />}
          title="Each agent"
          amount={policy ? (policy.default_agent_monthly_micros != null ? `${money(policy.default_agent_monthly_micros)} a month for a new agent` : "Set on each agent") : <span className="text-faint">Unavailable</span>}
          atLimit={AT_LIMIT.agent}
        >
          {agents && agents.length > 0 && <AgentBudgets slug={slug} agents={agents} />}
        </Level>
        <Level
          icon={<ReceiptText size={14} />}
          title="Each task"
          amount={policy ? `${money(policy.default_session_micros)} a session` : <span className="text-faint">Unavailable</span>}
          atLimit={AT_LIMIT.session}
          action={owner && policy ? <PolicyDialog policy={policy} action={action} trigger={<Button type="button" variant="outline" size="sm">Change</Button>} /> : null}
        >
          <dl className="mt-3 ml-10 grid grid-cols-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
            <Fact label="A session" value={policy ? money(policy.default_session_micros) : "—"} hint="Unless its agent's own per-task cap is lower." />
            <Fact label="One run of the plan" value={caps ? money(caps.runMicros) : "—"} hint="Set under Caps on agents, on Billing." />
            <Fact label="Agents on one issue" value={caps ? money(caps.issueMicros) : "—"} hint="Every run on the issue together." />
          </dl>
        </Level>
      </ol>
    </Card>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <dt className="text-faint">{label}</dt>
      <dd className="mt-0.5 text-sm tabular-nums">{value}</dd>
      <dd className="text-faint">{hint}</dd>
    </div>
  );
}

/** Each agent against its own monthly budget, a link to its profile. */
function AgentBudgets({ slug, agents }: { slug: string; agents: AgentBudgetRow[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? agents : agents.slice(0, 5);
  return (
    <ul className="mt-3 ml-10 space-y-2.5">
      {shown.map((agent) => (
        <li key={agent.id} className="flex items-center gap-2.5 text-sm">
          <AgentAvatar agent={{ handle: agent.handle, avatar_seed: agent.avatar_seed }} size={20} />
          <Link to={`/${slug}/-/agents/${agent.handle}/spend`} className="min-w-0 grow truncate hover:underline">
            {agent.display_name}
          </Link>
          <span className="shrink-0 text-xs text-faint tabular-nums">
            {money(agent.spent_month_micros)}
            {agent.budget.monthly_micros != null ? ` of ${money(agent.budget.monthly_micros)}` : " · no cap"}
          </span>
          <span className="hidden w-24 shrink-0 sm:block">
            {agent.budget.monthly_micros != null && <Meter spent={agent.spent_month_micros} cap={agent.budget.monthly_micros} label={`${agent.display_name}: spent of its budget`} size="sm" />}
          </span>
        </li>
      ))}
      {agents.length > 5 && (
        <li>
          <Button type="button" onClick={() => setAll((v) => !v)} variant="link" size="inline" className="text-xs font-normal">
            {all ? "Show fewer" : `Show all ${agents.length}`}
          </Button>
        </li>
      )}
    </ul>
  );
}

/** Each person who has a budget of their own or spent this month, for owners, with the way to set one. */
function PeopleBudgets({ people, defaultMicros, action }: { people: PersonBudget[]; defaultMicros: number | null; action: string }) {
  return (
    <div className="mt-3 ml-10">
      {people.length > 0 && (
        <ul className="space-y-2.5">
          {people.slice(0, 12).map((person) => (
            <li key={person.username} className="flex items-center gap-2.5 text-sm">
              <span className="min-w-0 grow truncate">
                @{person.username}
                {person.own && <span className="ml-1.5 text-xs text-faint">own budget</span>}
              </span>
              <span className="shrink-0 text-xs text-faint tabular-nums">
                {money(person.spent_micros)}
                {person.monthly_micros != null ? ` of ${money(person.monthly_micros)}` : " · no budget"}
              </span>
              <span className="hidden w-24 shrink-0 sm:block">
                {person.monthly_micros != null && <Meter spent={person.spent_micros} cap={person.monthly_micros} label={`@${person.username}: spent of their budget`} size="sm" />}
              </span>
              <PersonDialog action={action} person={person} defaultMicros={defaultMicros} trigger={<Button type="button" variant="link" size="inline" className="text-xs">Set</Button>} />
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2.5">
        <PersonDialog action={action} person={null} defaultMicros={defaultMicros} trigger={<Button type="button" variant="link" size="inline" className="text-xs">Give someone their own budget</Button>} />
      </div>
    </div>
  );
}

/** The workspace's agent policy: every agent together, each person, a new agent, a session. Owners only. */
function PolicyDialog({ policy, action, trigger }: { policy: AgentPolicy; action: string; trigger: ReactNode }) {
  const { fetcher, open, setOpen, error, busy } = useDialogFetcher("spend-policy");
  const id = useId();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Agent budgets</DialogTitle>
          <DialogDescription>Monthly, reset on the 1st (UTC). The workspace&apos;s spend limit sits above all of them. Leave a budget empty for none.</DialogDescription>
        </DialogHeader>
        <fetcher.Form method="post" action={action} className="grid gap-5">
          <input type="hidden" name="intent" value="policy" />
          <Field>
            <FieldLabel htmlFor={`${id}-monthly`}>All agents together</FieldLabel>
            <DollarsInput id={`${id}-monthly`} name="monthly" defaultValue={dollarsField(policy.monthly_micros)} placeholder="No budget of its own" />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-person`}>Each person</FieldLabel>
            <DollarsInput id={`${id}-person`} name="person" defaultValue={dollarsField(policy.person_monthly_micros)} placeholder="No budget per person" />
            <FieldDescription>What agents may spend on the work one person asks for. Give someone more or less from their row.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-agent`}>A new agent</FieldLabel>
            <DollarsInput id={`${id}-agent`} name="default_agent" defaultValue={dollarsField(policy.default_agent_monthly_micros)} placeholder="None" />
            <FieldDescription>Filled in when an agent is hired; change each one on its profile.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-session`}>A session</FieldLabel>
            <DollarsInput id={`${id}-session`} name="default_session" defaultValue={dollarsField(policy.default_session_micros)} required />
            <FieldDescription>Between $0.10 and $500. A session stops here and asks before spending more.</FieldDescription>
          </Field>
          <FieldError>{error}</FieldError>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={busy}>
              {busy ? "Saving…" : "Save budgets"}
            </Button>
          </DialogFooter>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

/** One person's own budget: an amount, none at all, or back to the default. Owners only. */
function PersonDialog({ action, person, defaultMicros, trigger }: { action: string; person: PersonBudget | null; defaultMicros: number | null; trigger: ReactNode }) {
  const { fetcher, open, setOpen, error, busy } = useDialogFetcher(`spend-person-${person?.username ?? "new"}`);
  const id = useId();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{person ? `@${person.username}'s budget` : "A person's own budget"}</DialogTitle>
          <DialogDescription>
            What agents may spend on work this person asks for each month, in place of the default
            {defaultMicros != null ? ` of ${money(defaultMicros)}` : " (none now)"}. 0 means no budget at all.
          </DialogDescription>
        </DialogHeader>
        <fetcher.Form method="post" action={action} className="grid gap-5">
          <input type="hidden" name="intent" value="person" />
          {person ? (
            <input type="hidden" name="username" value={person.username} />
          ) : (
            <Field>
              <FieldLabel htmlFor={`${id}-username`}>Username</FieldLabel>
              <Input id={`${id}-username`} name="username" required autoComplete="off" placeholder="ana" />
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor={`${id}-amount`}>Monthly budget</FieldLabel>
            <DollarsInput id={`${id}-amount`} name="amount" defaultValue={person?.own ? dollarsField(person.monthly_micros ?? 0) : ""} placeholder="The default" />
            <FieldDescription>Empty puts them back on the default.</FieldDescription>
          </Field>
          <FieldError>{error}</FieldError>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

// ── Receipts ─────────────────────────────────────────────────────────────

/** Where a task's receipt is. */
export function receiptHref(slug: string, session: Pick<AgentSession, "id">): string {
  return `/${slug}/-/spend/receipts/${session.id}`;
}

/** The costliest tasks, each a link to its receipt. */
export function TaskList({ slug, sessions }: { slug: string; sessions: AgentSession[] }) {
  if (sessions.length === 0) return <p className="px-4 py-6 text-center text-sm text-faint">No tasks in this period.</p>;
  return (
    <ul className="divide-y divide-line/60">
      {sessions.map((session) => (
        <li key={session.id} className="group relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-raised/40">
          <AgentAvatar agent={{ handle: session.agent_handle, avatar_seed: session.agent_avatar_seed }} size={24} />
          <div className="min-w-0 grow">
            <Link to={receiptHref(slug, session)} className="block min-w-0 truncate text-sm font-medium after:absolute after:inset-0 hover:underline">
              {session.visible ? session.title || "Untitled session" : <PrivateTitle />}
            </Link>
            <p className="mt-0.5 truncate text-xs text-faint">
              {session.agent_name}
              {session.visible && session.asked_by_username ? ` · for @${session.asked_by_username}` : ""} · {stepsLine(session)} · <TimeAgo at={session.created_at} />
            </p>
          </div>
          <span className="shrink-0 text-sm tabular-nums">{money(session.charged_micros)}</span>
          <ArrowRight size={14} className="shrink-0 text-faint group-hover:text-muted" aria-hidden="true" />
        </li>
      ))}
    </ul>
  );
}

// ── Pricing ──────────────────────────────────────────────────────────────

/** How g1t prices what it runs, from the price book. */
export function PricingCard({ pricing }: { pricing: Pricing | null }) {
  if (!pricing) return <p className="rounded-xl border border-line bg-surface px-4 py-6 text-center text-sm text-muted">Prices couldn&apos;t be read right now.</p>;
  const rows: { icon: ReactNode; title: string; value: string; about: string }[] = [
    {
      icon: <Cpu size={15} />,
      title: "Models",
      value: pricing.modelMarkupPercent > 0 ? `Provider price + ${pricing.modelMarkupPercent}%` : "Provider price",
      about: pricing.modelMarkupPercent > 0 ? "What the model provider charges, with the markup shown." : "What the model provider charges, with no markup.",
    },
    {
      icon: <Sparkles size={15} />,
      title: "Agent rate",
      value: agentRateLabel(pricing, (micros) => money(micros, { precise: true })),
      about: "For what g1t runs around every model call: the model gateway, secrets, routing, context and pass-through to your own provider.",
    },
    {
      icon: <Coins size={15} />,
      title: "Everything else g1t runs",
      value: pricing.markup ? `At cost + ${markupLabel(pricing.markup)}` : "At cost",
      about: "Sandboxes, builds, hosting, storage, search and security scans, at what they cost g1t.",
    },
    {
      icon: <KeyRound size={15} />,
      title: "Your own model keys",
      value: "Agent rate only",
      about: "Your provider bills the model; g1t charges the agent rate for passing it through. Local models the same.",
    },
    { icon: <Building2 size={15} />, title: "Your own runners", value: "$0", about: "Time on your own hardware is never charged." },
    { icon: <Users size={15} />, title: "People", value: "No seats", about: "Invite everyone; people chatting costs nothing. Effort and weekly suggestions help agents spend less." },
  ];
  return (
    <Card asChild tone="plain" className="grid gap-px overflow-hidden bg-line sm:grid-cols-2 lg:grid-cols-3">
      <ul>
        {rows.map((row) => (
          <li key={row.title} className="bg-surface p-4">
            <p className="flex items-center gap-2 text-xs text-muted">
              <span className="text-faint">{row.icon}</span>
              {row.title}
            </p>
            <p className="mt-1 text-sm font-medium">{row.value}</p>
            <p className="mt-0.5 text-xs text-faint">{row.about}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ── The top bar's pill ───────────────────────────────────────────────────

const SCOPE_KEY = "g1t_spend_pill";

function storedScope(): SpendScope {
  try {
    return window.localStorage.getItem(SCOPE_KEY) === "workspace" ? "workspace" : "me";
  } catch {
    return "me";
  }
}

/**
 * Your spend this month in the top bar: what agents did for you, at price,
 * against your budget, or, for owners and billing managers who switch it,
 * everything the workspace used at price, with what it was charged against
 * its spend limit underneath. Both tabs count the same way, at price, so
 * the numbers add up across them. A click opens where it went. Read after
 * the page draws, so it adds nothing to the page's time.
 */
export function SpendPill({ slug, mayWorkspace }: { slug: string; mayWorkspace: boolean }) {
  const pill = useFetcher<PillData>({ key: `spend-pill:${slug}` });
  const [scope, setScope] = useState<SpendScope>("me");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setScope(mayWorkspace ? storedScope() : "me");
    pill.load(`/${slug}/-/spend/pill`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, mayWorkspace]);
  useEffect(() => {
    if (open) pill.load(`/${slug}/-/spend/pill`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const choose = (next: SpendScope) => {
    setScope(next);
    try {
      window.localStorage.setItem(SCOPE_KEY, next);
    } catch {
      // Kept for this page only.
    }
  };
  const data = pill.data;
  const ws = scope === "workspace" ? data?.workspace : null;
  const spent = ws ? ws.spentMicros : (data?.me?.spentMicros ?? null);
  // The limit governs what is charged, so the meter measures that.
  const against = ws ? ws.chargedMicros : (data?.me?.spentMicros ?? null);
  const budget = ws ? ws.limitMicros : (data?.me?.budgetMicros ?? null);
  const share = against != null ? shareOfBudget(against, budget) : null;
  const label = spent == null ? (data ? "Spend" : "") : money(spent);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={spent == null ? "Spend this month" : `${ws ? "The workspace's" : "Your"} spend this month: ${money(spent)}${budget != null ? ` of ${money(budget)}` : ""}`}
          className="gap-2 text-fg-soft tabular-nums"
        >
        {ws ? <Building2 size={14} className="shrink-0 text-faint" /> : <Coins size={14} className="shrink-0 text-faint" />}
        {data ? <span>{label}</span> : <Skeleton className="h-3 w-10" />}
        {share != null && (
          <span className="hidden w-9 lg:block">
            <Meter spent={against!} cap={budget} label={ws ? "Charged of the spend limit" : "Spent of your budget"} size="sm" />
          </span>
        )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <SpendPopover slug={slug} data={data ?? null} scope={scope} mayWorkspace={mayWorkspace} onScope={choose} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

function SpendPopover({
  slug,
  data,
  scope,
  mayWorkspace,
  onScope,
  onClose,
}: {
  slug: string;
  data: PillData | null;
  scope: SpendScope;
  mayWorkspace: boolean;
  onScope: (scope: SpendScope) => void;
  onClose: () => void;
}) {
  const month = data ? monthName(data.month).split(" ")[0] : "";
  const ws = scope === "workspace" ? data?.workspace : null;
  return (
    <div>
      <div className="flex items-center gap-1 border-b border-line p-1.5">
        {(["me", "workspace"] as const).map((key) =>
          key === "workspace" && !mayWorkspace ? (
            <Hint key={key} label="The workspace's spend is for owners and billing managers.">
              <span tabIndex={0} className="flex h-7 grow cursor-default items-center justify-center rounded-md text-xs text-faint">
                Workspace
              </span>
            </Hint>
          ) : (
            <button
              key={key}
              type="button"
              aria-pressed={scope === key}
              onClick={() => onScope(key)}
              className={cn("h-7 grow rounded-md text-xs transition-colors", scope === key ? "bg-surface text-fg ring-1 ring-line-strong" : "text-muted hover:text-fg")}
            >
              {key === "me" ? "You" : "Workspace"}
            </button>
          ),
        )}
      </div>
      {!data ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-3 w-full" />
        </div>
      ) : ws ? (
        <div className="p-4">
          <p className="text-xs text-muted">The workspace · {month}, everything it used, at price</p>
          <p className="mt-1 text-xl font-semibold tabular-nums">{ws.spentMicros != null ? money(ws.spentMicros) : "—"}</p>
          {ws.chargedMicros != null && (
            <p className="mt-1 text-xs text-muted">
              Charged after its plan and credit: <span className="text-fg tabular-nums">{money(ws.chargedMicros)}</span>
              {ws.limitMicros != null ? ` of a ${money(ws.limitMicros)} spend limit` : " · no spend limit set"}
            </p>
          )}
          {ws.chargedMicros != null && ws.limitMicros != null && <Meter spent={ws.chargedMicros} cap={ws.limitMicros} label="Charged of the spend limit" size="sm" className="mt-2" />}
          <p className="mt-3 text-xs text-muted">Of that, agents{ws.agentsMicros != null ? `: ${money(ws.agentsMicros)}` : ""}</p>
          <PopoverSlices slices={ws.byAgent} />
        </div>
      ) : data.me ? (
        <div className="p-4">
          <p className="text-xs text-muted">You · {month}, what agents did for you, at price</p>
          <p className="mt-1 text-xl font-semibold tabular-nums">
            {money(data.me.spentMicros)}
            {data.me.budgetMicros != null && <span className="ml-1.5 text-sm font-normal text-muted">of {money(data.me.budgetMicros)}</span>}
          </p>
          {data.me.budgetMicros != null ? (
            <Meter spent={data.me.spentMicros} cap={data.me.budgetMicros} label="Spent of your budget" size="sm" className="mt-2" />
          ) : (
            <p className="mt-0.5 text-xs text-faint">No budget of your own; the workspace&apos;s limits apply.</p>
          )}
          <PopoverSlices slices={data.me.byKind} />
          {data.me.byAgent.length > 0 && (
            <p className="mt-2 truncate text-xs text-faint">
              {data.me.byAgent
                .slice(0, 3)
                .map((s) => `${s.label.replace(/ \(@[^)]+\)$/, "")} ${money(s.micros)}`)
                .join(" · ")}
            </p>
          )}
        </div>
      ) : (
        <p className="p-4 text-sm text-muted">Your spend couldn&apos;t be read right now.</p>
      )}
      <div className="border-t border-line p-1.5">
        <Link
          to={`/${slug}/-/spend${scope === "workspace" ? "" : "?scope=me"}`}
          onClick={onClose}
          className="flex h-8 items-center justify-between rounded-md px-2.5 text-sm text-fg/90 hover:bg-surface hover:text-fg"
        >
          {scope === "workspace" ? "Open workspace spend" : "Your spend and budget"}
          <ArrowRight size={14} className="text-faint" />
        </Link>
      </div>
    </div>
  );
}

function PopoverSlices({ slices }: { slices: { key: string; label: string; micros: number }[] }) {
  const shown = slices.filter((s) => s.micros > 0).slice(0, 4);
  if (shown.length === 0) return <p className="mt-2 text-xs text-faint">Nothing spent yet this month.</p>;
  return (
    <ul className="mt-2 space-y-1">
      {shown.map((s) => (
        <li key={s.key || "none"} className="flex items-center justify-between gap-3 text-sm">
          <span className="min-w-0 truncate text-fg-soft">{s.label}</span>
          <span className="shrink-0 tabular-nums">{money(s.micros)}</span>
        </li>
      ))}
    </ul>
  );
}
