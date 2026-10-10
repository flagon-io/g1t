import { BookOpen, ChartColumn, Check, Code, FileText, FolderOpen, Globe, GraduationCap, type LucideIcon, PenLine, Send, Store } from "lucide-react";
import { data, useFetcher, useOutletContext } from "react-router";

import {
  type AgentSkill,
  FOUNDATIONAL_SKILLS,
  FOUNDATIONAL_SKILLS_VERSION,
  FOUNDATIONAL_SKILL_IDS,
  SKILL_SOURCES,
  type SkillAbility,
  type SkillCategory,
  type SkillSource,
  type WorkspaceAgent,
} from "@g1t/contracts";

import type { Route } from "./+types/skills";
import { agentsAction, answer } from "../../../components/agents/actions.server";
import type { ActionResult } from "../../../components/agents/dialogs";
import { Badge } from "../../../components/ui/badge";
import { Hint } from "../../../components/ui/hint";
import { Switch } from "../../../components/ui/switch";
import { cn } from "../../../lib/cn";
import { workspaceAgents } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

/** Whether the viewer may turn skills on and off: the workspace's owners, as for every change to an agent. */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const role = roleIn(viewer, params.owner);
  if (!role) throw data(null, { status: 404 });
  return { isOwner: role === "owner" };
}

/** Turns one foundational skill on or off: a new version of the agent, like any change. */
export async function action({ params, context, request }: Route.ActionArgs): Promise<ActionResult> {
  const { viewer, slug, isOwner, form } = await agentsAction(request, context, params.owner);
  const intent = String(form.get("intent") ?? "");
  if (intent !== "skill") return { ok: false, intent, error: "Unknown request." };
  if (!isOwner) return { ok: false, intent, error: "Only the workspace's owners turn an agent's skills on or off." };
  const skill = String(form.get("skill") ?? "");
  if (!FOUNDATIONAL_SKILL_IDS.includes(skill)) return { ok: false, intent, error: "There is no such skill." };
  const handle = params.handle.toLowerCase();
  const current = await workspaceAgents.get(slug, handle, viewer).catch(() => null);
  if (!current) return { ok: false, intent, error: "The agents service didn't answer. Try again in a moment." };
  if (!current.ok) return { ok: false, intent, error: current.error.message };
  const off = new Set(current.value.skills_off ?? []);
  if (form.get("on") === "true") off.delete(skill);
  else off.add(skill);
  return answer(intent, workspaceAgents.update(slug, handle, viewer, { skills_off: [...off] }));
}

const ICONS: Record<SkillCategory, LucideIcon> = { documents: FileText, research: Globe, data: ChartColumn, code: Code, communication: Send, files: FolderOpen };
const SOURCE_ICONS: Record<SkillSource, LucideIcon> = { foundational: BookOpen, workspace: PenLine, marketplace: Store, learned: GraduationCap };

/**
 * An agent's skills: g1t's foundational ones, what each does today and
 * with which of the agent's tools, what's coming, and for owners a switch
 * on each; then where more skills will come from.
 */
