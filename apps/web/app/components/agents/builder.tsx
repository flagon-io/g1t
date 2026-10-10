/**
 * The agent builder (docs.g1t.sh/guides/agents/, "Describe it"): one box
 * for what the agent should do, the drafted agent as a card to edit, a test
 * chat beside it, and, on an agent's profile, a box to change it in words
 * with the change shown before it is saved.
 */
import { ArrowUp, Check, Dices, Lock, MessageSquare, Plug, RotateCcw, Shuffle, Sparkles, Users, Wand2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Form, Link, useFetcher, useNavigation } from "react-router";

import { type AgentProposal, type AgentRedraft, type AgentTemplate, type DraftTurn, FOUNDATIONAL_SKILLS, type WorkspaceAgent } from "@g1t/contracts";

import { AgentAvatar, PixelCreature } from "../agent-avatar";
import { Markdown } from "../markdown";
import { Badge } from "../ui/badge";
import { Hint } from "../ui/hint";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { type BuilderDefinition, type ChangeRow, changeRows, integrationHint } from "../../lib/agent-builder";
import { PRESETS, TIER_LABELS, cleanHandle, dollarsField, microsFromDollars } from "../../lib/agent-form";
import { cn } from "../../lib/cn";
import { money } from "../../lib/usage";

const FIELD =
  "w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim";
const PRIMARY = "inline-flex h-9 items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-bg transition-colors hover:bg-accent-hover disabled:opacity-60";
const QUIET =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-line px-3.5 text-sm font-medium text-fg/85 transition-colors hover:border-line-strong hover:bg-raised hover:text-fg disabled:opacity-60";

/** What the builder's actions answer. */
export type BuilderAnswer =
  | { intent: "draft"; ok: true; proposal: AgentProposal }
  | { intent: "try"; ok: true; text: string; charged_micros: number }
  | { intent: "redraft"; ok: true; redraft: AgentRedraft }
  | { intent: string; ok: false; error: string };

/** Things people ask agents to do, to start the box when it is empty. */
const EXAMPLES = [
  "Every Monday, read last week's merged pull requests and write release notes in our Releases space.",
  "Triage new bug reports: reproduce them from the steps, label them, and ask for what's missing.",
  "Keep me on top of my week: summarise what I'm mentioned in and what's waiting on me.",
  "Review database migrations for locking, data loss and missing indexes before they merge.",
];

// ── Describe it ───────────────────────────────────────────────────────────

/**
 * The first thing New agent shows: one box, "What should this agent do?",
 * the roles to start from under it, and the full form for those who want it.
 */
