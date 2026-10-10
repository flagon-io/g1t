import { data, useOutletContext } from "react-router";

import type { AgentEffortCosts, AgentRecommendations, AgentSpendBreakdown, WorkspaceAgent } from "@g1t/contracts";

import type { Route } from "./+types/spend";
import { agentsAction, answer, readOrNull } from "../../../components/agents/actions.server";
import { EffortCard, Savings } from "../../../components/effort";
import { readEffort } from "../../../lib/agent-form";
import { effortSetting } from "../../../lib/effort";
import { meterTone, monthName, shareOf } from "../../../components/agents/format";
import { DailyBars, Meter, Panel, Quiet, SessionRow, SliceList } from "../../../components/agents/parts";
import { requireUser, roleIn } from "../../../lib/session.server";
import { workspaceAgents } from "../../../lib/services.server";
import { money } from "../../../lib/usage";

/** Where this agent's month went, what each effort level has cost it, and ways to spend less. */
export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{
  spend: AgentSpendBreakdown | null;
  costs: AgentEffortCosts | null;
  recs: AgentRecommendations | null;
  owner: boolean;
}> {
  const viewer = requireUser(context, request);
  const role = roleIn(viewer, params.owner);
  if (!role) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const handle = params.handle.toLowerCase();
  const [spend, costs, recs] = await Promise.all([
    readOrNull(workspaceAgents.spend(slug, viewer, handle)),
    readOrNull(workspaceAgents.effortCosts(slug, handle, viewer)),
    readOrNull(workspaceAgents.recommendations(slug, viewer, handle)),
  ]);
  return { spend, costs, recs, owner: role === "owner" };
}

/** Owners set the agent's effort, and apply or dismiss a suggestion. */
export async function action({ params, context, request }: Route.ActionArgs) {
  const { viewer, slug, isOwner, form } = await agentsAction(request, context, params.owner);
  const intent = String(form.get("intent") ?? "");
  if (!isOwner) return { ok: false as const, intent, error: "Only the workspace's owners change this." };
  if (intent === "effort") {
    const effort = readEffort(form.get("effort"));
    if (!effort) return { ok: false as const, intent, error: "Pick Auto, Low, Medium, High or Max." };
    return answer(intent, workspaceAgents.update(slug, params.handle.toLowerCase(), viewer, { routing: { effort } }));
  }
  if (intent === "recommendation") {
    const what = form.get("do") === "apply" ? "apply" : "dismiss";
    return answer(intent, workspaceAgents.resolveRecommendation(slug, viewer, String(form.get("id") ?? ""), what));
  }
  return { ok: false as const, intent, error: "Unknown request." };
}

/**
 * Spend this month against the agent's budget: by day, by kind of work, by
 * model, by who asked, and its costliest sessions. A session's helpers and
 * subagents are paid here when this agent started it.
 */
export default function Spend({ loaderData, params }: Route.ComponentProps) {
  const agent = useOutletContext<WorkspaceAgent>();
  const { spend, costs, recs, owner } = loaderData;
  const here = `/${params.owner}/-/agents/${params.handle}/spend`;
  const spent = spend?.total_micros ?? agent.spent_month_micros ?? 0;
  const cap = agent.budget.monthly_micros;
  const share = shareOf(spent, cap);
  const tone = meterTone(share);
  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-line bg-surface p-6">
        <p className="text-sm text-muted">Spent in {monthName(spend?.period ?? new Date().toISOString().slice(0, 7))}</p>
        <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
          <span className="text-3xl font-semibold tracking-tight tabular-nums">{money(spent)}</span>
          <span className="text-sm text-muted">{cap != null ? `of ${money(cap)}` : "No monthly budget of its own: the workspace's agent budget applies"}</span>
        </p>
        {cap != null && (
          <>
            <Meter spent={spent} cap={cap} label="Spent of its monthly budget" className="mt-4" />
            <p className={`mt-2 text-xs ${tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-faint"}`}>
              {Math.round((share ?? 0) * 100)}% used. At 100% it takes no new work until the 1st, or until an owner raises its budget on its profile.
            </p>
          </>
        )}
        <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-line pt-5 sm:grid-cols-4">
          <Stat label="Daily cap" value={agent.budget.daily_micros != null ? money(agent.budget.daily_micros) : "None"} />
          <Stat label="Per session" value={agent.budget.task_micros != null ? money(agent.budget.task_micros) : "Workspace default"} />
          <Stat label="While idle" value="Costs nothing" />
          <Stat label="Rolls up to" value="The workspace's bill" />
        </dl>
      </section>

      <EffortCard value={effortSetting(agent.routing)} costs={costs} owner={owner} action={here} name={agent.display_name} />

      <section aria-labelledby="savings" className="space-y-3">
        <h2 id="savings" className="text-base font-semibold tracking-tight">
          Spend less, keep quality
        </h2>
        <Savings recs={recs} owner={owner} action={here} showAgent={false} />
      </section>

      {!spend ? (
        <Quiet title="The breakdown can't be shown right now">The agents service didn&apos;t answer. Reload in a moment.</Quiet>
      ) : (
        <>
          <Panel title="By day" aside="UTC">
            <DailyBars period={spend.period} days={spend.days} className="px-4 pt-4 pb-3" />
          </Panel>
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="By kind of work">
              <SliceList slices={spend.by_kind} unit="runs" />
            </Panel>
            <Panel title="By model">
              <SliceList slices={spend.by_model} unit="runs" />
            </Panel>
            <Panel title="By who asked" className="lg:col-span-2">
              <SliceList slices={spend.by_person} unit="runs" />
            </Panel>
          </div>
          {spend.top_sessions.length > 0 && (
            <Panel title="Costliest sessions" aside="With everything they brought in">
              <ul className="divide-y divide-line/60">
                {spend.top_sessions.map((session) => (
                  <SessionRow key={session.id} slug={params.owner} session={session} showAgent={session.agent_id !== agent.id} />
                ))}
              </ul>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-faint">{label}</dt>
      <dd className="mt-0.5 text-sm tabular-nums">{value}</dd>
    </div>
  );
}
