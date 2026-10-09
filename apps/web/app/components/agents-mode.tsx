import { Activity, ChevronRight, Plus, Route as RouteIcon, Sparkles } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Form, NavLink, useLocation, useNavigation, useRouteLoaderData } from "react-router";

import type { AgentTemplate, ModelTier, WorkspaceAgent } from "@g1t/contracts";

import { AgentMark, StatusDot, statusLabel } from "./chat/marks";
import { Avatar } from "./ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Skeleton } from "./ui/skeleton";
import { AUTONOMY, type AgentDraft, PRESETS, TIER_LABELS, dollarsField } from "../lib/agent-form";
import type { AgentsLayoutData } from "../routes/workspace/agents/layout";

/** The workspace's agents while an Agents page is open; undefined elsewhere. */
export function useAgentsData(): AgentsLayoutData | undefined {
  return useRouteLoaderData("routes/workspace/agents/layout") as AgentsLayoutData | undefined;
}

/** An agent's face: its picture, or the sparkle mark. */
export function AgentFace({ agent, size = 20 }: { agent: Pick<WorkspaceAgent, "handle" | "avatar">; size?: number }) {
  return agent.avatar ? <Avatar name={agent.handle} image={agent.avatar} size={size} square /> : <AgentMark size={size} />;
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

/**
 * Agents mode's sidebar: who is working, who is waiting on you, and every
 * agent, each with its status; and the way to make a new one.
 */
export function AgentsSidebar({ slug }: { slug: string }) {
  const data = useAgentsData();
  const agents = data?.agents ?? [];
  const busy = agents.filter((a) => a.status === "working" || a.status === "waiting");
  const row = (agent: WorkspaceAgent) => (
    <li key={agent.id}>
      <NavLink
        to={`/${slug}/-/agents/${agent.handle}`}
        prefetch="intent"
        className={({ isActive }) =>
          `group flex h-11 items-center gap-2.5 rounded-md px-2 transition-colors ${isActive ? "bg-raised" : "hover:bg-raised/60"}`
        }
      >
        <span className="relative shrink-0">
          <AgentFace agent={agent} size={26} />
          <StatusDot status={agent.status} className="absolute -right-0.5 -bottom-0.5 ring-2 ring-[color-mix(in_srgb,var(--color-surface)_70%,var(--color-bg))]" />
        </span>
        <span className="min-w-0 grow leading-tight">
          <span className="block truncate text-[0.8125rem] font-medium text-fg">{agent.display_name}</span>
          <span className="block truncate text-[0.6875rem] text-faint">
            {agent.status === "idle" ? `@${agent.handle}` : statusLabel(agent.status)}
          </span>
        </span>
      </NavLink>
    </li>
  );
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-line pr-2.5 pl-4">
        <h2 className="text-[0.9375rem] font-semibold">Agents</h2>
        <NavLink
          to={`/${slug}/-/agents/new`}
          aria-label="New agent"
          className="flex size-8 items-center justify-center rounded-md text-faint transition-colors hover:bg-raised hover:text-fg"
        >
          <Plus size={16} />
        </NavLink>
      </div>
      <nav aria-label="Agents" className="min-h-0 grow overflow-y-auto px-2.5 pt-3 pb-4 [scrollbar-width:thin]">
        <div className="space-y-px">
          <SideLink to={`/${slug}/-/agents`} end icon={<Activity size={15} className="text-faint" />}>
            Fleet and runs
          </SideLink>
        </div>
        {!data ? (
          <div className="mt-5 space-y-3 px-2" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-2.5">
                <Skeleton className="size-6 rounded-md" />
                <Skeleton className="h-3 w-28" />
              </div>
            ))}
          </div>
        ) : data.agents == null ? (
          <p className="mt-4 px-2 text-xs leading-relaxed text-faint">The agents service didn't answer. Your agents will show here once it does.</p>
        ) : (
          <>
            {busy.length > 0 && (
              <Group title="At work">
                {busy.map(row)}
              </Group>
            )}
            <Group title={`All agents · ${agents.length}`}>
              {agents.map(row)}
              {agents.length === 0 && <li className="px-2 py-1 text-xs text-faint">None yet. Make one from a template.</li>}
            </Group>
          </>
        )}
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
      </nav>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className="mb-1 px-2 text-xs font-medium text-faint">{title}</h3>
      <ul className="space-y-px">{children}</ul>
    </section>
  );
}

