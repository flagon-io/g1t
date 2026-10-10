import { Activity, Brain, ChevronRight, Dices, LayoutTemplate, Network, Plus, Route as RouteIcon, Sparkles } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Form, NavLink, useLocation, useNavigation, useRouteLoaderData } from "react-router";

import type { AgentTemplate, ModelTier, WorkspaceAgent } from "@g1t/contracts";

import { type AgentLike, AgentAvatar, PixelCreature } from "./agent-avatar";
import { StatusDot, statusLabel } from "./chat/marks";
import { isOrchestrator } from "./orchestrator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Skeleton } from "./ui/skeleton";
import { AUTONOMY, type AgentDraft, PRESETS, TIER_LABELS, cleanHandle, dollarsField } from "../lib/agent-form";
import { Hint } from "./ui/hint";
import { DEPARTMENTS, RoleFields, SubagentsField } from "./agent-role";
import type { AgentsLayoutData } from "../routes/workspace/agents/layout";

/** The workspace's agents while an Agents page is open; undefined elsewhere. */
export function useAgentsData(): AgentsLayoutData | undefined {
  return useRouteLoaderData("routes/workspace/agents/layout") as AgentsLayoutData | undefined;
}

/** An agent's face: its picture, or the sparkle mark. */
export function AgentFace({ agent, size = 20 }: { agent: AgentLike; size?: number }) {
  return <AgentAvatar agent={agent} size={size} />;
}

function SideLink({ to, end, icon, children, trailing }: { to: string; end?: boolean; icon: ReactNode; children: ReactNode; trailing?: ReactNode }) {
  return (
    <NavLink
      to={to}
      end={end}
      prefetch="intent"
      className={({ isActive }) =>
        `group flex h-9 items-center gap-2.5 rounded-md px-2 text-[0.8125rem] transition-colors ${
          isActive ? "bg-raised font-medium text-fg" : "text-muted hover:bg-raised/60 hover:text-fg"
        }`
      }
    >
      <span className="flex w-5 shrink-0 justify-center">{icon}</span>
      <span className="min-w-0 grow truncate">{children}</span>
      {trailing}
    </NavLink>
  );
}

/** An agent as the sidebar lists it: from the Agents pages' own data, or the shell's on any other page. */
type Listed = Pick<WorkspaceAgent, "id" | "handle" | "display_name" | "avatar" | "role" | "status" | "title" | "team" | "department"> & {
  builtin?: boolean;
  avatar_seed?: string | null;
  scope?: WorkspaceAgent["scope"];
  personal_owner_id?: string | null;
  personal_owner?: string | null;
};

/** Where an agent sits in the org chart: its team, else its department. */
export function placeOf(agent: Pick<WorkspaceAgent, "team" | "department">): string {
  if (agent.team) return agent.team.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return agent.department?.trim() || "Unplaced";
}

/** "Margo · QA Engineer": how an agent reads wherever it shows. */
export function nameAndTitle(agent: Pick<WorkspaceAgent, "display_name" | "title">): string {
  return agent.title ? `${agent.display_name} · ${agent.title}` : agent.display_name;
}

/**
 * Agents mode's sidebar: the fleet's runs, context and memory; g1t, the
 * orchestrator, pinned at the top; then the specialists, each with its
 * role and status; and the way to make a new one.
 */