export function DescribeBox({
  slug,
  owner,
  mayCreate,
  templates,
  fetcher,
  initial,
}: {
  slug: string;
  owner: boolean;
  /** Whether the viewer may create an agent here at all. */
  mayCreate: boolean;
  templates: AgentTemplate[];
  fetcher: ReturnType<typeof useFetcher<BuilderAnswer>>;
  initial?: string;
}) {
  const [text, setText] = useState(initial ?? "");
  const [scope, setScope] = useState<"workspace" | "personal">(owner ? "workspace" : "personal");
  const busy = fetcher.state !== "idle";
  const error = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok && fetcher.data.intent === "draft" ? fetcher.data.error : null;
  return (
    <div>
      <fetcher.Form method="post" className="relative">
        <input type="hidden" name="intent" value="draft" />
        <input type="hidden" name="scope" value={scope} />
        <label htmlFor="description" className="sr-only">
          What should this agent do?
        </label>
        <div
          className={cn(
            "rounded-2xl border border-line bg-surface p-1.5 shadow-sm transition-colors focus-within:border-accent/60 focus-within:ring-4 focus-within:ring-accent/10",
            !mayCreate && "opacity-60",
          )}
        >
          <textarea
            id="description"
            name="description"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && text.trim().length >= 3) event.currentTarget.form?.requestSubmit();
            }}
            disabled={!mayCreate || busy}
            rows={4}
            maxLength={2000}
            placeholder="Describe the job: what it does, for whom, and what good looks like."
            className="block w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-base leading-relaxed outline-none placeholder:text-faint sm:text-[0.9375rem]"
          />
          <div className="flex flex-wrap items-center gap-2 px-1.5 pb-1">
            {owner ? (
              <div role="radiogroup" aria-label="Who it's for" className="flex rounded-lg bg-bg p-0.5 ring-1 ring-line">
                {(
                  [
                    ["workspace", "The workspace", <Users key="w" size={13} />],
                    ["personal", "Just me", <Lock key="p" size={13} />],
                  ] as const
                ).map(([value, label, icon]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={scope === value}
                    onClick={() => setScope(value)}
                    className={cn(
                      "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
                      scope === value ? "bg-raised text-fg shadow-sm ring-1 ring-line-strong" : "text-muted hover:text-fg",
                    )}
                  >
                    {icon}
                    {label}
                  </button>
                ))}
              </div>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted">
                <Lock size={12} />
                Your personal agent
              </span>
            )}
            <span className="grow" />
            <span className="hidden text-xs text-faint sm:inline">{busy ? "Drafting…" : "Ctrl+Enter"}</span>
            <button type="submit" disabled={!mayCreate || busy || text.trim().length < 3} className={cn(PRIMARY, "h-8 px-3")}>
              <Sparkles size={14} className={busy ? "animate-pulse motion-reduce:animate-none" : ""} />
              {busy ? "Drafting…" : "Draft it"}
            </button>
          </div>
        </div>
      </fetcher.Form>
      {error && <p className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-4 py-2.5 text-sm text-danger">{error}</p>}
      <p className="mt-3 text-xs leading-relaxed text-muted">
        {scope === "personal"
          ? "Only you can talk to it, in your direct message with it. It spends from your own budget: $20 a month and $2 a session to start."
          : "Everyone in the workspace can talk to it. It starts with the workspace's budget for a new agent."}{" "}
        Drafting is a quick model call charged to you; nothing is saved until you create it.
      </p>
      {!text && mayCreate && (
        <div className="mt-5">
          <p className="text-xs font-medium text-faint">For example</p>
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">
            {EXAMPLES.map((example) => (
              <li key={example}>
                <button
                  type="button"
                  onClick={() => setText(example)}
                  className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-left text-[0.8125rem] leading-snug text-muted transition-colors hover:border-line-strong hover:text-fg"
                >
                  {example}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {templates.length > 0 && (
        <div className="mt-8">
          <p className="text-xs font-medium text-faint">or start from a role</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {templates.map((template) => (
              <li key={template.id}>
                <Link
                  to={`?template=${encodeURIComponent(template.id)}`}
                  preventScrollReset
                  className="inline-flex h-8 items-center gap-2 rounded-full border border-line bg-surface pr-3 pl-1 text-[0.8125rem] text-fg/85 transition-colors hover:border-line-strong hover:text-fg"
                >
                  <PixelCreature seed={template.handle} size={24} className="rounded-full" />
                  {template.title}
                </Link>
              </li>
            ))}
            <li>
              <Link
                to="?template=blank"
                preventScrollReset
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-dashed border-line-strong px-3 text-[0.8125rem] text-muted transition-colors hover:text-fg"
              >
                Edit all fields
              </Link>
            </li>
          </ul>
          <p className="mt-3 text-xs text-faint">
            <Link to={`/${slug}/-/agents/templates`} className="hover:text-fg hover:underline">
              Read each role in full
            </Link>
          </p>
        </div>
      )}
    </div>
  );
}

// ── The drafted agent ─────────────────────────────────────────────────────

function Label({ htmlFor, children, hint }: { htmlFor?: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-3">
      <label htmlFor={htmlFor} className="text-xs font-medium text-fg-soft">
        {children}
      </label>
      {hint && <span className="text-xs text-faint">{hint}</span>}
    </div>
  );
}

function Section({ title, about, children }: { title: string; about?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-line px-4 py-4 sm:px-5">
      <h3 className="text-xs font-semibold tracking-wide text-faint uppercase">{title}</h3>
      {about && <p className="mt-1 text-xs text-muted">{about}</p>}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

/**
 * The drafted agent as a card to edit: who it is, its job, what it is
 * responsible for, its voice, the skills it keeps on, what it needs
 * connected, routines that would suit it, its model limits and budget.
 * Only the name and the job are required.
 */
export function ProposalCard({
  slug,
  owner,
  proposal,
  value,
  onChange,
}: {
  slug: string;
  owner: boolean;
  proposal: AgentProposal;
  value: BuilderDefinition;
  onChange: (next: BuilderDefinition) => void;
}) {
  const ideas = [proposal.definition.display_name, ...proposal.name_ideas];
  const [idea, setIdea] = useState(0);
  const [handleEdited, setHandleEdited] = useState(false);
  const set = (patch: Partial<BuilderDefinition>) => onChange({ ...value, ...patch });
  const rename = (name: string) => set({ display_name: name, ...(handleEdited ? {} : { handle: cleanHandle(name) }) });
  const off = new Set(value.skills_off ?? []);
  const suggested = new Set(proposal.skills);
  const hints = proposal.integrations.map((s) => integrationHint(slug, s, owner)).filter((h) => h !== null);
  const seed = value.avatar_seed || value.handle || "agent";
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface">
      <div className="flex items-start gap-3 px-4 pt-4 pb-4 sm:px-5">
        <div className="relative shrink-0">
          <AgentAvatar agent={{ handle: value.handle, avatar_seed: seed }} size={56} />
          <Hint label="Another face">
            <button
              type="button"
              aria-label="Another face"
              onClick={() => set({ avatar_seed: `${value.handle || "agent"}-${Math.random().toString(36).slice(2, 7)}` })}
              className="absolute -right-1.5 -bottom-1.5 flex size-6 items-center justify-center rounded-full border border-line bg-bg text-muted shadow-sm transition-colors hover:text-fg"
            >
              <Dices size={13} />
            </button>
          </Hint>
        </div>
        <div className="grid min-w-0 grow gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
          <div>
            <Label htmlFor="b-name">Name</Label>
            <div className="flex gap-1.5">
              <input id="b-name" value={value.display_name} onChange={(e) => rename(e.target.value)} className={FIELD} autoComplete="off" data-1p-ignore required />
              {ideas.length > 1 && (
                <Hint label="Another name">
                  <button
                    type="button"
                    aria-label="Another name"
                    onClick={() => {
                      const next = (idea + 1) % ideas.length;
                      setIdea(next);
                      rename(ideas[next]!);
                    }}
                    className="flex size-9.5 shrink-0 items-center justify-center rounded-md border border-line text-muted transition-colors hover:border-line-strong hover:bg-raised hover:text-fg"
                  >
                    <Shuffle size={15} />
                  </button>
                </Hint>
              )}
            </div>
          </div>
          <div>
            <Label htmlFor="b-handle">Handle</Label>
            <div className="flex items-center rounded-md border border-line bg-bg transition-colors focus-within:border-accent-dim hover:border-line-strong">
              <span className="pl-3 font-mono text-sm text-faint">@</span>
              <input
                id="b-handle"
                value={value.handle}
                onChange={(e) => {
                  setHandleEdited(true);
                  set({ handle: e.target.value });
                }}
                className="min-w-0 grow bg-transparent py-2 pr-3 pl-0.5 font-mono text-sm outline-none"
                autoComplete="off"
                data-1p-ignore
              />
            </div>
          </div>
          <div>
            <Label htmlFor="b-title">Title</Label>
            <input id="b-title" value={value.title ?? ""} onChange={(e) => set({ title: e.target.value })} placeholder="Release Manager" className={FIELD} autoComplete="off" />
          </div>
          <div>
            <Label htmlFor="b-department" hint="Optional">
              Department
            </Label>
            <input id="b-department" value={value.department ?? ""} onChange={(e) => set({ department: e.target.value })} placeholder="Engineering" className={FIELD} autoComplete="off" />
          </div>
        </div>
      </div>

      <Section title="Job" about="What it is responsible for and how it works. It reads this before every reply.">
        <textarea
          aria-label="Job"
          value={value.instructions}
          onChange={(e) => set({ instructions: e.target.value })}
          rows={8}
          required
          className={`${FIELD} resize-y font-mono text-[0.8125rem] leading-relaxed`}
        />
        <div>
          <Label htmlFor="b-duties" hint="One a line, 2 to 8">
            Responsibilities
          </Label>
          <textarea
            id="b-duties"
            value={(value.responsibilities ?? []).join("\n")}
            onChange={(e) => set({ responsibilities: e.target.value.split("\n").slice(0, 8) })}
            onBlur={() => set({ responsibilities: (value.responsibilities ?? []).map((d) => d.trim()).filter(Boolean) })}
            rows={Math.max(3, (value.responsibilities ?? []).length)}
            className={`${FIELD} resize-y`}
          />
        </div>
      </Section>

      <Section title="Personality" about="Its voice only. A personality never changes what it may do.">
        <div role="radiogroup" aria-label="Voice" className="grid grid-cols-2 gap-1 rounded-lg bg-bg p-1 ring-1 ring-line sm:grid-cols-4">
          {PRESETS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={value.personality_preset === option.value}
              onClick={() => set({ personality_preset: option.value })}
              className={cn(
                "h-8 rounded-md text-[0.8125rem] font-medium transition-colors",
                value.personality_preset === option.value ? "bg-raised text-fg shadow-sm ring-1 ring-line-strong" : "text-muted hover:text-fg",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        <input aria-label="In its own words" value={value.personality ?? ""} onChange={(e) => set({ personality: e.target.value })} placeholder="In its own words (optional)" className={FIELD} />
      </Section>

      <Section title="Skills" about="g1t's playbooks it keeps on. The suggested ones fit its job; turn any on or off.">
        <div className="grid gap-1.5 sm:grid-cols-2">
          {FOUNDATIONAL_SKILLS.map((skill) => {
            const on = !off.has(skill.id);
            return (
              <label
                key={skill.id}
                className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg border border-line bg-bg px-3 py-2 text-sm has-checked:border-accent/50 has-checked:bg-accent/5"
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => {
                    const next = new Set(off);
                    if (on) next.add(skill.id);
                    else next.delete(skill.id);
                    set({ skills_off: FOUNDATIONAL_SKILLS.map((s) => s.id).filter((id) => next.has(id)) });
                  }}
                  className="size-4 accent-(--color-accent)"
                />
                <span className="min-w-0 grow truncate">{skill.name}</span>
                {suggested.has(skill.id) && suggested.size < FOUNDATIONAL_SKILLS.length && (
                  <Badge tone="accent" className="shrink-0">
                    Suggested
                  </Badge>
                )}
              </label>
            );
          })}
        </div>
      </Section>

      {hints.length > 0 && (
        <Section title="What it needs connected" about="Integrations its job would use. It works without them, and says so when asked for something that needs one.">
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-bg">
            {hints.map((hint) => (
              <li key={hint.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
                <Plug size={14} className="shrink-0 text-faint" />
                <span className="min-w-0 grow basis-40">
                  <span className="block text-sm font-medium">{hint.name}</span>
                  {hint.why && <span className="block text-xs text-muted">{hint.why}</span>}
                </span>
                {hint.action === "soon" ? (
                  <Badge>Soon</Badge>
                ) : (
                  <Link to={hint.href} target="_blank" rel="noreferrer" className="text-xs font-medium text-accent hover:underline">
                    {hint.action === "connect" ? "Connect" : "Ask an owner"}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {proposal.routines.length > 0 && (
        <Section
          title="Routines that would suit it"
          about={value.scope === "personal" ? "Personal agents can't run routines yet. An owner can promote it to a workspace agent, which can." : "Set them up on its Routines tab once it exists."}
        >
          <ul className="space-y-2">
            {proposal.routines.map((routine) => (
              <li key={routine.name} className="rounded-lg border border-line bg-bg px-3 py-2.5">
                <p className="text-sm font-medium">
                  {routine.name} <span className="font-normal text-muted">· {routine.when}</span>
                </p>
                {routine.instructions && <p className="mt-0.5 text-xs text-muted">{routine.instructions}</p>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Models and budget" about="g1t routes each step to the tier it needs; these only limit it. Budgets are checked before work starts.">
        <div className="grid gap-3 sm:grid-cols-2">
          {(["floor", "ceiling"] as const).map((key) => (
            <div key={key}>
              <Label htmlFor={`b-${key}`}>{key === "floor" ? "Floor" : "Ceiling"}</Label>
              <Select
                value={value.routing?.[key] ?? "none"}
                onValueChange={(tier) =>
                  set({ routing: { floor: null, ceiling: null, providers: [], pinned: null, ...value.routing, [key]: tier === "none" ? null : (tier as "small") } })
                }
              >
                <SelectTrigger id={`b-${key}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{key === "floor" ? "No floor" : "No ceiling"}</SelectItem>
                  {(["small", "large", "frontier"] as const).map((tier) => (
                    <SelectItem key={tier} value={tier} description={TIER_LABELS[tier].split(": ")[1]}>
                      {TIER_LABELS[tier].split(":")[0]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
          {(
            [
              ["monthly_micros", "Monthly"],
              ["task_micros", "Per session"],
            ] as const
          ).map(([key, label]) => (
            <div key={key}>
              <Label htmlFor={`b-${key}`} hint={key === "monthly_micros" ? "Per calendar month" : "Going over asks you"}>
                {label}
              </Label>
              <div className="flex items-center rounded-md border border-line bg-bg transition-colors focus-within:border-accent-dim hover:border-line-strong">
                <span className="pl-3 text-sm text-faint">$</span>
                <input
                  id={`b-${key}`}
                  inputMode="decimal"
                  defaultValue={dollarsField(value.budget?.[key])}
                  onBlur={(e) => {
                    const micros = microsFromDollars(e.target.value);
                    set({ budget: { ...value.budget, [key]: micros == null || Number.isNaN(micros) ? null : micros } });
                  }}
                  placeholder="No cap"
                  className="min-w-0 grow bg-transparent px-2 py-2 text-sm tabular-nums outline-none placeholder:text-faint"
                  autoComplete="off"
                  data-1p-ignore
                />
              </div>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

// ── Try it ────────────────────────────────────────────────────────────────

/**
 * A test chat with the drafted agent, as it is in the card right now:
 * charged to the person trying it, and nothing kept once they leave.
 */
export function TryChat({ definition, onReset }: { definition: BuilderDefinition; onReset?: () => void }) {
  const fetcher = useFetcher<BuilderAnswer>({ key: "agent-try" });
  const [turns, setTurns] = useState<DraftTurn[]>([]);
  const [text, setText] = useState("");
  const [spent, setSpent] = useState(0);
  const handled = useRef<unknown>(null);
  const log = useRef<HTMLDivElement>(null);
  const busy = fetcher.state !== "idle";
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || handled.current === fetcher.data) return;
    handled.current = fetcher.data;
    if (fetcher.data.ok && fetcher.data.intent === "try") {
      const answer = fetcher.data;
      setTurns((now) => [...now, { role: "assistant", content: answer.text }]);
      setSpent((n) => n + answer.charged_micros);
    }
  }, [fetcher.state, fetcher.data]);
  // The newest message in view, scrolling only the conversation, never the page.
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [turns.length, busy]);
  const error = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok && fetcher.data.intent === "try" ? fetcher.data.error : null;
  const send = () => {
    const body = text.trim();
    if (!body || busy) return;
    const next: DraftTurn[] = [...turns, { role: "user", content: body }];
    setTurns(next);
    setText("");
    fetcher.submit({ intent: "try", definition: JSON.stringify(definition), messages: JSON.stringify(next.slice(-24)) }, { method: "post" });
  };
  const name = definition.display_name || "your agent";
  return (
    <div className="flex h-full min-h-104 flex-col overflow-hidden rounded-2xl border border-line bg-surface">
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <MessageSquare size={15} className="text-faint" />
        <div className="min-w-0 grow">
          <p className="text-sm font-semibold">Try it</p>
          <p className="truncate text-xs text-muted">Talk to {name} as it is drafted. Charged to you; nothing is saved.</p>
        </div>
        {turns.length > 0 && (
          <Hint label="Start over">
            <button
              type="button"
              aria-label="Start over"
              onClick={() => {
                setTurns([]);
                onReset?.();
              }}
              className="flex size-8 items-center justify-center rounded-md text-faint transition-colors hover:bg-raised hover:text-fg"
            >
              <RotateCcw size={14} />
            </button>
          </Hint>
        )}
      </div>
      <div ref={log} className="min-h-0 grow space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
        {turns.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center py-8 text-center">
            <AgentAvatar agent={{ handle: definition.handle, avatar_seed: definition.avatar_seed || definition.handle }} size={40} />
            <p className="mt-3 text-sm font-medium">Ask {name} something it would get asked</p>
            <p className="mt-1 max-w-xs text-xs text-muted">It answers from its job and voice. It has no tools or memory until you create it.</p>
          </div>
        )}
        {turns.map((turn, at) =>
          turn.role === "user" ? (
            <div key={at} className="flex justify-end">
              <p className="max-w-[85%] rounded-2xl rounded-br-md bg-accent/15 px-3.5 py-2 text-sm whitespace-pre-wrap text-fg">{turn.content}</p>
            </div>
          ) : (
            <div key={at} className="flex gap-2.5">
              <AgentAvatar agent={{ handle: definition.handle, avatar_seed: definition.avatar_seed || definition.handle }} size={24} />
              <div className="min-w-0 grow text-sm [&_.prose]:text-sm">
                <Markdown source={turn.content} />
              </div>
            </div>
          ),
        )}
        {busy && (
          <div className="flex items-center gap-2.5 text-xs text-muted">
            <AgentAvatar agent={{ handle: definition.handle, avatar_seed: definition.avatar_seed || definition.handle }} size={24} />
            {name} is typing…
          </div>
        )}
        {error && <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
      </div>
      <form
        className="flex items-end gap-2 border-t border-line p-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <label htmlFor="try-message" className="sr-only">
          Message {name}
        </label>
        <textarea
          id="try-message"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
          maxLength={4000}
          placeholder={`Message ${name}`}
          className="max-h-32 min-h-9 min-w-0 grow resize-none rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-accent-dim"
        />
        <button type="submit" aria-label="Send" disabled={busy || !text.trim()} className={cn(PRIMARY, "size-9 shrink-0 px-0")}>
          <ArrowUp size={16} />
        </button>
      </form>
      {spent > 0 && <p className="border-t border-line px-4 py-1.5 text-[0.6875rem] text-faint tabular-nums">Trying it has cost you {money(spent)} so far.</p>}
    </div>
  );
}

// ── Create ────────────────────────────────────────────────────────────────

/** Saves the drafted agent: its hello is waiting in a direct message. */
export function CreateDraft({ definition, onEditAll }: { definition: BuilderDefinition; onEditAll: () => void }) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formData?.get("intent") === "create_draft";
  const ready = definition.display_name.trim() && definition.instructions.trim() && definition.handle.trim();
  return (
    <Form method="post" className="flex flex-wrap items-center justify-end gap-2">
      <input type="hidden" name="intent" value="create_draft" />
      <input type="hidden" name="definition" value={JSON.stringify(definition)} />
      <button type="button" onClick={onEditAll} className={QUIET}>
        Edit all fields
      </button>
      <button type="submit" disabled={busy || !ready} className={PRIMARY}>
        <Check size={15} />
        {busy ? "Creating…" : `Create ${definition.display_name.trim() || "agent"}`}
      </button>
    </Form>
  );
}

// ── Change it in words ────────────────────────────────────────────────────

/**
 * "Tell <name> what to change": the change is drafted, shown field by
 * field with the job as a diff, and saved as a new version only when the
 * person says so.
 */
export function RedraftBox({ agent }: { agent: WorkspaceAgent }) {
  const fetcher = useFetcher<BuilderAnswer>({ key: `redraft:${agent.id}` });
  const save = useFetcher<{ ok?: boolean; saved?: boolean; errors?: Record<string, string> }>({ key: `redraft-save:${agent.id}` });
  const [text, setText] = useState("");
  const [shown, setShown] = useState<AgentRedraft | null>(null);
  const handled = useRef<unknown>(null);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || handled.current === fetcher.data) return;
    handled.current = fetcher.data;
    if (fetcher.data.ok && fetcher.data.intent === "redraft") setShown(fetcher.data.redraft);
  }, [fetcher.state, fetcher.data]);
  useEffect(() => {
    if (save.state === "idle" && save.data?.saved) {
      setShown(null);
      setText("");
    }
  }, [save.state, save.data]);
  const busy = fetcher.state !== "idle";
  const error = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok && fetcher.data.intent === "redraft" ? fetcher.data.error : null;
  const saveError = save.state === "idle" && save.data && !save.data.saved ? (save.data.errors?.form ?? save.data.errors?.handle ?? null) : null;
  const skillName = (id: string) => FOUNDATIONAL_SKILLS.find((s) => s.id === id)?.name ?? id;
  const rows = shown ? changeRows(agent, shown.changes, skillName) : [];
  return (
    <section aria-labelledby="redraft" className="mb-10 rounded-2xl border border-line bg-surface">
      <fetcher.Form method="post" className="p-4 sm:p-5">
        <input type="hidden" name="intent" value="redraft" />
        <h2 id="redraft" className="flex items-center gap-2 text-sm font-semibold">
          <Wand2 size={15} className="text-accent" />
          Tell {agent.display_name} what to change
        </h2>
        <p className="mt-1 text-xs text-muted">Say it in your own words. You'll see the change before it's saved as version {agent.version + 1}. Drafting it is charged to you.</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
          <label htmlFor="redraft-request" className="sr-only">
            What should change
          </label>
          <textarea
            id="redraft-request"
            name="request"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim().length >= 3) e.currentTarget.form?.requestSubmit();
            }}
            rows={2}
            maxLength={1000}
            placeholder={`Answer in Spanish, and keep replies under five sentences`}
            className={`${FIELD} grow resize-y`}
          />
          <button type="submit" disabled={busy || text.trim().length < 3} className={cn(PRIMARY, "shrink-0")}>
            <Sparkles size={14} className={busy ? "animate-pulse motion-reduce:animate-none" : ""} />
            {busy ? "Drafting…" : "Draft the change"}
          </button>
        </div>
        {error && <p className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
      </fetcher.Form>
      {shown && (
        <div className="border-t border-line p-4 sm:p-5">
          <p className="text-sm">
            <span className="font-medium">{shown.summary}</span>{" "}
            <span className="text-muted">
              {rows.length} {rows.length === 1 ? "change" : "changes"} to version {shown.from_version}.
            </span>
          </p>
          <ChangeList rows={rows} />
          {saveError && <p className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{saveError}</p>}
          <save.Form method="post" className="mt-4 flex flex-wrap items-center justify-end gap-2">
            <input type="hidden" name="intent" value="apply" />
            <input type="hidden" name="changes" value={JSON.stringify(shown.changes)} />
            <input type="hidden" name="from_version" value={shown.from_version} />
            <button type="button" onClick={() => setShown(null)} className={QUIET}>
              Discard
            </button>
            <button type="submit" disabled={save.state !== "idle"} className={PRIMARY}>
              <Check size={15} />
              {save.state !== "idle" ? "Saving…" : `Save as version ${agent.version + 1}`}
            </button>
          </save.Form>
        </div>
      )}
    </section>
  );
}

/** Each field a change touches, before and after; the job and duties as a line diff. */
export function ChangeList({ rows }: { rows: ChangeRow[] }) {
  return (
    <dl className="mt-3 divide-y divide-line overflow-hidden rounded-lg border border-line bg-bg">
      {rows.map((row) => (
        <div key={row.field} className="px-3 py-2.5">
          <dt className="text-xs font-medium text-faint">{row.label}</dt>
          {row.lines ? (
            <dd className="mt-1.5 max-h-80 overflow-auto rounded-md border border-line font-mono text-[0.75rem] leading-relaxed">
              {row.lines.map((line, at) => (
                <div
                  key={at}
                  className={cn(
                    "flex gap-2 px-2 whitespace-pre-wrap",
                    line.kind === "added" && "bg-success/10 text-success",
                    line.kind === "removed" && "bg-danger/10 text-danger line-through decoration-danger/40",
                    line.kind === "same" && "text-muted",
                  )}
                >
                  <span aria-hidden="true" className="w-3 shrink-0 select-none">
                    {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
                  </span>
                  <span className="sr-only">{line.kind === "added" ? "Added: " : line.kind === "removed" ? "Removed: " : ""}</span>
                  <span className="min-w-0">{line.text || " "}</span>
                </div>
              ))}
            </dd>
          ) : (
            <dd className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
              <span className="text-muted line-through decoration-line-strong">{row.before}</span>
              <span aria-hidden="true" className="text-faint">
                →
              </span>
              <span className="sr-only">becomes</span>
              <span className="font-medium text-fg">{row.after}</span>
            </dd>
          )}
        </div>
      ))}
    </dl>
  );
}

/** Whose personal agent it is, and, for owners, making it the workspace's. */
export function PersonalNotice({ agent, owner, mine }: { agent: WorkspaceAgent; owner: boolean; mine: boolean }) {
  const navigation = useNavigation();
  const [asking, setAsking] = useState(false);
  const busy = navigation.state !== "idle" && navigation.formData?.get("intent") === "promote";
  return (
    <section aria-labelledby="personal" className="mb-10 rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <h2 id="personal" className="flex items-center gap-2 text-sm font-semibold">
        <Lock size={14} className="text-faint" />
        {mine ? "Your personal agent" : `@${agent.personal_owner ?? "a member"}'s personal agent`}
      </h2>
      <p className="mt-1 text-sm text-muted">
        {mine
          ? "Only you can talk to it, in your direct message with it, and it spends from your budget. It isn't in channels, and other agents don't hand it work."
          : `Only @${agent.personal_owner ?? "its member"} talks to it, and it spends from their budget. As an owner you can archive it, or make it a workspace agent everyone can talk to.`}
      </p>
      {owner && (
        <div className="mt-4">
          {asking ? (
            <Form method="post" className="space-y-3">
              <input type="hidden" name="intent" value="promote" />
              <p className="text-sm text-fg-soft">
                {agent.display_name} becomes a workspace agent with the same handle, job and every version so far. What it remembers from{" "}
                {mine ? "your" : `@${agent.personal_owner}'s`} direct messages stays behind with the personal agent, which is archived.
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="submit" disabled={busy} className={PRIMARY}>
                  <Users size={14} />
                  {busy ? "Promoting…" : `Promote ${agent.display_name}`}
                </button>
                <button type="button" onClick={() => setAsking(false)} className={QUIET}>
                  Cancel
                </button>
              </div>
            </Form>
          ) : (
            <button type="button" onClick={() => setAsking(true)} className={QUIET}>
              <Users size={14} />
              Promote to a workspace agent…
            </button>
          )}
        </div>
      )}
    </section>
  );
}
