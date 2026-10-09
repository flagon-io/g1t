import { AlertTriangle, CalendarClock, Lightbulb, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { Link, data, useFetcher, useOutletContext } from "react-router";

import { type AgentRoutine, type NewRoutine, ROUTINE_EVENTS, type RoutineEvent, type RoutineSuggestion, type WorkspaceAgent } from "@g1t/contracts";

import type { Route } from "./+types/routines";
import { agentsAction, answer, readOrNull } from "../../../components/agents/actions.server";
import { type ActionResult, BUTTONS, Confirm } from "../../../components/agents/dialogs";
import { reposFrom, routineInWords, scheduleFrom, untilLabel } from "../../../components/agents/format";
import { Quiet } from "../../../components/agents/parts";
import { type RoutineChannel, RoutineDialog } from "../../../components/agents/routine-dialog";
import { TimeAgo } from "../../../components/ui";
import { Hint } from "../../../components/ui/hint";
import { Switch } from "../../../components/ui/switch";
import { agentDmOf } from "../../../lib/chat";
import { sidebarOrNull } from "../../../lib/chat.server";
import { workspaceAgents } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

const EVENT_LABELS: Record<string, string> = Object.fromEntries(ROUTINE_EVENTS.map((e) => [e.key, e.label]));

/** The agent's routines, the ones its responsibilities suggest, and the conversations a routine could post in. */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const role = roleIn(viewer, params.owner);
  if (!role) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const isOwner = role === "owner";
  const [listed, sidebar, agent] = await Promise.all([
    readOrNull(workspaceAgents.routines(slug, params.handle.toLowerCase(), viewer)),
    // Only owners set routines up, so only they need the channels.
    isOwner ? sidebarOrNull(slug, viewer) : Promise.resolve(null),
    readOrNull(workspaceAgents.get(slug, params.handle.toLowerCase(), viewer)),
  ]);
  const channels: RoutineChannel[] = (sidebar?.entries ?? [])
    .filter((entry) => (entry.channel.kind === "channel" && entry.channel.name) || (agent && agentDmOf(entry) === agent.id))
    .map((entry) => ({ id: entry.channel.id, label: entry.channel.kind === "channel" ? `#${entry.channel.name}` : `Your direct message with ${agent?.display_name ?? "it"}` }))
    .sort((a, b) => Number(b.label.startsWith("#")) - Number(a.label.startsWith("#")) || a.label.localeCompare(b.label));
  return { routines: listed?.routines ?? null, suggestions: listed?.suggestions ?? [], channels, isOwner };
}

/** A routine from the dialog's fields. */
function routineFrom(form: FormData): { ok: true; input: NewRoutine } | { ok: false; error: string } {
  const every = String(form.get("every") ?? "none");
  let schedule = null;
  if (every !== "none") {
    const time = every === "hour" ? `00:${String(Number(form.get("minute") ?? 0)).padStart(2, "0")}` : String(form.get("time") ?? "");
    schedule = scheduleFrom(every, time, String(form.get("weekday") ?? ""));
    if (!schedule) return { ok: false, error: "That schedule isn't one a routine can run on." };
  }
  const events = form.getAll("events").map(String) as RoutineEvent[];
  const repos = reposFrom(String(form.get("repos") ?? ""));
  if (!repos) return { ok: false, error: "Name repositories as workspace/name, separated by commas." };
  return {
    ok: true,
    input: {
      name: String(form.get("name") ?? ""),
      instructions: String(form.get("instructions") ?? ""),
      schedule,
      events,
      repos: events.length > 0 ? repos : [],
      channel_id: String(form.get("channel") ?? ""),
      enabled: form.get("enabled") !== "false",
    },
  };
}

