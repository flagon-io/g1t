import { ArrowUpCircle, BookOpen, ChartColumn, Check, Code, FileText, FolderOpen, Globe, Library, type LucideIcon, Plus, Send, Store } from "lucide-react";
import { Link, data, useFetcher, useOutletContext } from "react-router";

import {
  type AgentSkill,
  type AgentSkillLine,
  type AgentSkills,
  FOUNDATIONAL_SKILLS,
  FOUNDATIONAL_SKILLS_VERSION,
  FOUNDATIONAL_SKILL_IDS,
  type LibrarySkill,
  type SkillAbility,
  type SkillCategory,
  type WorkspaceAgent,
} from "@g1t/contracts";

import type { Route } from "./+types/skills";
import { agentsAction, answer, readOrNull } from "../../../components/agents/actions.server";
import { type ActionResult } from "../../../components/agents/dialogs";
import { AttachToAgentDialog, AttachmentChip, NeedsComputer, skillsPath } from "../../../components/agents/skills";
import { ButtonLink } from "../../../components/ui";
import { Alert } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { Hint } from "../../../components/ui/hint";
import { Switch } from "../../../components/ui/switch";
import { cn } from "../../../lib/cn";
import { skillLibrary, workspaceAgents } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

/** A library skill's id, as an agent's `skills_off` holds it. */
const LIBRARY_ID = /^skl_[0-9a-z]{26}$/;

/**
 * The agent's skills: whether the viewer owns the workspace (owners turn
 * skills on and off), the library's skills that reach it, and for owners
 * the library's others, to attach.
 */
export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ isOwner: boolean; skills: AgentSkills | null; attachable: Pick<LibrarySkill, "name" | "description" | "version">[] }> {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  const role = roleIn(viewer, slug);
  if (!role) throw data(null, { status: 404 });
  const isOwner = role === "owner";
  const [skills, library] = await Promise.all([
    readOrNull(skillLibrary.agentSkills(slug, viewer, params.handle.toLowerCase())),
    isOwner ? readOrNull(skillLibrary.library(slug, viewer)) : Promise.resolve(null),
  ]);
  const has = new Set(skills?.skills.map((s) => s.id) ?? []);
  const attachable = (library?.skills ?? []).filter((s) => s.status === "published" && !has.has(s.id)).map((s) => ({ name: s.name, description: s.description, version: s.version }));
  return { isOwner, skills, attachable };
}

/** Turns a skill on or off (a new version of the agent), attaches one, or moves one to its newest version. */
export async function action({ params, context, request }: Route.ActionArgs): Promise<ActionResult> {
  const { viewer, slug, isOwner, form } = await agentsAction(request, context, params.owner);
  const intent = String(form.get("intent") ?? "");
  const handle = params.handle.toLowerCase();
  if (intent === "attach") return answer(intent, skillLibrary.attachSkill(slug, viewer, String(form.get("name") ?? ""), "agent", handle));
  if (intent === "pin") return answer(intent, skillLibrary.pinSkill(slug, viewer, String(form.get("name") ?? ""), String(form.get("attachment") ?? ""), null));
  if (intent !== "skill") return { ok: false, intent, error: "Unknown request." };
  if (!isOwner) return { ok: false, intent, error: "Only the workspace's owners turn an agent's skills on or off." };
  const skill = String(form.get("skill") ?? "");
  if (!FOUNDATIONAL_SKILL_IDS.includes(skill) && !LIBRARY_ID.test(skill)) return { ok: false, intent, error: "There is no such skill." };
  const current = await workspaceAgents.get(slug, handle, viewer).catch(() => null);
  if (!current) return { ok: false, intent, error: "The agents service didn't answer. Try again in a moment." };
  if (!current.ok) return { ok: false, intent, error: current.error.message };
  const off = new Set(current.value.skills_off ?? []);
  if (form.get("on") === "true") off.delete(skill);
  else off.add(skill);
  return answer(intent, workspaceAgents.update(slug, handle, viewer, { skills_off: [...off] }));
}

