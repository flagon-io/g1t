/**
 * The context hub, as the workspace's Context page and a project's Memory
 * page show it: the catalog and its relations, one search over everything,
 * scorecards whose failing rules become issues for an agent, and the
 * Review queue of memory candidates (keep, edit, dismiss). Pages post to
 * their own action with the intents in `reviewAction` and `contextAction`.
 */
import {
  Bot,
  Boxes,
  Check,
  CircleDashed,
  FileText,
  Globe,
  Languages,
  Package,
  Pencil,
  Plug,
  Search,
  Server,
  Sparkles,
  User,
  Webhook,
  X,
  XCircle,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Form, Link, useFetcher, useNavigation } from "react-router";

import {
  ENTITY_KINDS,
  MEMORY_KINDS,
  type Catalog,
  type Entity,
  type EntityKind,
  type Memory,
  type MemoryKind,
  type MemoryReviewApi,
  type Result,
  type RuleResult,
  type Scorecard,
  type SearchHit,
  type SearchResult,
  type User as Actor,
} from "@g1t/contracts";

import { InlineMarkdown } from "./inline-markdown";
import { SubmitButton, TimeAgo } from "./ui";
import { Hint } from "./ui/hint";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

type Done = { ok: boolean; error?: string; message?: string } | undefined;

export const KIND_LABEL: Record<EntityKind, string> = {
  project: "Projects",
  app: "Apps",
  api: "APIs",
  package: "Packages",
  language: "Languages",
  owner: "Owners",
  environment: "Environments",
  integration: "Integrations",
  doc: "Docs",
};

const KIND_ICON: Record<string, ReactNode> = {
  project: <Boxes size={14} />,
  app: <Server size={14} />,
  api: <Webhook size={14} />,
  package: <Package size={14} />,
  language: <Languages size={14} />,
  owner: <User size={14} />,
  environment: <Globe size={14} />,
  integration: <Plug size={14} />,
  doc: <FileText size={14} />,
  memory: <Sparkles size={14} />,
  issue: <CircleDashed size={14} />,
  pull: <Bot size={14} />,
};

const TEXTAREA =
  "w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim";

// --- Review queue -------------------------------------------------------------

/** Where a candidate came from, in words, linked where it can be. */
function CandidateSource({ memory }: { memory: Memory }) {
  const { source } = memory;
  const repo = source.repo;
  const on = repo && source.number != null ? (
    <Link to={`/${repo.namespace}/${repo.name}/pull/${source.number}`} className="hover:text-fg">
      {repo.name}#{source.number}
    </Link>
  ) : null;
  const path = source.reference?.startsWith("doc:") ? source.reference.split(":").slice(2).join(":") : null;
  const label =
    source.kind === "doc" ? (
      <>from {repo ? <Link to={`/${repo.namespace}/${repo.name}/blob/HEAD/${path}`} className="hover:text-fg">{path}</Link> : path}</>
    ) : source.kind === "review" ? (
      <>from a review on {on}</>
    ) : source.kind === "pr" ? (
      <>from merging {on}</>
    ) : source.kind === "run" ? (
      <>
        learned by{" "}
        {source.runId && repo ? (
          <Link to={`/${repo.namespace}/${repo.name}/agents/runs/${source.runId}`} className="hover:text-fg">
            an agent run
          </Link>
        ) : (
          "an agent run"
        )}
        {on && <> on {on}</>}
      </>
    ) : (
      <>added by {memory.createdBy}</>
    );
  return <span>{label}</span>;
}