export async function action({ params, context, request }: Route.ActionArgs): Promise<ActionResult> {
  const { viewer, slug, form } = await agentsAction(request, context, params.owner);
  const handle = params.handle.toLowerCase();
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("id") ?? "") || null;
  if (intent === "save") {
    const read = routineFrom(form);
    if (!read.ok) return { ok: false, intent, error: read.error };
    return answer(intent, workspaceAgents.saveRoutine(slug, handle, viewer, read.input, id));
  }
  if (intent === "toggle" && id) {
    // Turning one on or off saves it as it is, with the switch changed.
    const listed = await readOrNull(workspaceAgents.routines(slug, handle, viewer));
    const routine = listed?.routines.find((r) => r.id === id);
    if (!routine) return { ok: false, intent, error: "There is no such routine." };
    const { name, instructions, schedule, events, repos, channel_id } = routine;
    return answer(intent, workspaceAgents.saveRoutine(slug, handle, viewer, { name, instructions, schedule, events, repos, channel_id, enabled: form.get("enabled") === "true" }, id));
  }
  if (intent === "run" && id) return answer(intent, workspaceAgents.runRoutine(slug, handle, viewer, id));
  if (intent === "delete" && id) return answer(intent, workspaceAgents.deleteRoutine(slug, handle, viewer, id));
  return { ok: false, intent, error: "Unknown request." };
}

/**
 * Work the agent does without being asked: on a schedule, when something
 * happens, or both. Each run is a session in the routine's channel.
 */
export default function Routines({ loaderData, params }: Route.ComponentProps) {
  const agent = useOutletContext<WorkspaceAgent>();
  const { routines, suggestions, channels, isOwner } = loaderData;
  if (!routines) return <Quiet title="Routines can't be shown right now">The agents service didn&apos;t answer. Reload in a moment.</Quiet>;
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <p className="max-w-xl text-sm text-muted">
          Work {agent.display_name} does without being asked: on a schedule (UTC), when something happens, or both. Each run is a session posted in the
          routine&apos;s channel, paid from {agent.display_name}&apos;s budget, with the access of the owner who set it up.
        </p>
        {isOwner && (
          <RoutineDialog
            agentName={agent.display_name}
            draft={{}}
            channels={channels}
            title="New routine"
            trigger={
              <button type="button" className={`${BUTTONS.PRIMARY} h-9 py-0`}>
                <Plus size={15} />
                New routine
              </button>
            }
          />
        )}
      </div>

      {routines.length === 0 ? (
        <Quiet title="No routines yet" icon={<CalendarClock size={20} />}>
          {isOwner ? `Add one, or start from a suggestion below.` : `An owner can give ${agent.display_name} work to do on a schedule or when something happens.`}
        </Quiet>
      ) : (
        <ul className="divide-y divide-line/60 overflow-hidden rounded-xl border border-line bg-surface">
          {routines.map((routine) => (
            <RoutineRow key={routine.id} routine={routine} agent={agent} channels={channels} isOwner={isOwner} slug={params.owner} />
          ))}
        </ul>
      )}

      {isOwner && suggestions.length > 0 && <Suggestions agent={agent} suggestions={suggestions} channels={channels} />}
    </div>
  );
}

