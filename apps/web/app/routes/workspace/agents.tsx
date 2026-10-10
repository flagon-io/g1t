import { AlertTriangle, CalendarClock, Coins, Hourglass, Wallet } from "lucide-react";
import { Link, data } from "react-router";

import type { AgentPolicy, AgentsOverview, WorkspaceAgent } from "@g1t/contracts";

import type { Route } from "./+types/agents";
import { AgentFace } from "../../components/agents-mode";
import { agentsAction, answer, readOrNull } from "../../components/agents/actions.server";
import { ApproveDialog, BUTTONS, BudgetDialog } from "../../components/agents/dialogs";
import { meterTone, monthName, scheduleInWords, shareOf, untilLabel } from "../../components/agents/format";
import { DailyBars, Meter, Panel, Quiet, SessionCard, SessionRow, SliceList, SpendOfCap } from "../../components/agents/parts";
import { StatusDot, statusLabel } from "../../components/chat/marks";
import { isOrchestrator } from "../../components/orchestrator";
import { Badge } from "../../components/ui/badge";
import { microsFromDollars } from "../../lib/agent-form";
import { page } from "../../lib/meta";
import { useRefreshWhile } from "../../lib/refresh";
import { workspaceAgents } from "../../lib/services.server";
import { requireUser, roleIn } from "../../lib/session.server";
import { money } from "../../lib/usage";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Agents · ${params.owner} · g1t` });
}

/** Agents mode's front page: the budget, what is waiting and working, the roster, and where the month went. */
export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ overview: AgentsOverview | null }> {
  // Signed out, sign in first (as Chat and Docs do), rather than a 404.
  const viewer = requireUser(context, request);
  if (!viewer || !roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  return { overview: await readOrNull(workspaceAgents.overview(params.owner.toLowerCase(), viewer)) };
}

/** Owners set the workspace's agent budget. */
export async function action({ params, context, request }: Route.ActionArgs) {
  const { viewer, slug, form } = await agentsAction(request, context, params.owner);
  if (form.get("intent") !== "policy") return { ok: false as const, error: "Unknown request." };
  const monthly = microsFromDollars(form.get("monthly"));
  const agent = microsFromDollars(form.get("default_agent"));
  const session = microsFromDollars(form.get("default_session"));
  if ([monthly, agent, session].some((v) => v != null && Number.isNaN(v))) return { ok: false as const, error: "Write each amount in dollars, such as 250 or 2.50." };
  const changes: Partial<AgentPolicy> = { monthly_micros: monthly, default_agent_monthly_micros: agent };
  if (session != null) changes.default_session_micros = session;
  return answer("policy", workspaceAgents.setPolicy(slug, viewer, changes));
}

export default function AgentsOverviewPage({ loaderData, params }: Route.ComponentProps) {
  const { overview } = loaderData;
  const slug = params.owner;
  useRefreshWhile(Boolean(overview && (overview.live.length > 0 || overview.waiting_on_you.length > 0)));
  if (!overview) {
    return (
      <Quiet title="Agents can't be shown right now">
        The agents service didn&apos;t answer. It&apos;s usually back within a minute; reload to try again.
      </Quiet>
    );
  }
  const liveCount = Object.values(overview.live_by_agent).reduce((n, c) => n + c, 0);
  const handles = new Map(overview.agents.map((agent) => [agent.id, agent]));
  return (
    <div className="space-y-10">
      <BudgetHeader overview={overview} slug={slug} liveCount={liveCount} />

      {overview.waiting_on_you.length > 0 && (
        <section aria-labelledby="waiting">
          <h2 id="waiting" className="flex items-center gap-2 text-sm font-medium">
            <Hourglass size={15} className="text-warn" />
            Waiting on you
            <span className="text-faint">{overview.waiting_on_you.length}</span>
          </h2>
          <p className="mt-1 text-sm text-muted">Sessions that reached their spend cap. They stay paused until someone who may raise the cap says so.</p>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {overview.waiting_on_you.map((session) => (
              <SessionCard
                key={session.id}
                slug={slug}
                session={session}
                action={
                  overview.can_manage ? (
                    <ApproveDialog
                      slug={slug}
                      session={session}
                      trigger={
                        <button type="button" className={`${BUTTONS.PRIMARY} h-8 w-full py-0`}>
                          Approve more…
                        </button>
                      }
                    />
                  ) : (
                    <p className="text-xs text-faint">An owner approves more spend.</p>
                  )
                }
              />
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="working">
        <h2 id="working" className="text-sm font-medium">
          Working now {liveCount > 0 && <span className="text-faint">{liveCount}</span>}
        </h2>
        {overview.live.length === 0 ? (
          <div className="mt-3">
            <Quiet title={liveCount > 0 ? "Working in conversations you're not in" : "No sessions right now"}>
              {liveCount > 0
                ? "Agents are working on sessions started in private channels or direct messages. What they cost still shows below."
                : "When a request needs real work, an agent spins off a session for it, with its own budget and a live card in the conversation."}
            </Quiet>
          </div>
        ) : (
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {overview.live.map((session) => (
              <SessionCard key={session.id} slug={slug} session={session} />
            ))}
          </ul>
        )}
      </section>

      <Roster slug={slug} agents={overview.agents} live={overview.live_by_agent} />

      <SpendSection overview={overview} slug={slug} handles={handles} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Upcoming routines" aside={overview.upcoming.length > 0 ? "UTC" : undefined}>
          {overview.upcoming.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-faint">No routines scheduled. Set one up on an agent&apos;s Routines tab.</p>
          ) : (
            <ul className="divide-y divide-line/60">
              {overview.upcoming.map((routine) => (
                <li key={routine.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <CalendarClock size={15} className="shrink-0 text-faint" />
                  <div className="min-w-0 grow">
                    <Link to={`/${slug}/-/agents/${routine.agent_handle}/routines`} className="block truncate font-medium hover:underline">
                      {routine.name}
                    </Link>
                    <p className="truncate text-xs text-faint">
                      {routine.agent_name}
                      {routine.schedule ? ` · ${scheduleInWords(routine.schedule)}` : ""}
                      {routine.channel_name ? ` · #${routine.channel_name}` : ""}
                    </p>
                  </div>
                  {routine.next_run_at && (
                    <span className="shrink-0 text-xs text-muted tabular-nums" suppressHydrationWarning>
                      {untilLabel(routine.next_run_at)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Recently finished">
          {overview.recent.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-faint">Finished sessions you can see show here, with what they found.</p>
          ) : (
            <ul className="divide-y divide-line/60">
              {overview.recent.map((session) => (
                <SessionRow key={session.id} slug={slug} session={session} showAgent />
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

/** The month's spend by every agent against the workspace's agent budget, with the alert and, for owners, the way to change it. */
function BudgetHeader({ overview, slug, liveCount }: { overview: AgentsOverview; slug: string; liveCount: number }) {
  const { policy, spent_month_micros: spent, alert } = overview;
  const share = shareOf(spent, policy.monthly_micros);
  const tone = meterTone(share);
  return (
    <section className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
      {alert != null && (
        <div
          role="status"
          className={`mb-5 flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${
            alert >= 100 ? "border-danger/40 bg-danger/10 text-danger" : "border-warn/40 bg-warn/10 text-warn"
          }`}
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>
            {alert >= 100
              ? "Agents have used this month's budget. They take no new work until the 1st, or until an owner raises it."
              : `Agents have used ${alert}% of this month's budget.`}{" "}
            {overview.can_manage ? "" : "An owner can raise it."}
          </span>
        </div>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="flex items-center gap-1.5 text-sm text-muted">
            <Wallet size={14} />
            Every agent, {monthName(overview.spend.period)}
          </p>
          <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
            <span className="text-3xl font-semibold tracking-tight tabular-nums">{money(spent)}</span>
            <span className="text-sm text-muted">{policy.monthly_micros != null ? `of ${money(policy.monthly_micros)}` : "No agent budget: the workspace's spend limit applies"}</span>
          </p>
        </div>
        {overview.can_manage && (
          <BudgetDialog
            policy={policy}
            action={`/${slug}/-/agents?index`}
            trigger={
              <button type="button" className={`${BUTTONS.QUIET} h-9 py-0`}>
                <Coins size={15} />
                Budget
              </button>
            }
          />
        )}
      </div>
      {policy.monthly_micros != null && (
        <>
          <Meter spent={spent} cap={policy.monthly_micros} label="Spent of the agents' monthly budget" className="mt-4" />
          <p className="mt-2 text-xs text-faint">
            {Math.round((share ?? 0) * 100)}% used{tone === "accent" ? "" : tone === "warn" ? ", past the first alert" : ", at the limit"}. Every session, routine and helper rolls up here, then into the workspace&apos;s bill.
          </p>
        </>
      )}
      <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-line pt-4 sm:grid-cols-4">
        <Stat label="Working now" value={String(liveCount)} />
        <Stat label="Waiting on approval" value={String(overview.waiting_on_you.length)} />
        <Stat label="Session cap" value={money(policy.default_session_micros)} />
        <Stat label="New agent budget" value={policy.default_agent_monthly_micros != null ? money(policy.default_agent_monthly_micros) : "None"} />
      </dl>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-faint">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium tabular-nums">{value}</dd>
    </div>
  );
}

/** Every agent, g1t first: its status, what it is working on and its month against its own budget. */
function Roster({ slug, agents, live }: { slug: string; agents: WorkspaceAgent[]; live: Record<string, number> }) {
  const sorted = [...agents].sort((a, b) => Number(isOrchestrator(b)) - Number(isOrchestrator(a)));
  return (
    <section aria-labelledby="roster">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="roster" className="text-sm font-medium">
          Agents <span className="text-faint">{agents.length}</span>
        </h2>
        <Link to={`/${slug}/-/marketplace/agents`} className="text-xs text-muted hover:text-fg">
          Add from the agent catalog
        </Link>
      </div>
      <ul className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
        {sorted.map((agent) => {
          const count = live[agent.id] ?? 0;
          const cap = agent.budget.monthly_micros;
          return (
            <li key={agent.id} className="relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-raised/40">
              <span className="relative shrink-0">
                <AgentFace agent={{ ...agent, builtin: isOrchestrator(agent) }} size={32} />
                <StatusDot status={agent.status} className="absolute -right-0.5 -bottom-0.5 ring-2 ring-surface" />
              </span>
              <div className="min-w-0 grow">
                <p className="flex items-center gap-2 text-sm">
                  <Link to={`/${slug}/-/agents/${agent.handle}`} className="truncate font-medium after:absolute after:inset-0 hover:underline">
                    {agent.display_name}
                  </Link>
                  {count > 0 && (
                    <Badge tone="accent">
                      {count} {count === 1 ? "session" : "sessions"}
                    </Badge>
                  )}
                </p>
                <p className="truncate text-xs text-faint">
                  {isOrchestrator(agent) ? "Orchestrator" : agent.title || agent.role}
                  {agent.status !== "idle" && ` · ${statusLabel(agent.status)}`}
                </p>
              </div>
              <div className="w-28 shrink-0 text-right sm:w-40">
                <p className="text-xs">
                  <SpendOfCap spent={agent.spent_month_micros} cap={cap} />
                </p>
                {cap != null && <Meter spent={agent.spent_month_micros} cap={cap} label={`${agent.display_name}'s spend of its monthly budget`} size="sm" className="mt-1.5" />}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Where the month went: by day, by agent, by team, by kind of work and by who asked. */
function SpendSection({ overview, slug, handles }: { overview: AgentsOverview; slug: string; handles: Map<string, WorkspaceAgent> }) {
  const { spend } = overview;
  return (
    <section aria-labelledby="spend" className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="spend" className="text-sm font-medium">
          Spend this month
        </h2>
        <Link to={`/${slug}/-/usage`} className="text-xs text-muted hover:text-fg">
          On the workspace&apos;s usage
        </Link>
      </div>
      <Panel title={<span className="tabular-nums">{money(spend.total_micros)}</span>} aside="By day, UTC">
        <DailyBars period={spend.period} days={spend.days} className="px-4 pt-4 pb-3" />
      </Panel>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="By agent">
          <SliceList
            slices={spend.by_agent}
            unit=""
            icon={(slice) => {
              const agent = handles.get(slice.key);
              return agent ? <AgentFace agent={{ ...agent, builtin: isOrchestrator(agent) }} size={18} /> : null;
            }}
            href={(slice) => {
              const agent = handles.get(slice.key);
              return agent ? `/${slug}/-/agents/${agent.handle}/spend` : null;
            }}
          />
        </Panel>
        <Panel title="By team">
          <SliceList slices={spend.by_team} />
        </Panel>
        <Panel title="By kind of work">
          <SliceList slices={spend.by_kind} unit="runs" />
        </Panel>
        <Panel title="By who asked" aside="Routines and agent-to-agent work have no asker">
          <SliceList slices={spend.by_person} unit="runs" />
        </Panel>
      </div>
      {spend.top_sessions.length > 0 && (
        <Panel title="Costliest sessions">
          <ul className="divide-y divide-line/60">
            {spend.top_sessions.map((session) => (
              <SessionRow key={session.id} slug={slug} session={session} showAgent />
            ))}
          </ul>
        </Panel>
      )}
    </section>
  );
}