const ICONS: Record<SkillCategory, LucideIcon> = { documents: FileText, research: Globe, data: ChartColumn, code: Code, communication: Send, files: FolderOpen };

/**
 * An agent's skills: g1t's foundational ones, what each does today and
 * with which of the agent's tools, what's coming; then the library's that
 * reach it, through it, its teams or every agent. Owners switch each on or
 * off, attach more, and move one to its newest version.
 */
export default function SkillsTab({ loaderData, params }: Route.ComponentProps) {
  const agent = useOutletContext<WorkspaceAgent>();
  const { isOwner, skills, attachable } = loaderData;
  const fetcher = useFetcher<ActionResult>({ key: `skills-${agent.id}` });
  // While a switch's change is on its way, it shows as changed.
  const pending = fetcher.formData && fetcher.formData.get("intent") === "skill" ? { skill: String(fetcher.formData.get("skill")), on: fetcher.formData.get("on") === "true" } : null;
  const isOn = (id: string) => (pending?.skill === id ? pending.on : !(agent.skills_off ?? []).includes(id));
  const onCount = FOUNDATIONAL_SKILLS.filter((skill) => isOn(skill.id)).length;
  const error = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  const library = skills?.skills.filter((s) => !s.foundational) ?? [];
  const slug = params.owner;
  return (
    <div className="space-y-10">
      <p className="max-w-2xl text-sm text-muted">
        Skills tell {agent.display_name} how to do a kind of work with the tools it already has, so asking it for a PDF gets you a PDF. It sees each skill&apos;s name and when to
        use it, and reads the rest when a request matches. Skills never add a tool or a permission, and say plainly what isn&apos;t possible yet.
      </p>
      {error && (
        <Alert asChild>
          <p role="alert">
            {error}
          </p>
        </Alert>
      )}

      <section aria-labelledby="foundational">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id="foundational" className="text-sm font-medium">
            Foundational, from g1t <span className="text-faint">{onCount === FOUNDATIONAL_SKILLS.length ? FOUNDATIONAL_SKILLS.length : `${onCount} of ${FOUNDATIONAL_SKILLS.length} on`}</span>
          </h2>
          <p className="text-xs text-faint">Version {FOUNDATIONAL_SKILLS_VERSION}, updated with every release</p>
        </div>
        {isOwner && <p className="mt-1 text-xs text-faint">Turning a skill off takes it out of {agent.display_name}&apos;s instructions. Its tools stay as they are.</p>}
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {FOUNDATIONAL_SKILLS.map((skill) => (
            <SkillCard key={skill.id} skill={skill} on={isOn(skill.id)} agentName={agent.display_name} isOwner={isOwner} fetcher={fetcher} />
          ))}
        </div>
      </section>

      <section aria-labelledby="library">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 id="library" className="text-sm font-medium">
              From your library <span className="text-faint">{library.length}</span>
            </h2>
            <p className="mt-1 text-xs text-faint">Attached to {agent.display_name}, to a team it is on, or to every agent. Each uses the version pinned where it is attached.</p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <ButtonLink to={skillsPath(slug)} variant="outline" size="sm">
              <Library size={13} />
              Open the library
            </ButtonLink>
            {isOwner && (
              <AttachToAgentDialog
                agentName={agent.display_name}
                skills={attachable}
                trigger={
                  <Button type="button" variant="outline" size="sm">
                    <Plus size={13} />
                    Attach a skill
                  </Button>
                }
              />
            )}
          </div>
        </div>
        {skills == null ? (
          <Card asChild tone="plain" className="mt-3 border-dashed px-4 py-6 text-center text-sm text-muted">
            <p>The library didn&apos;t answer. Reload in a moment.</p>
          </Card>
        ) : library.length === 0 ? (
          <Card asChild tone="plain" className="mt-3 border-dashed px-4 py-6 text-center text-sm text-muted">
            <p>
              None yet. Skills your workspace writes, imports or saves from sessions reach {agent.display_name} once they are attached.
            </p>
          </Card>
        ) : (
          <Card asChild className="mt-3 divide-y divide-line/60 overflow-hidden">
            <ul>
              {library.map((line) => (
                <LibraryLine key={line.id} slug={slug} line={line} on={isOn(line.id)} agentName={agent.display_name} isOwner={isOwner} fetcher={fetcher} />
              ))}
            </ul>
          </Card>
        )}
        {skills && skills.over_limit > 0 && (
          <p className="mt-2 text-sm text-warn">
            {agent.display_name} has {skills.over_limit} more than the 100 library skills an agent can have; it doesn&apos;t get the last {skills.over_limit}. Turn some off or
            detach them.
          </p>
        )}
      </section>

      <Card asChild className="divide-y divide-line/60 overflow-hidden">
        <section aria-label="Coming">
          <ComingRow icon={Globe} title="Web access" body="Searching and reading the open web, set per team: open, approved sites only, or off." />
          <ComingRow icon={Store} title="Skills from the Marketplace" body="Skills that extensions bring, added in one step." />
        </section>
      </Card>
    </div>
  );
}