export function AgentsSidebar({
  slug,
  shellAgents,
  code,
  owner,
  phone = false,
}: {
  slug: string;
  /** A phone's Agents tab: the list as the page, with no heading of its own and no fleet row (the fleet is under it). */
  phone?: boolean;
  /** The shell's list, for pages outside `-/agents` (context, memory). */
  shellAgents: Listed[] | null;
  /** Context and memory are about the code: only with Code access. */
  code: boolean;
  owner: boolean;
}) {
  const data = useAgentsData();
  const agents: Listed[] | null = data?.agents ?? shellAgents;
  const live = data?.live ?? {};
  const orchestrator = agents?.find((agent) => isOrchestrator(agent)) ?? null;
  const specialists = (agents ?? []).filter((agent) => !isOrchestrator(agent) && agent.scope !== "personal");
  // Personal agents: the viewer's own under Yours; members' (an owner sees them) apart.
  // The shell's list holds only the viewer's own.
  const personal = (agents ?? []).filter((agent) => agent.scope === "personal").sort((a, b) => a.display_name.localeCompare(b.display_name));
  const yours = personal.filter((agent) => !data || agent.personal_owner_id === data.viewer_id);
  const members = personal.filter((agent) => !yours.includes(agent));
  // Owners always create agents; members personal ones, unless owners turned that off.
  const canCreate = data?.may_create ?? owner;
  const row = (agent: Listed) => (
    <li key={agent.id}>
      <NavLink
        to={`/${slug}/-/agents/${agent.handle}`}
        prefetch="intent"
        className={({ isActive }) =>
          `group flex h-11 items-center gap-2.5 rounded-md px-2 transition-colors ${isActive ? "bg-raised" : "hover:bg-raised/60"}`
        }
      >
        <span className="relative shrink-0">
          <AgentFace agent={{ ...agent, builtin: isOrchestrator(agent) }} size={26} />
          {!isOrchestrator(agent) && (
            <StatusDot status={agent.status} className="absolute -right-0.5 -bottom-0.5 ring-2 ring-shell" />
          )}
        </span>
        <span className="min-w-0 grow leading-tight">
          <span className="block truncate text-[0.8125rem] font-medium text-fg">{agent.display_name}</span>
          <span className="block truncate text-[0.6875rem] text-faint">
              {isOrchestrator(agent)
              ? "Orchestrator"
              : agent.scope === "personal" && agent.personal_owner && agent.personal_owner_id !== data?.viewer_id
                ? `@${agent.personal_owner}'s · ${agent.title || agent.role}`
                : agent.status === "idle"
                  ? agent.title || agent.role
                  : `${statusLabel(agent.status)} · ${agent.title || agent.role}`}
          </span>
        </span>
        {(live[agent.id] ?? 0) > 0 && (
          <Hint label={`${live[agent.id]} live ${live[agent.id] === 1 ? "session" : "sessions"}`}>
            <span className="flex h-5 min-w-5 shrink-0 items-center justify-center gap-1 rounded-full bg-accent/15 px-1.5 text-[0.6875rem] font-medium text-accent tabular-nums">
              <span className="size-1.5 animate-pulse rounded-full bg-accent motion-reduce:animate-none" aria-hidden="true" />
              {live[agent.id]}
              <span className="sr-only"> live sessions</span>
            </span>
          </Hint>
        )}
      </NavLink>
    </li>
  );
  return (
    <div className="flex h-full flex-col">
      <div className={`flex h-9 shrink-0 items-center justify-between pr-1 pl-3 ${phone ? "hidden" : ""}`}>
        <h2 className="text-xs font-medium text-faint">Agents</h2>
        {canCreate && (
          <NavLink
            to={`/${slug}/-/agents/new`}
            aria-label="New agent"
            className="flex size-8 items-center justify-center rounded-md text-faint transition-colors hover:bg-raised hover:text-fg"
          >
            <Plus size={16} />
          </NavLink>
        )}
      </div>
      <nav aria-label="Agents" className={`min-h-0 grow overflow-y-auto px-2.5 pt-3 pb-4 [scrollbar-width:thin] ${phone ? "[&_a]:min-h-11" : ""}`}>
        <div className="space-y-px">
          {!phone && (
            <SideLink to={`/${slug}/-/agents`} end icon={<Activity size={15} className="text-faint" />}>
              Overview
            </SideLink>
          )}
          <SideLink to={`/${slug}/-/agents/templates`} icon={<LayoutTemplate size={15} className="text-faint" />}>
            Templates
          </SideLink>
          {code && (
            <>
              <SideLink to={`/${slug}/-/context`} icon={<Network size={15} className="text-faint" />}>
                Context
              </SideLink>
              <SideLink to={`/${slug}/-/memory`} icon={<Brain size={15} className="text-faint" />}>
                Memory
              </SideLink>
            </>
          )}
        </div>
        {agents == null ? (
          data === undefined && shellAgents === null ? (
            <p className="mt-4 px-2 text-xs leading-relaxed text-faint">The agents service didn&apos;t answer. Your agents will show here once it does.</p>
          ) : (
            <div className="mt-5 space-y-3 px-2" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-2.5">
                  <Skeleton className="size-6 rounded-md" />
                  <Skeleton className="h-3 w-28" />
                </div>
              ))}
            </div>
          )
        ) : (
          <>
            {orchestrator && <Group title="Orchestrator">{row(orchestrator)}</Group>}
            {yours.length > 0 && <Group title="Yours">{yours.map(row)}</Group>}
            <p className="mt-4 px-2 text-[0.6875rem] leading-snug text-faint">Specialists are colleagues hired into a role. g1t hands them work.</p>
            {[...orgChart(specialists)].map(([place, members]) => (
              <Group key={place} title={`${place} · ${members.length}`} collapsible>
                {members.map(row)}
              </Group>
            ))}
            {specialists.length === 0 && <p className="px-2 py-1 text-xs text-faint">No specialists yet. Hire one into a role.</p>}
            {members.length > 0 && (
              <Group title={`Members' personal · ${members.length}`} collapsible initiallyOpen={false}>
                {members.map(row)}
              </Group>
            )}
          </>
        )}
        {canCreate && (
          <NavLink
            to={`/${slug}/-/agents/new`}
            className={({ isActive }) =>
              `mt-2 flex h-9 items-center gap-2.5 rounded-md border border-dashed px-2 text-[0.8125rem] transition-colors ${
                isActive ? "border-accent/50 bg-accent/10 text-fg" : "border-line text-muted hover:border-line-strong hover:text-fg"
              }`
            }
          >
            <span className="flex w-5 justify-center">
              <Plus size={15} />
            </span>
            New agent
          </NavLink>
        )}
      </nav>
    </div>
  );
}

