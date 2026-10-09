import { ChevronRight, History } from "lucide-react";
import { useState } from "react";
import { Form, data, redirect, useNavigation, useOutletContext } from "react-router";

import type { AgentVersion, WorkspaceAgent } from "@g1t/contracts";

import type { Route } from "./+types/profile";
import { AgentForm } from "../../../components/agents-mode";
import { readOrNull } from "../../../components/agents/actions.server";
import { versionChanges } from "../../../components/agents/format";
import { TimeAgo } from "../../../components/ui";
import { isOrchestrator } from "../../../components/orchestrator";
import { readAgentForm } from "../../../lib/agent-form";
import { identity, workspaceAgents } from "../../../lib/services.server";
import { assertSameOrigin, requireUser, roleIn } from "../../../lib/session.server";

/** The workspace's teams, to put the agent on one, and its saved versions. */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const [teams, versions] = await Promise.all([
    identity.listTeams(viewer, params.owner).catch(() => null),
    readOrNull(workspaceAgents.versions(params.owner.toLowerCase(), params.handle.toLowerCase(), viewer)),
  ]);
  return { teams: teams?.ok ? teams.value.map((team) => ({ slug: team.slug, name: team.name })) : [], versions };
}

/** Saving makes a new version; every run records which one it ran. */
export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  const form = await request.formData();
  // Archiving keeps the agent's history (runs, replies, spend) but takes it
  // out of chat and frees its handle. g1t itself can't be archived.
  if (form.get("intent") === "archive") {
    const archived = await workspaceAgents.archive(slug, params.handle.toLowerCase(), viewer).catch(() => null);
    if (!archived) return { errors: { form: "The agents service didn't answer. Try again in a moment." }, saved: false };
    if (!archived.ok) return { errors: { form: archived.error.message }, saved: false };
    throw redirect(`/${slug}/-/agents`);
  }
  const read = readAgentForm(form, { orchestrator: params.handle.toLowerCase() === "g1t" });
  if (!read.ok) return { errors: read.errors, saved: false };
  const saved = await workspaceAgents.update(slug, params.handle.toLowerCase(), viewer, read.input).catch(() => null);
  if (!saved) return { errors: { form: "The agents service didn't answer. Try again in a moment." }, saved: false };
  if (!saved.ok) return { errors: { [saved.error.code === "conflict" ? "handle" : "form"]: saved.error.message }, saved: false };
  // A new handle is a new address.
  if (saved.value.handle !== params.handle.toLowerCase()) throw redirect(`/${slug}/-/agents/${saved.value.handle}/profile`);
  return { errors: undefined, saved: true };
}

export default function Profile({ loaderData, actionData }: Route.ComponentProps) {
  const agent = useOutletContext<WorkspaceAgent>();
  const errors = actionData?.errors as Record<string, string> | undefined;
  return (
    <>
      {actionData?.saved && (
        <p role="status" className="mb-6 rounded-lg border border-success/30 bg-success/10 px-4 py-2.5 text-sm text-success">
          Saved as version {agent.version}.
        </p>
      )}
      {errors?.form && <p className="mb-6 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">{errors.form}</p>}
      <AgentForm
        draft={agent}
        errors={errors}
        submit="Save changes"
        intent="update"
        formKey={`${agent.id}:${agent.version}`}
        locked={isOrchestrator(agent)}
        teams={loaderData.teams}
        seed={agent.avatar_seed || agent.id}
      />
      {loaderData.versions && loaderData.versions.length > 0 && <Versions versions={loaderData.versions} current={agent.version} />}
      {!isOrchestrator(agent) && <Archive name={agent.display_name} />}
    </>
  );
}