function ComingRow({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <Icon size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden />
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="mt-0.5 text-sm text-muted">{body}</p>
        </div>
      </div>
      <ComingBadge />
    </div>
  );
}

function ComingBadge() {
  return <Badge tone="neutral">Coming</Badge>;
}

function LibraryLine({
  slug,
  line,
  on,
  agentName,
  isOwner,
  fetcher,
}: {
  slug: string;
  line: AgentSkillLine;
  on: boolean;
  agentName: string;
  isOwner: boolean;
  fetcher: ReturnType<typeof useFetcher<ActionResult>>;
}) {
  const toggle = (next: boolean) => fetcher.submit({ intent: "skill", skill: line.id, on: String(next) }, { method: "post" });
  return (
    <li className="flex items-start gap-3 px-4 py-3.5">
      <div className={cn("min-w-0 grow", !on && "opacity-60")}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link to={skillsPath(slug, line.name)} className="font-mono text-sm font-medium text-fg hover:underline">
            {line.name}
          </Link>
          <span className="text-xs text-faint">v{line.version}</span>
          {line.requires_computer && <NeedsComputer />}
        </div>
        <p className="mt-0.5 text-sm text-muted">{line.description}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {line.via && <AttachmentChip attachment={{ scope: line.via, label: line.via_label ?? "", version: Number(line.version) }} />}
          {line.update != null &&
            (line.can_change ? (
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="pin" />
                <input type="hidden" name="name" value={line.name} />
                <input type="hidden" name="attachment" value={line.attachment_id ?? ""} />
                <Hint label={line.via === "agent" ? `Move ${agentName} to version ${line.update}` : `Moves it to version ${line.update} for every agent it reaches through ${line.via_label}`}>
                  <Button type="submit" variant="link" size="xs" className="h-6 px-1.5 hover:bg-accent/10" disabled={fetcher.state !== "idle"}>
                    <ArrowUpCircle size={13} />
                    Update to v{line.update}
                  </Button>
                </Hint>
              </fetcher.Form>
            ) : (
              <span className="text-xs text-warn">Version {line.update} is out</span>
            ))}
        </div>
      </div>
      {isOwner ? (
        <Hint label={on ? `Turn off ${line.name}` : `Turn on ${line.name}`}>
          <span className="mt-0.5 inline-flex">
            <Switch checked={on} onCheckedChange={toggle} aria-label={`${line.name} for ${agentName}`} disabled={fetcher.state !== "idle"} />
          </span>
        </Hint>
      ) : (
        <Badge tone={on ? "success" : "neutral"} className="mt-0.5 shrink-0">
          {on ? "On" : "Off"}
        </Badge>
      )}
    </li>
  );
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
          <p className="text-xs text-faint">
            What {agentName} reads when it uses {skill.name}. {skill.when}
          </p>
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