/** Specialists by team or department, each group by name, the groups in the gallery's order. */
function orgChart(agents: Listed[]): Map<string, Listed[]> {
  const groups = new Map<string, Listed[]>();
  for (const agent of agents) groups.set(placeOf(agent), [...(groups.get(placeOf(agent)) ?? []), agent]);
  const rank = (place: string) => {
    const at = DEPARTMENTS.indexOf(place);
    return at < 0 ? DEPARTMENTS.length : at;
  };
  return new Map(
    [...groups]
      .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
      .map(([place, list]) => [place, list.sort((x, y) => x.display_name.localeCompare(y.display_name))]),
  );
}

function Group({ title, children, collapsible, initiallyOpen = true }: { title: string; children: ReactNode; collapsible?: boolean; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  if (collapsible) {
    return (
      <section className="mt-3">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="mb-1 flex w-full items-center gap-1 rounded px-1 text-xs font-medium text-faint transition-colors hover:text-muted"
        >
          <ChevronRight size={12} className={`transition-transform ${open ? "rotate-90" : ""}`} />
          {title}
        </button>
        {open && <ul className="space-y-px border-l border-line pl-1.5 ml-2.5">{children}</ul>}
      </section>
    );
  }
  return (
    <section className="mt-4">
      <h3 className="mb-1 px-2 text-xs font-medium text-faint">{title}</h3>
      <ul className="space-y-px">{children}</ul>
    </section>
  );
}

/** The templates g1t ships, and a blank one, to start a new agent from. */
export function TemplateGallery({ templates, chosen, onChoose }: { templates: AgentTemplate[]; chosen: string | null; onChoose: (id: string | null) => void }) {
  // By department, in the order the departments are listed; any other after them.
  const order = (department: string) => {
    const at = DEPARTMENTS.indexOf(department);
    return at < 0 ? DEPARTMENTS.length : at;
  };
  const groups = new Map<string, AgentTemplate[]>();
  for (const template of [...templates].sort((a, b) => order(a.department) - order(b.department))) {
    const key = template.department || "Other";
    groups.set(key, [...(groups.get(key) ?? []), template]);
  }
  return (
    <div className="space-y-8">
      {[...groups].map(([department, list]) => (
        <section key={department}>
          <h2 className="mb-3 text-xs font-semibold tracking-wide text-faint uppercase">{department}</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((template) => (
              <TemplateCard
                key={template.id}
                selected={chosen === template.id}
                onClick={() => onChoose(template.id)}
                name={template.display_name}
                title={template.title}
                seed={template.handle}
                duties={template.responsibilities.slice(0, 3)}
              />
            ))}
          </div>
        </section>
      ))}
      <section>
        <h2 className="mb-3 text-xs font-semibold tracking-wide text-faint uppercase">Your own</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <TemplateCard
            selected={chosen === "blank"}
            onClick={() => onChoose("blank")}
            name="A new role"
            title="Start from nothing"
            blank
            duties={["Give it a name, a title and a team", "Say what it is responsible for"]}
          />
        </div>
      </section>
    </div>
  );
}