/** Retiring an agent: asked twice, since it leaves every channel at once. */
function Archive({ name }: { name: string }) {
  const [asking, setAsking] = useState(false);
  const busy = useNavigation().formData?.get("intent") === "archive";
  return (
    <section className="mt-12 border-t border-line pt-8 md:grid md:grid-cols-[14rem_1fr] md:gap-10">
      <div className="mb-4 md:mb-0">
        <h2 className="text-sm font-semibold text-fg">Archive</h2>
        <p className="mt-1 text-sm text-muted">Retire this agent. Only owners can.</p>
      </div>
      <div>
        <p className="text-sm text-muted">
          {name} stops answering, leaves every channel and DM, and its handle is free to use again. Its runs, replies and spend stay in
          the audit log and on Usage.
        </p>
        {asking ? (
          <Form method="post" className="mt-4 flex flex-wrap items-center gap-3">
            <input type="hidden" name="intent" value="archive" />
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg border border-danger/50 bg-danger/15 px-4 py-2 text-sm font-medium text-danger hover:bg-danger/25 disabled:opacity-60"
            >
              {busy ? "Archiving…" : `Archive ${name}`}
            </button>
            <button type="button" onClick={() => setAsking(false)} className="px-2 py-2 text-sm text-muted hover:text-fg">
              Keep {name}
            </button>
          </Form>
        ) : (
          <button
            type="button"
            onClick={() => setAsking(true)}
            className="mt-4 rounded-lg border border-line px-4 py-2 text-sm text-muted hover:border-danger/50 hover:text-danger"
          >
            Archive agent…
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * Every saved version of the agent, newest first: who saved it, when, and
 * what changed from the one before. Each run and reply records the version
 * it ran with.
 */
function Versions({ versions, current }: { versions: AgentVersion[]; current: number }) {
  const [open, setOpen] = useState(false);
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  const shown = open ? sorted : sorted.slice(0, 3);
  return (
    <section className="mt-12 border-t border-line pt-8 md:grid md:grid-cols-[14rem_1fr] md:gap-10">
      <div className="mb-4 md:mb-0">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
          <History size={14} className="text-faint" />
          Version history
        </h2>
        <p className="mt-1 text-sm text-muted">Every save is a new version. Sessions and replies record the one they ran with.</p>
      </div>
      <div>
        <ol className="divide-y divide-line/60 overflow-hidden rounded-xl border border-line bg-surface">
          {shown.map((version) => {
            const before = sorted.find((v) => v.version < version.version) ?? null;
            const definition = version.definition as Record<string, unknown>;
            return (
              <li key={version.version} className="px-4 py-3">
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-3 text-sm [&::-webkit-details-marker]:hidden">
                    <ChevronRight size={14} className="shrink-0 text-faint transition-transform group-open:rotate-90" />
                    <span className="font-medium tabular-nums">Version {version.version}</span>
                    {version.version === current && <span className="rounded-full bg-accent/15 px-1.5 py-px text-[0.6875rem] font-medium text-accent">Current</span>}
                    <span className="min-w-0 grow truncate text-muted">
                      {before ? versionChanges(before.definition as Record<string, unknown>, definition) : version.version === 1 ? "Created" : "Saved"}
                    </span>
                    <span className="shrink-0 text-xs text-faint">
                      @{version.changed_by} · <TimeAgo at={version.created_at} />
                    </span>
                  </summary>
                  <dl className="mt-3 grid gap-x-6 gap-y-2 pl-7 text-xs sm:grid-cols-2">
                    {summaryOf(definition).map(([label, value]) => (
                      <div key={label} className="min-w-0">
                        <dt className="text-faint">{label}</dt>
                        <dd className="mt-0.5 line-clamp-3 text-fg-soft">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              </li>
            );
          })}
        </ol>
        {sorted.length > 3 && (
          <button type="button" onClick={() => setOpen(!open)} className="mt-3 text-sm text-muted hover:text-fg">
            {open ? "Show fewer" : `Show all ${sorted.length} versions`}
          </button>
        )}
      </div>
    </section>
  );
}

/** A saved definition, in a few lines. */
function summaryOf(definition: Record<string, unknown>): [string, string][] {
  const out: [string, string][] = [];
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const name = text(definition.display_name);
  if (name) out.push(["Name", `${name}${text(definition.handle) ? ` (@${definition.handle})` : ""}`]);
  const title = text(definition.title) ?? text(definition.role);
  if (title) out.push(["Role", title]);
  const job = text(definition.instructions);
  if (job) out.push(["Job", job]);
  const voice = text(definition.personality_preset);
  if (voice) out.push(["Personality", [voice, text(definition.personality)].filter(Boolean).join(" · ")]);
  const budget = definition.budget as { monthly_micros?: number | null; task_micros?: number | null } | undefined;
  if (budget && (budget.monthly_micros != null || budget.task_micros != null)) {
    const dollars = (m: number) => `$${(m / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    out.push(["Budget", [budget.monthly_micros != null ? `${dollars(budget.monthly_micros)} a month` : null, budget.task_micros != null ? `${dollars(budget.task_micros)} a session` : null].filter(Boolean).join(", ")]);
  }
  const duties = Array.isArray(definition.responsibilities) ? (definition.responsibilities as string[]) : [];
  if (duties.length > 0) out.push(["Responsibilities", duties.join("; ")]);
  return out;
}