/** The templates g1t ships, and a blank one, to start a new agent from. */
export function TemplateGallery({ templates, chosen, onChoose }: { templates: AgentTemplate[]; chosen: string | null; onChoose: (id: string | null) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {templates.map((template) => (
        <TemplateCard key={template.id} selected={chosen === template.id} onClick={() => onChoose(template.id)} title={template.display_name} handle={template.handle}>
          {template.role}
        </TemplateCard>
      ))}
      <TemplateCard selected={chosen === "blank"} onClick={() => onChoose("blank")} title="Blank agent" blank>
        Start from nothing: give it a name, a job and a voice.
      </TemplateCard>
    </div>
  );
}

function TemplateCard({
  selected,
  onClick,
  title,
  handle,
  blank,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  handle?: string;
  blank?: boolean;
  children: ReactNode;
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
      <span className="flex w-full items-center gap-2.5">
        {blank ? (
          <span className="flex size-9 items-center justify-center rounded-[10px] border border-dashed border-line-strong text-muted">
            <Plus size={16} />
          </span>
        ) : (
          <AgentMark size={36} />
        )}
        <span className="min-w-0 grow">
          <span className="block truncate text-sm font-semibold">{title}</span>
          {handle && <span className="block truncate font-mono text-xs text-faint">@{handle}</span>}
        </span>
        <ChevronRight size={15} className={`shrink-0 transition-colors ${selected ? "text-accent" : "text-faint group-hover:text-muted"}`} />
      </span>
      <span className="mt-3 line-clamp-2 text-[0.8125rem] leading-snug text-muted">{children}</span>
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
}: {
  draft: AgentDraft;
  errors?: Record<string, string>;
  submit: string;
  intent: string;
  formKey?: string;
}) {
  const navigation = useNavigation();
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
      <FormSection title="Identity" about="How it shows in chat, mentions, assignees and the audit log.">
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <Label htmlFor="display_name" error={e.display_name}>
              Display name
            </Label>
            <input id="display_name" name="display_name" defaultValue={draft.display_name} placeholder="Ship" className={FIELD} autoComplete="off" data-1p-ignore />
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
                defaultValue={draft.handle}
                placeholder="ship"
                autoComplete="off"
                data-1p-ignore
                className="min-w-0 grow bg-transparent py-2 pr-3 pl-0.5 font-mono text-sm outline-none placeholder:text-faint"
              />
            </div>
          </div>
        </div>
        <div>
          <Label htmlFor="role" error={e.role} hint="One line">
            Role
          </Label>
          <input id="role" name="role" defaultValue={draft.role} placeholder="Release manager for g1t" className={FIELD} autoComplete="off" data-1p-ignore />
        </div>
      </FormSection>

      <FormSection title="Job" about="What it is responsible for, how it works, and what good looks like. It reads this before every reply and task.">
        <div>
          <Label htmlFor="instructions" error={e.instructions}>
            Instructions
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
          <Money name="task" label="Per task" hint="Going over asks" value={draft.budget.task_micros} error={e.task} />
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

      <FormSection title="Capacity" about="How many tasks it works at once. More wait on its desk, each showing its place in line.">
        <div className="max-w-40">
          <Label htmlFor="capacity" error={e.capacity}>
            Tasks at once
          </Label>
          <input id="capacity" name="capacity" type="number" min={1} max={20} defaultValue={draft.capacity} className={`${FIELD} tabular-nums`} />
        </div>
      </FormSection>

      <div className="sticky bottom-0 z-10 -mx-4 flex items-center justify-end gap-3 border-t border-line bg-bg/90 px-4 py-3 backdrop-blur sm:-mx-8 sm:px-8">
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