function RoutineRow({ routine, agent, channels, isOwner, slug }: { routine: AgentRoutine; agent: WorkspaceAgent; channels: RoutineChannel[]; isOwner: boolean; slug: string }) {
  const toggle = useFetcher<ActionResult>({ key: `toggle-${routine.id}` });
  const run = useFetcher<ActionResult>({ key: `run-${routine.id}` });
  const enabled = toggle.formData ? toggle.formData.get("enabled") === "true" : routine.enabled;
  const failed = [toggle.data, run.data].find((d) => d && !d.ok) as Extract<ActionResult, { ok: false }> | undefined;
  return (
    <li className="px-4 py-3.5">
      <div className="flex items-start gap-3">
        <CalendarClock size={16} className={`mt-0.5 shrink-0 ${enabled ? "text-accent" : "text-faint"}`} />
        <div className="min-w-0 grow">
          <p className={`text-sm font-medium ${enabled ? "" : "text-muted"}`}>{routine.name}</p>
          <p className="mt-0.5 text-xs text-muted">{routineInWords(routine, EVENT_LABELS)}</p>
          <p className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-faint">
            <span>{routine.channel_name ? `#${routine.channel_name}` : "A direct message"}</span>
            {routine.sponsor_username && <span>· runs as @{routine.sponsor_username}</span>}
            {enabled && routine.next_run_at && <span suppressHydrationWarning>· next {untilLabel(routine.next_run_at)}</span>}
            {routine.last_run_at && (
              <span>
                · last{" "}
                {routine.last_session_id ? (
                  <Link to={`/${slug}/-/agents/${agent.handle}/sessions/${routine.last_session_id}`} className="text-muted hover:text-fg hover:underline">
                    <TimeAgo at={routine.last_run_at} />
                  </Link>
                ) : (
                  <TimeAgo at={routine.last_run_at} />
                )}
              </span>
            )}
            <span>
              · {routine.runs} {routine.runs === 1 ? "run" : "runs"}
            </span>
          </p>
          {routine.paused_note && (
            <p className="mt-2 flex items-start gap-1.5 rounded-md border border-warn/30 bg-warn/10 px-2.5 py-1.5 text-xs text-warn">
              <AlertTriangle size={13} className="mt-px shrink-0" />
              {routine.paused_note}
            </p>
          )}
          {run.data?.ok && <p className="mt-2 text-xs text-success">Started. It shows on the Sessions tab and in #{routine.channel_name ?? "its channel"}.</p>}
          {failed && <p className="mt-2 text-xs text-danger">{failed.error}</p>}
        </div>
        {isOwner ? (
          <div className="flex shrink-0 items-center gap-1">
            <run.Form method="post">
              <input type="hidden" name="intent" value="run" />
              <input type="hidden" name="id" value={routine.id} />
              <Hint label="Run now">
                <button type="submit" aria-label="Run now" disabled={run.state !== "idle"} className="flex size-8 items-center justify-center rounded-md text-faint hover:bg-raised hover:text-fg disabled:opacity-50">
                  <Play size={14} />
                </button>
              </Hint>
            </run.Form>
            <RoutineDialog
              agentName={agent.display_name}
              draft={routine}
              channels={channels}
              title="Edit routine"
              trigger={
                <button type="button" aria-label="Edit" className="flex size-8 items-center justify-center rounded-md text-faint hover:bg-raised hover:text-fg">
                  <Pencil size={14} />
                </button>
              }
            />
            <Confirm
              title={`Delete “${routine.name}”?`}
              confirm="Delete routine"
              fields={{ intent: "delete", id: routine.id }}
              fetcherKey={`delete-${routine.id}`}
              trigger={
                <button type="button" aria-label="Delete" className="flex size-8 items-center justify-center rounded-md text-faint hover:bg-raised hover:text-danger">
                  <Trash2 size={14} />
                </button>
              }
            >
              It stops running. The sessions it already ran stay, with what they cost.
            </Confirm>
            <toggle.Form method="post" className="ml-1.5 flex">
              <input type="hidden" name="intent" value="toggle" />
              <input type="hidden" name="id" value={routine.id} />
              <Switch
                checked={enabled}
                aria-label={enabled ? "Turn off" : "Turn on"}
                onCheckedChange={(on) => toggle.submit({ intent: "toggle", id: routine.id, enabled: String(on) }, { method: "post" })}
              />
            </toggle.Form>
          </div>
        ) : (
          <span className={`shrink-0 text-xs ${enabled ? "text-success" : "text-faint"}`}>{enabled ? "On" : "Off"}</span>
        )}
      </div>
    </li>
  );
}

function Suggestions({ agent, suggestions, channels }: { agent: WorkspaceAgent; suggestions: RoutineSuggestion[]; channels: RoutineChannel[] }) {
  return (
    <section>
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <Lightbulb size={15} className="text-accent" />
        Suggested from {agent.display_name}&apos;s responsibilities
      </h2>
      <ul className="mt-3 grid gap-3 sm:grid-cols-2">
        {suggestions.map((suggestion) => (
          <li key={`${suggestion.responsibility}:${suggestion.routine.name}`} className="flex flex-col rounded-xl border border-dashed border-line bg-surface/60 p-4">
            <p className="text-xs text-faint">&ldquo;{suggestion.responsibility}&rdquo;</p>
            <p className="mt-2 text-sm font-medium">{suggestion.routine.name}</p>
            <p className="mt-0.5 text-xs text-muted">{routineInWords({ schedule: suggestion.routine.schedule, events: suggestion.routine.events, repos: suggestion.routine.repos }, EVENT_LABELS)}</p>
            <div className="mt-auto pt-3">
              <RoutineDialog
                agentName={agent.display_name}
                draft={suggestion.routine}
                channels={channels}
                title="Add routine"
                trigger={
                  <button type="button" className={`${BUTTONS.QUIET} h-8 py-0`}>
                    <Plus size={14} />
                    Add
                  </button>
                }
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