/** A role to hire into: its face, a name it suggests, its title and what it does. */
function TemplateCard({
  selected,
  onClick,
  name,
  title,
  seed,
  duties,
  blank,
}: {
  selected: boolean;
  onClick: () => void;
  name: string;
  title: string;
  seed?: string;
  duties: string[];
  blank?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`group flex flex-col items-start rounded-xl border p-4 text-left transition-all ${
        selected
          ? "border-accent/60 bg-accent/[0.07] ring-1 ring-accent/40"
          : "border-line bg-surface hover:-translate-y-px hover:border-line-strong hover:bg-raised/40"
      }`}
    >
      <span className="flex w-full items-center gap-3">
        {blank ? (
          <span className="flex size-10 items-center justify-center rounded-[11px] border border-dashed border-line-strong text-muted">
            <Plus size={16} />
          </span>
        ) : (
          <PixelCreature seed={seed ?? name} size={40} />
        )}
        <span className="min-w-0 grow">
          <span className="block truncate text-sm font-semibold">{name}</span>
          <span className="block truncate text-xs text-muted">{title}</span>
        </span>
        <ChevronRight size={15} className={`shrink-0 transition-colors ${selected ? "text-accent" : "text-faint group-hover:text-muted"}`} />
      </span>
      <ul className="mt-3 space-y-1">
        {duties.map((duty) => (
          <li key={duty} className="flex gap-2 text-[0.8125rem] leading-snug text-muted">
            <span className="mt-[0.45rem] size-1 shrink-0 rounded-full bg-line-strong" aria-hidden="true" />
            <span className="line-clamp-1">{duty}</span>
          </li>
        ))}
      </ul>
    </button>
  );
}

const FIELD = "w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim";

function Label({ children, hint, error, htmlFor }: { children: ReactNode; hint?: ReactNode; error?: string; htmlFor?: string }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-3">
      <label htmlFor={htmlFor} className="text-sm font-medium text-fg-soft">
        {children}
      </label>
      {error ? <span className="text-xs text-danger">{error}</span> : hint ? <span className="text-xs text-faint">{hint}</span> : null}
    </div>
  );
}

/** A section of the form: what it is on the left, its fields on the right, on a wide screen. */
function FormSection({ title, about, children }: { title: string; about: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-x-10 gap-y-4 border-t border-line py-8 first-of-type:border-t-0 first-of-type:pt-0 md:grid-cols-[13rem_1fr]">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted">{about}</p>
      </div>
      <div className="min-w-0 space-y-5">{children}</div>
    </section>
  );
}