export default function SkillsTab({ loaderData }: Route.ComponentProps) {
  const agent = useOutletContext<WorkspaceAgent>();
  const { isOwner } = loaderData;
  const fetcher = useFetcher<ActionResult>({ key: `skills-${agent.id}` });
  // While a switch's change is on its way, it shows as changed.
  const pending = fetcher.formData ? { skill: String(fetcher.formData.get("skill")), on: fetcher.formData.get("on") === "true" } : null;
  const isOn = (id: string) => (pending?.skill === id ? pending.on : !(agent.skills_off ?? []).includes(id));
  const onCount = FOUNDATIONAL_SKILLS.filter((skill) => isOn(skill.id)).length;
  const error = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  return (
    <div className="space-y-10">
      <p className="max-w-2xl text-sm text-muted">
        Every agent starts with g1t&apos;s foundational skills, so asking {agent.display_name} for a PDF gets you a PDF. A skill is a playbook: how to do a kind of work with the
        tools {agent.display_name} already has. Skills never add a tool or a permission, and each says plainly what isn&apos;t possible yet.
      </p>

      <section aria-labelledby="foundational">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id="foundational" className="text-sm font-medium">
            Foundational, from g1t <span className="text-faint">{onCount === FOUNDATIONAL_SKILLS.length ? FOUNDATIONAL_SKILLS.length : `${onCount} of ${FOUNDATIONAL_SKILLS.length} on`}</span>
          </h2>
          <p className="text-xs text-faint">Version {FOUNDATIONAL_SKILLS_VERSION}, updated with every release</p>
        </div>
        {isOwner && <p className="mt-1 text-xs text-faint">Turning a skill off takes its playbook out of {agent.display_name}&apos;s instructions. Its tools stay as they are.</p>}
        {error && (
          <p role="alert" className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {FOUNDATIONAL_SKILLS.map((skill) => (
            <SkillCard key={skill.id} skill={skill} on={isOn(skill.id)} agentName={agent.display_name} isOwner={isOwner} fetcher={fetcher} />
          ))}
        </div>
      </section>

      <section aria-labelledby="web-access" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <Globe size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden />
          <div className="min-w-0">
            <h2 id="web-access" className="text-sm font-medium">
              Web access
            </h2>
            <p className="mt-0.5 text-sm text-muted">Searching and reading the open web, set per team: open, approved sites only, or off.</p>
          </div>
        </div>
        <ComingBadge />
      </section>

      <section aria-labelledby="more-skills">
        <h2 id="more-skills" className="text-sm font-medium">
          More skills
        </h2>
        <p className="mt-1 text-xs text-faint">Skills you add will work the same way: a playbook that uses the tools {agent.display_name} already has.</p>
        <ul className="mt-3 divide-y divide-line/60 overflow-hidden rounded-xl border border-line bg-surface">
          {SKILL_SOURCES.filter((source) => source.source !== "foundational").map((source) => {
            const Icon = SOURCE_ICONS[source.source];
            return (
              <li key={source.source} className="flex items-start gap-3 px-4 py-3">
                <Icon size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden />
                <div className="min-w-0 grow">
                  <p className="text-sm font-medium text-fg">{source.label}</p>
                  <p className="mt-0.5 text-sm text-muted">{source.description}</p>
                </div>
                {source.status === "coming" && <ComingBadge />}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function ComingBadge() {
  return <Badge tone="neutral">Coming</Badge>;
}

function SkillCard({
  skill,
  on,
  agentName,
  isOwner,
  fetcher,
}: {
  skill: AgentSkill;
  on: boolean;
  agentName: string;
  isOwner: boolean;
  fetcher: ReturnType<typeof useFetcher<ActionResult>>;
}) {
  const Icon = ICONS[skill.category];
  const ready = skill.abilities.filter((ability) => ability.status === "ready");
  const coming = skill.abilities.filter((ability) => ability.status === "coming");
  const toggle = (next: boolean) => fetcher.submit({ intent: "skill", skill: skill.id, on: String(next) }, { method: "post" });
  const label = `${skill.name} for ${agentName}`;
  return (
    <article className={cn("flex flex-col rounded-xl border border-line bg-surface", !on && "bg-transparent")} aria-labelledby={`skill-${skill.id}`}>
      <header className="flex items-start gap-3 p-4 pb-3">
        <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", on ? "bg-accent/10 text-accent" : "bg-raised text-faint")}>
          <Icon size={17} aria-hidden />
        </span>
        <div className="min-w-0 grow">
          <h3 id={`skill-${skill.id}`} className={cn("text-sm font-semibold", on ? "text-fg" : "text-muted")}>
            {skill.name}
          </h3>
          <p className="mt-0.5 text-sm text-muted">{skill.description}</p>
        </div>
        {isOwner ? (
          <Hint label={on ? `Turn off ${skill.name}` : `Turn on ${skill.name}`}>
            <span className="mt-0.5 inline-flex">
              <Switch checked={on} onCheckedChange={toggle} aria-label={label} disabled={fetcher.state !== "idle"} />
            </span>
          </Hint>
        ) : (
          <Badge tone={on ? "success" : "neutral"} className="mt-0.5 shrink-0">
            {on ? "On" : "Off"}
          </Badge>
        )}
      </header>
      <ul className={cn("space-y-2.5 border-t border-line/60 px-4 py-3", !on && "opacity-60")}>
        {ready.map((ability) => (
          <Ability key={ability.id} ability={ability} />
        ))}
        {coming.map((ability) => (
          <Ability key={ability.id} ability={ability} />
        ))}
      </ul>
      <details className="group mt-auto border-t border-line/60">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-2.5 text-xs font-medium text-muted select-none hover:text-fg [&::-webkit-details-marker]:hidden">
          <BookOpen size={13} aria-hidden />
          <span className="group-open:hidden">Read the playbook</span>
          <span className="hidden group-open:inline">Hide the playbook</span>
        </summary>
        <div className="px-4 pb-4">
          <p className="text-xs text-faint">What {agentName} is told while {skill.name} is on:</p>
          <p className="mt-2 rounded-lg bg-raised/60 px-3 py-2.5 text-[0.8125rem] leading-relaxed whitespace-pre-wrap text-fg-soft">{skill.instructions}</p>
        </div>
      </details>
    </article>
  );
}

function Ability({ ability }: { ability: SkillAbility }) {
  const ready = ability.status === "ready";
  return (
    <li className="flex items-start gap-2.5">
      {ready ? (
        <Check size={14} className="mt-0.75 shrink-0 text-success" aria-label="Works today" />
      ) : (
        <span className="mt-0.75 flex size-3.5 shrink-0 items-center justify-center" aria-hidden>
          <span className="size-2 rounded-full border border-line-strong" />
        </span>
      )}
      <div className="min-w-0 grow">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn("text-sm", ready ? "text-fg" : "text-muted")}>{ability.label}</span>
          {!ready && <ComingBadge />}
        </div>
        <p className="mt-0.5 text-xs text-faint">{ability.note}</p>
        {ready && ability.tools.length > 0 && (
          <ul className="mt-1.5 flex flex-wrap gap-1" aria-label="Tools it uses">
            {ability.tools.map((tool) => (
              <li key={tool} className="rounded-[5px] bg-raised px-1.5 py-px font-mono text-[0.6875rem] text-muted ring-1 ring-line ring-inset">
                {tool}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}