function KindSelect({ value }: { value: MemoryKind }) {
  return (
    <Select name="kind" defaultValue={value}>
      <SelectTrigger size="sm" className="w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {MEMORY_KINDS.map((kind) => (
          <SelectItem key={kind} value={kind}>
            {kind[0].toUpperCase() + kind.slice(1)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function EditAndKeep({ memory, action }: { memory: Memory; action: string }) {
  const fetcher = useFetcher<Done>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) setOpen(false);
  }, [fetcher.state, fetcher.data]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-muted hover:border-line-strong hover:text-fg">
        <Pencil size={12} />
        Edit
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit and keep</DialogTitle>
          <DialogDescription>Agents are given the kept wording from their next run on.</DialogDescription>
        </DialogHeader>
        <fetcher.Form method="post" action={action} className="space-y-3">
          <input type="hidden" name="intent" value="keep" />
          <input type="hidden" name="id" value={memory.id} />
          <textarea name="text" required rows={4} maxLength={1000} defaultValue={memory.text} className={TEXTAREA} />
          <div className="flex items-center justify-between gap-3">
            <KindSelect value={memory.kind} />
            <SubmitButton fetcher={fetcher} pending="Keeping…">
              Keep
            </SubmitButton>
          </div>
          {fetcher.data?.error && <p className="text-sm text-danger">{fetcher.data.error}</p>}
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

function Candidate({ memory, action }: { memory: Memory; action: string }) {
  const fetcher = useFetcher<Done>();
  const decided = fetcher.formData?.get("intent");
  if (decided === "keep" || decided === "dismiss") return null;
  return (
    <li className="flex gap-3 px-4 py-3">
      <div className="min-w-0 grow">
        <div className="flex flex-wrap items-center gap-2 text-[0.6875rem] text-muted">
          <span className="rounded-full border border-line px-2 py-px">{memory.kind}</span>
          <span>{memory.scope === "workspace" ? "every project" : memory.repo ? memory.repo.name : "this project"}</span>
          {(memory.seen ?? 1) > 1 && <span>seen {memory.seen} times</span>}
          {memory.confidence != null && <span>{Math.round(memory.confidence * 100)}% sure</span>}
        </div>
        <p className="mt-1.5 text-sm whitespace-pre-wrap wrap-break-word">{memory.text}</p>
        {memory.source.evidence && (
          <p className="mt-1 border-l-2 border-line pl-2 text-xs text-muted whitespace-pre-wrap wrap-break-word">{memory.source.evidence}</p>
        )}
        <p className="mt-1.5 flex flex-wrap gap-x-3 text-xs text-faint">
          <CandidateSource memory={memory} />
          <span>
            <TimeAgo at={memory.updatedAt} />
          </span>
        </p>
        {fetcher.data?.error && <p className="mt-1.5 text-xs text-danger">{fetcher.data.error}</p>}
      </div>
      <div className="flex shrink-0 items-start gap-1.5">
        <button
          type="button"
          onClick={() => fetcher.submit({ intent: "keep", id: memory.id }, { method: "post", action })}
          className="inline-flex items-center gap-1 rounded-md bg-fg px-2 py-1 text-xs font-medium text-bg hover:bg-fg-hover"
        >
          <Check size={12} />
          Keep
        </button>
        <EditAndKeep memory={memory} action={action} />
        <Hint label="Dismiss: never suggested again in these words">
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => fetcher.submit({ intent: "dismiss", id: memory.id }, { method: "post", action })}
            className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-muted hover:border-line-strong hover:text-danger"
          >
            <X size={12} />
            Dismiss
          </button>
        </Hint>
      </div>
    </li>
  );
}

/** Memory candidates waiting for a person: keep, edit and keep, or dismiss. */
export function ReviewQueue({ candidates, action, empty }: { candidates: Memory[]; action: string; empty: string }) {
  if (candidates.length === 0) {
    return <p className="rounded-xl border border-dashed border-line px-4 py-6 text-sm text-muted">{empty}</p>;
  }
  return (
    <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
      {candidates.map((memory) => (
        <Candidate key={memory.id} memory={memory} action={action} />
      ))}
    </ul>
  );
}

/** The intents of the Review queue: keep (with an edit, or as it is) and dismiss. Null for other intents. */
export async function reviewAction(api: MemoryReviewApi, actor: Actor, workspace: string, form: FormData): Promise<Done | null> {
  const intent = String(form.get("intent") ?? "");
  if (intent !== "keep" && intent !== "dismiss") return null;
  const text = form.get("text");
  const kind = String(form.get("kind") ?? "");
  const reviewed = await api.reviewMemory(actor, workspace, String(form.get("id") ?? ""), intent, {
    text: text == null ? undefined : String(text),
    kind: MEMORY_KINDS.includes(kind as MemoryKind) ? (kind as MemoryKind) : undefined,
  });
  return reviewed.ok ? { ok: true } : { ok: false, error: reviewed.error.message };
}

// --- Catalog ------------------------------------------------------------------

/**
 * The projects and how they depend on each other, drawn in a circle; a
 * project's owners and apps hang off it. Small workspaces only: past 24
 * projects the list says it all.
 */
export function RelationsGraph({ catalog }: { catalog: Catalog }) {
  const projects = catalog.entities.filter((entity) => entity.kind === "project").slice(0, 24);
  if (projects.length < 2) return null;
  const size = 420;
  const center = size / 2;
  const radius = size / 2 - 60;
  const at = new Map(
    projects.map((project, i) => {
      const angle = (2 * Math.PI * i) / projects.length - Math.PI / 2;
      return [project.id, { x: center + radius * Math.cos(angle), y: center + radius * Math.sin(angle), project }];
    }),
  );
  const edges = catalog.relations.filter((relation) => relation.kind === "depends_on" && at.has(relation.from) && at.has(relation.to));
  return (
    <figure className="rounded-xl border border-line bg-surface p-3">
      <svg viewBox={`0 0 ${size} ${size}`} className="mx-auto block h-auto w-full max-w-md" role="img" aria-label="How the workspace's projects depend on each other">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted" />
          </marker>
        </defs>
        {edges.map((edge) => {
          const from = at.get(edge.from)!;
          const to = at.get(edge.to)!;
          const dx = to.x - from.x;
          const dy = to.y - from.y;
          const length = Math.hypot(dx, dy) || 1;
          const pad = 26;
          return (
            <line
              key={`${edge.from}-${edge.to}`}
              x1={from.x + (dx / length) * pad}
              y1={from.y + (dy / length) * pad}
              x2={to.x - (dx / length) * pad}
              y2={to.y - (dy / length) * pad}
              className="stroke-muted"
              strokeWidth={1.25}
              markerEnd="url(#arrow)"
            />
          );
        })}
        {[...at.values()].map(({ x, y, project }) => (
          <g key={project.id}>
            <circle cx={x} cy={y} r={20} className="fill-bg stroke-accent" strokeWidth={1.5} />
            <text x={x} y={y + 36} textAnchor="middle" className="fill-fg text-[11px]">
              {project.name.length > 16 ? `${project.name.slice(0, 15)}…` : project.name}
            </text>
            <text x={x} y={y + 4} textAnchor="middle" className="fill-accent text-[11px] font-semibold">
              {project.name[0]?.toUpperCase()}
            </text>
          </g>
        ))}
      </svg>
      <figcaption className="mt-1 text-center text-xs text-faint">An arrow points from a project to one it uses.</figcaption>
    </figure>
  );
}

function EntityRow({ entity, names }: { entity: Entity; names: Map<string, Entity> }) {
  const link = entity.ref?.startsWith("/") ? (
    <Link to={entity.ref} className="font-medium hover:text-accent">
      {entity.name}
    </Link>
  ) : entity.ref ? (
    <a href={entity.ref} className="font-medium hover:text-accent" rel="noreferrer">
      {entity.name}
    </a>
  ) : (
    <span className="font-medium">{entity.name}</span>
  );
  void names;
  return (
    <li className="flex gap-3 px-4 py-2.5">
      <span className="mt-0.5 text-muted">{KIND_ICON[entity.kind]}</span>
      <div className="min-w-0 grow">
        <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
          {link}
          {entity.project && entity.kind !== "project" && <span className="text-xs text-faint">{entity.project}</span>}
          {entity.private && <span className="text-[0.6875rem] text-faint">private</span>}
        </div>
        {entity.summary && <p className="mt-0.5 text-xs text-muted"><InlineMarkdown text={entity.summary} /></p>}
      </div>
    </li>
  );
}

/** The catalog: filters by kind and project, the graph, and the entries. */
export function CatalogView({ catalog, kind, project, base }: { catalog: Catalog; kind: EntityKind | null; project: string | null; base: string }) {
  const projects = catalog.entities.filter((entity) => entity.kind === "project");
  const names = new Map(catalog.entities.map((entity) => [entity.id, entity]));
  const shown = catalog.entities.filter((entity) => (!kind || entity.kind === kind) && (!project || entity.project === project || entity.project == null));
  const counts = new Map<string, number>();
  for (const entity of catalog.entities) counts.set(entity.kind, (counts.get(entity.kind) ?? 0) + 1);
  const href = (k: string | null, p: string | null) => {
    const params = new URLSearchParams({ tab: "catalog" });
    if (k) params.set("kind", k);
    if (p) params.set("project", p);
    return `${base}?${params}`;
  };
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-1.5">
        <Link to={href(null, project)} className={`rounded-full border px-2.5 py-1 text-xs ${!kind ? "border-accent text-fg" : "border-line text-muted hover:text-fg"}`}>
          Everything {catalog.entities.length}
        </Link>
        {ENTITY_KINDS.filter((k) => counts.get(k)).map((k) => (
          <Link key={k} to={href(k, project)} className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${kind === k ? "border-accent text-fg" : "border-line text-muted hover:text-fg"}`}>
            {KIND_ICON[k]}
            {KIND_LABEL[k]} {counts.get(k)}
          </Link>
        ))}
      </div>
      {projects.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-faint">Project:</span>
          <Link to={href(kind, null)} className={!project ? "text-fg" : "text-muted hover:text-fg"}>
            all
          </Link>
          {projects.map((p) => (
            <Link key={p.id} to={href(kind, p.key)} className={project === p.key ? "text-fg" : "text-muted hover:text-fg"}>
              {p.name}
            </Link>
          ))}
        </div>
      )}
      {!kind && !project && <RelationsGraph catalog={catalog} />}
      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-6 text-sm text-muted">
          Nothing here yet. The catalog builds itself from each project's default branch: its manifests, docs and
          workflows, with its deployments and integrations.
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {shown.slice(0, 500).map((entity) => (
            <EntityRow key={entity.id} entity={entity} names={names} />
          ))}
        </ul>
      )}
      {catalog.builtAt && (
        <p className="text-xs text-faint">
          Last built <TimeAgo at={catalog.builtAt} />.
        </p>
      )}
    </div>
  );
}

// --- Search -------------------------------------------------------------------

function Hit({ hit }: { hit: SearchHit }) {
  const title = hit.url?.startsWith("/") ? (
    <Link to={hit.url} className="font-medium hover:text-accent">
      {hit.title}
    </Link>
  ) : hit.url ? (
    <a href={hit.url} className="font-medium hover:text-accent" rel="noreferrer">
      {hit.title}
    </a>
  ) : (
    <span className="font-medium">{hit.title}</span>
  );
  return (
    <li className="flex gap-3 px-4 py-3">
      <span className="mt-0.5 text-muted">{KIND_ICON[hit.kind]}</span>
      <div className="min-w-0 grow">
        <div className="text-sm">{title}</div>
        {hit.snippet && <p className="mt-0.5 text-xs text-muted"><InlineMarkdown text={hit.snippet} /></p>}
        <p className="mt-1 flex flex-wrap gap-x-3 text-[0.6875rem] text-faint">
          <span>{hit.kind}</span>
          <span>{hit.source}</span>
          {hit.project && <span>{hit.project}</span>}
          {hit.by && <span>by {hit.by}</span>}
          {hit.updatedAt && (
            <span>
              <TimeAgo at={hit.updatedAt} />
            </span>
          )}
        </p>
      </div>
    </li>
  );
}

/** One search over the catalog, docs, issues, pull requests and memory. */
export function SearchView({ result, query, base }: { result: SearchResult | null; query: string; base: string }) {
  const navigation = useNavigation();
  const searching = navigation.state === "loading" && navigation.location?.search.includes("tab=search");
  return (
    <div className="space-y-4">
      <Form method="get" action={base} className="flex gap-2">
        <input type="hidden" name="tab" value="search" />
        <label className="relative grow">
          <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
          <input
            name="q"
            defaultValue={query}
            placeholder="How do we deploy the api? Who owns billing? Why did we keep v1 webhooks?"
            autoComplete="off"
            data-1p-ignore
            className="w-full rounded-md border border-line bg-bg py-2 pr-3 pl-9 text-sm outline-none placeholder:text-faint hover:border-line-strong focus:border-accent-dim"
          />
        </label>
        <button type="submit" className="rounded-md bg-fg px-3.5 py-2 text-sm font-medium text-bg hover:bg-fg-hover">
          {searching ? "Searching…" : "Search"}
        </button>
      </Form>
      {result &&
        (result.hits.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-4 py-6 text-sm text-muted">Nothing matched “{result.query}”.</p>
        ) : (
          <>
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
              {result.hits.map((hit) => (
                <Hit key={`${hit.kind}:${hit.id}`} hit={hit} />
              ))}
            </ul>
            <p className="text-xs text-faint">
              {result.mode === "semantic" ? "Ranked by meaning, then by matching words." : "Matched by words: the search index did not answer."}
            </p>
          </>
        ))}
    </div>
  );
}

// --- Scorecards ---------------------------------------------------------------

function Rule({ rule, project, action }: { rule: RuleResult; project: string; action: string }) {
  const fetcher = useFetcher<Done>();
  const icon =
    rule.status === "pass" ? <Check size={14} className="text-success" /> : rule.status === "fail" ? <XCircle size={14} className="text-danger" /> : <CircleDashed size={14} className="text-faint" />;
  return (
    <li className="flex items-start gap-2.5 py-1.5">
      <span className="mt-0.5">{icon}</span>
      <div className="min-w-0 grow text-sm">
        <span className={rule.status === "na" ? "text-muted" : ""}>{rule.title}</span>
        <p className="text-xs text-muted">{rule.detail}</p>
        {fetcher.data?.message && <p className="mt-1 text-xs text-success">{fetcher.data.message}</p>}
        {fetcher.data?.error && <p className="mt-1 text-xs text-danger">{fetcher.data.error}</p>}
      </div>
      {rule.fix && !fetcher.data?.ok && (
        <fetcher.Form method="post" action={action}>
          <input type="hidden" name="intent" value="fix" />
          <input type="hidden" name="project" value={project} />
          <input type="hidden" name="rule" value={rule.rule} />
          <Hint label={`Opens “${rule.fix.title}” and puts an agent on it`}>
            <SubmitButton
              fetcher={fetcher}
              pending="Opening…"
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-muted hover:border-accent-dim hover:text-fg disabled:opacity-50"
            >
              <Bot size={12} />
              Fix with an agent
            </SubmitButton>
          </Hint>
        </fetcher.Form>
      )}
    </li>
  );
}

/** Each project's scorecard; a failing rule becomes an issue for an agent in one click. */
export function ScorecardsView({ cards, action }: { cards: Scorecard[]; action: string }) {
  if (cards.length === 0) return <p className="rounded-xl border border-dashed border-line px-4 py-6 text-sm text-muted">No projects yet.</p>;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {cards.map((card) => (
        <section key={card.project} className="rounded-xl border border-line bg-surface p-4">
          <div className="flex items-baseline justify-between gap-3">
            <Link to={`/${card.repo.namespace}/${card.repo.name}`} className="font-medium hover:text-accent">
              {card.name}
            </Link>
            <span className={`text-xs ${card.passed === card.total ? "text-success" : "text-muted"}`}>
              {card.passed} of {card.total}
            </span>
          </div>
          <ul className="mt-2">
            {card.rules.map((rule) => (
              <Rule key={rule.rule} rule={rule} project={card.project} action={action} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export type ContextActionResult = Done;

/** Opens a scorecard rule's fix as an issue and puts g1t's agent on it. */
export async function fixRule(
  deps: {
    scorecards: () => Promise<Result<Scorecard[]>>;
    openIssue: (repo: { namespace: string; name: string }, input: { title: string; body: string; checks: string[] }) => Promise<Result<{ number: number }>>;
    assign: (repo: { namespace: string; name: string }, number: number) => Promise<unknown>;
  },
  project: string,
  rule: string,
): Promise<Done> {
  const cards = await deps.scorecards();
  if (!cards.ok) return { ok: false, error: cards.error.message };
  const card = cards.value.find((c) => c.project === project);
  const fix = card?.rules.find((r) => r.rule === rule && r.status === "fail")?.fix;
  if (!card || !fix) return { ok: false, error: "That rule passes now, or no longer applies." };
  const opened = await deps.openIssue(card.repo, {
    title: fix.title,
    body: `${fix.body}\n\nOpened from ${card.name}'s scorecard (${rule}).`,
    checks: fix.checks,
  });
  if (!opened.ok) return { ok: false, error: opened.error.message };
  await deps.assign(card.repo, opened.value.number);
  return { ok: true, message: `Opened #${opened.value.number}; an agent is on it.` };
}