function TierSelect({ name, value, none }: { name: string; value: ModelTier | null; none: string }) {
  return (
    <Select name={name} defaultValue={value ?? "none"}>
      <SelectTrigger id={name}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">{none}</SelectItem>
        {(["small", "large", "frontier"] as const).map((tier) => (
          <SelectItem key={tier} value={tier} description={TIER_LABELS[tier].split(": ")[1]}>
            {TIER_LABELS[tier].split(":")[0]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Money({ name, value, label, hint, error }: { name: string; value: number | null; label: string; hint: string; error?: string }) {
  return (
    <div>
      <Label htmlFor={name} hint={hint} error={error}>
        {label}
      </Label>
      <div className="flex items-center rounded-md border border-line bg-bg transition-colors focus-within:border-accent-dim hover:border-line-strong">
        <span className="pl-3 text-sm text-faint">$</span>
        <input
          id={name}
          name={name}
          inputMode="decimal"
          defaultValue={dollarsField(value)}
          placeholder="No cap"
          autoComplete="off"
          data-1p-ignore
          className="min-w-0 grow bg-transparent px-2 py-2 text-sm tabular-nums outline-none placeholder:text-faint"
        />
      </div>
    </div>
  );
}

/** Names to shuffle through when a template has none of its own. */
const FALLBACK_NAMES = ["Margo", "Juniper", "Otto", "Wren", "Basil", "Nova", "Clementine", "Fig", "Rook", "Pip"];

/**
 * Everything that defines an agent, for making one and for its Profile:
 * who it is, its job, its voice, the limits on routing, its budget, what it
 * may do alone, and how much it takes on at once.
 */
export function AgentForm({
  draft,
  errors,
  submit,
  intent,
  formKey,
  nameIdeas = [],
  locked = false,
  seed,
  teams = [],
  spaces = [],
  hidden = {},
  personal = false,
}: {
  /** A personal agent: on no team. */
  personal?: boolean;
  /** Fields the form carries without showing: a drafted agent's scope, skills and face. */
  hidden?: Record<string, string>;
  /** The workspace's teams, to put it on one. */
  teams?: { slug: string; name: string }[];
  /** The Docs spaces the person editing can read, for its required reading. */
  spaces?: { id: string; name: string; kind: string }[];
  draft: AgentDraft;
  errors?: Record<string, string>;
  submit: string;
  intent: string;
  formKey?: string;
  /** Names to shuffle through (a template's `name_ideas`); the dice offers them. */
  nameIdeas?: string[];
  /** g1t, the orchestrator: its identity and job are fixed; the rest is editable. */
  locked?: boolean;
  /** The agent's own `avatar_seed`, once it has one; a new agent's face follows its handle. */
  seed?: string | null;
}) {
  const navigation = useNavigation();
  // The handle follows the name until someone edits it.
  const [name, setName] = useState(draft.display_name);
  const [handle, setHandle] = useState(draft.handle);
  const [handleEdited, setHandleEdited] = useState(Boolean(draft.handle) && cleanHandle(draft.display_name) !== draft.handle);
  const ideas = nameIdeas.length > 0 ? nameIdeas : FALLBACK_NAMES;
  const [idea, setIdea] = useState(() => Math.max(0, ideas.indexOf(draft.display_name)));
  const rename = (next: string) => {
    setName(next);
    if (!handleEdited) setHandle(cleanHandle(next));
  };
  const shuffle = () => {
    const at = (idea + 1) % ideas.length;
    setIdea(at);
    rename(ideas[at]!);
  };
  const { pathname } = useLocation();
  const busy = navigation.state === "submitting" && navigation.formAction === pathname;
  const [preset, setPreset] = useState(draft.personality_preset);
  const [advanced, setAdvanced] = useState(Boolean(draft.routing.pinned));
  const e = errors ?? {};
  const presetAbout = PRESETS.find((p) => p.value === preset)?.about;
  return (
    <Form method="post" key={formKey} className="pb-24">
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="template" value={draft.template ?? ""} />
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <FormSection
        title="Identity"
        about={
          locked
            ? "g1t is the workspace's orchestrator: its name, handle and role are the same everywhere, and it can't be archived."
            : "How it shows in chat, mentions, assignees and the audit log. Give it a name people will enjoy saying."
        }
      >
        <div className="flex items-center gap-3">
          <AgentAvatar agent={{ handle: handle || "agent", avatar_seed: seed ?? handle, builtin: locked }} size={44} />
          <div className="min-w-0 text-sm">
            <p className="truncate font-semibold">{name || "Your new agent"}</p>
            <p className="truncate text-xs text-muted">{handle ? `@${handle}` : "@handle"}</p>
          </div>
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <Label htmlFor="display_name" error={e.display_name}>
              Name
            </Label>
            <div className="flex gap-2">
              <input
                id="display_name"
                name="display_name"
                value={name}
                onChange={(event) => rename(event.target.value)}
                readOnly={locked}
                placeholder="Margo"
                className={`${FIELD} ${locked ? "cursor-not-allowed text-muted" : ""}`}
                autoComplete="off"
                data-1p-ignore
              />
              {!locked && (
                <Hint label="Another name">
                  <button
                    type="button"
                    aria-label="Another name"
                    onClick={shuffle}
                    className="flex size-[38px] shrink-0 items-center justify-center rounded-md border border-line text-muted transition-colors hover:border-line-strong hover:bg-raised hover:text-fg active:rotate-12"
                  >
                    <Dices size={17} />
                  </button>
                </Hint>
              )}
            </div>
          </div>
          <div>
            <Label htmlFor="handle" error={e.handle} hint="Mentioned as @handle">
              Handle
            </Label>
            <div className="flex items-center rounded-md border border-line bg-bg transition-colors focus-within:border-accent-dim hover:border-line-strong">
              <span className="pl-3 font-mono text-sm text-faint">@</span>
              <input
                id="handle"
                name="handle"
                value={handle}
                onChange={(event) => {
                  setHandle(event.target.value);
                  setHandleEdited(true);
                }}
                readOnly={locked}
                placeholder="margo"
                autoComplete="off"
                data-1p-ignore
                className="min-w-0 grow bg-transparent py-2 pr-3 pl-0.5 font-mono text-sm outline-none placeholder:text-faint"
              />
            </div>
          </div>
        </div>
      </FormSection>

      {!locked && (
      <FormSection
        title="Role"
        about="Hired into a role, not a task: a title, a team, and what it is responsible for. Shown as its name and title everywhere."
      >
        <RoleFields
          title={draft.title}
          team={draft.team}
          department={draft.department}
          responsibilities={draft.responsibilities}
          teams={teams}
          errors={e}
          locked={locked}
          personal={personal}
        />
      </FormSection>
      )}

      <FormSection
        title="Job"
        about={
          locked
            ? "Its job is fixed: know the team, hand work to the right specialist, do it itself when nobody fits, and report. Add your own instructions on top."
            : "What it is responsible for, how it works, and what good looks like. It reads this before every reply and task."
        }
      >
        <div>
          <Label htmlFor="instructions" error={e.instructions}>
            {locked ? "Extra instructions" : "Instructions"}
          </Label>
          <textarea
            id="instructions"
            name="instructions"
            defaultValue={draft.instructions}
            rows={9}
            placeholder={"Cut a release of g1t every Tuesday.\n- Read the merged pull requests since the last tag.\n- Write the release notes.\n- Ask in #releases before tagging."}
            className={`${FIELD} resize-y font-mono text-[0.8125rem] leading-relaxed`}
          />
        </div>
      </FormSection>

      <FormSection
        title="Required reading"
        about="Docs it checks first, every time it answers or works. It also recalls whatever else in Docs fits the question, but only from spaces everyone in the conversation can read."
      >
        {spaces.length ? (
          <div className="grid gap-1.5 sm:grid-cols-2">
            {spaces.map((space) => (
              <label
                key={space.id}
                className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 text-sm has-[:checked]:border-accent/50 has-[:checked]:bg-accent/5"
              >
                <input type="checkbox" name="reading" value={space.id} defaultChecked={(draft.reading ?? []).includes(space.id)} className="size-4 accent-[var(--color-accent)]" />
                <span className="min-w-0 grow truncate">{space.name}</span>
                <span className="shrink-0 text-xs text-faint capitalize">{space.kind}</span>
              </label>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">No Docs spaces yet. Once your workspace has some, choose what it should know by heart.</p>
        )}
        {(draft.reading ?? []).filter((id) => !spaces.some((space) => space.id === id)).map((id) => (
          // Spaces it reads that you can't see stay as they are.
          <input key={id} type="hidden" name="reading" value={id} />
        ))}
      </FormSection>

      {!locked && (
        <FormSection title="Subagents" about="Help it calls on for one kind of work inside its own tasks. Never members of the workspace, and never wider than the agent itself.">
          <SubagentsField initial={draft.subagents} routing={draft.routing} />
          {e.subagents && <p className="text-sm text-danger">{e.subagents}</p>}
        </FormSection>
      )}

      <FormSection title="Personality" about="Its voice only: tone, length, how it asks. A personality never changes what it may do.">
        <div>
          <input type="hidden" name="personality_preset" value={preset} />
          <div role="radiogroup" aria-label="Voice" className="grid grid-cols-2 gap-1 rounded-lg bg-surface p-1 ring-1 ring-line sm:grid-cols-4">
            {PRESETS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={preset === option.value}
                onClick={() => setPreset(option.value)}
                className={`h-8 rounded-md text-[0.8125rem] font-medium transition-colors ${
                  preset === option.value ? "bg-raised text-fg shadow-sm ring-1 ring-line-strong" : "text-muted hover:text-fg"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">{presetAbout}</p>
        </div>
        <div>
          <Label htmlFor="personality" hint="Optional">
            In its own words
          </Label>
          <textarea
            id="personality"
            name="personality"
            defaultValue={draft.personality}
            rows={3}
            placeholder="Dry humor is fine. No emoji. Asks one question at a time."
            className={`${FIELD} resize-y`}
          />
        </div>
      </FormSection>

      <FormSection
        title="Models"
        about="Nobody picks a model to get work done. g1t routes each step to the tier it needs and records which ran. These only limit the routing."
      >
        <div className="flex items-start gap-3 rounded-xl border border-accent/25 bg-accent/[0.06] p-4">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <RouteIcon size={16} />
          </span>
          <div>
            <p className="text-sm font-semibold">Auto: routed per step by need</p>
            <p className="mt-0.5 text-[0.8125rem] leading-relaxed text-muted">
              Replies and triage run on Fast; making changes on Standard; planning, hard reviews and retries after a failure on Most capable. It steps up after a failure and back down when the cheaper tier works.
            </p>
          </div>
        </div>
        <div className="grid gap-5 sm:grid-cols-3">
          <div>
            <Label htmlFor="floor">Floor</Label>
            <TierSelect name="floor" value={draft.routing.floor} none="No floor" />
          </div>
          <div>
            <Label htmlFor="ceiling" error={e.ceiling}>
              Ceiling
            </Label>
            <TierSelect name="ceiling" value={draft.routing.ceiling} none="No ceiling" />
          </div>
          <div>
            <Label htmlFor="providers">Providers</Label>
            <Select name="providers" defaultValue={draft.routing.providers[0] ?? "any"}>
              <SelectTrigger id="providers">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any" description="g1t's hosted models and the workspace's own">
                  Any the workspace allows
                </SelectItem>
                <SelectItem value="g1t" description="Never the workspace's own keys">
                  g1t's hosted models
                </SelectItem>
                <SelectItem value="workspace" description="Set up under Integrations; billed by the provider">
                  The workspace's own providers
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="rounded-lg border border-line">
          <button
            type="button"
            onClick={() => setAdvanced(!advanced)}
            aria-expanded={advanced}
            className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-[0.8125rem] font-medium text-muted hover:text-fg"
          >
            <ChevronRight size={14} className={`transition-transform ${advanced ? "rotate-90" : ""}`} />
            Advanced
            <span className="font-normal text-faint">Pin one model</span>
          </button>
          <div hidden={!advanced} className="border-t border-line px-3.5 py-3.5">
            <Label htmlFor="pinned" error={e.pinned} hint="For your own endpoints. Turns routing off.">
              Pinned model
            </Label>
            <input id="pinned" name="pinned" defaultValue={draft.routing.pinned ?? ""} placeholder="provider/model" className={`${FIELD} font-mono`} autoComplete="off" data-1p-ignore />
          </div>
        </div>
      </FormSection>

      <FormSection title="Budget" about="Checked before work starts and enforced while it runs. At 80% of the month it tells you; at 100% it takes no new tasks.">
        <div className="grid gap-5 sm:grid-cols-3">
          <Money name="monthly" label="Monthly" hint="Per calendar month" value={draft.budget.monthly_micros} error={e.monthly} />
          <Money name="daily" label="Daily" hint="Optional" value={draft.budget.daily_micros} error={e.daily} />
          <Money name="task" label="Per session" hint="Going over asks an owner" value={draft.budget.task_micros} error={e.task} />
        </div>
      </FormSection>

      <FormSection title="Autonomy" about="What it may do alone and what needs a person. Rulesets and branch protection still apply on top.">
        <div className="grid gap-5 sm:grid-cols-2">
          {(Object.keys(AUTONOMY) as (keyof typeof AUTONOMY)[]).map((key) => (
            <div key={key}>
              <Label htmlFor={key}>{AUTONOMY[key].label}</Label>
              <Select name={key} defaultValue={draft.autonomy[key]}>
                <SelectTrigger id={key}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AUTONOMY[key].options.map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      </FormSection>

      <FormSection title="Capacity" about="How many sessions it works on at once. More wait in line, queued.">
        <div className="max-w-40">
          <Label htmlFor="capacity" error={e.capacity}>
            Sessions at once
          </Label>
          <input id="capacity" name="capacity" type="number" min={1} max={20} defaultValue={draft.capacity} className={`${FIELD} tabular-nums`} />
        </div>
      </FormSection>

      <div className="sticky bottom-(--tabbar-h) in-data-[keyboard=open]:bottom-0 z-10 -mx-4 flex items-center justify-end gap-3 border-t border-line bg-bg/90 px-4 py-3 backdrop-blur sm:-mx-8 sm:px-8">
        {Object.keys(e).length > 0 && <p className="mr-auto text-sm text-danger">Check the fields marked above.</p>}
        <button
          type="submit"
          disabled={busy}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-bg transition-colors hover:bg-accent-hover disabled:opacity-60"
        >
          <Sparkles size={15} />
          {busy ? "Saving…" : submit}
        </button>
      </div>
    </Form>
  );
}
