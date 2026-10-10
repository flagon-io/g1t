import {
  AlertTriangle,
  BarChart3,
  BookOpen,
  Bot,
  CalendarDays,
  ChevronRight,
  Cloud,
  Code2,
  FolderOpen,
  Headset,
  LayoutGrid,
  ListChecks,
  MessagesSquare,
  Palette,
  Search,
  ShieldCheck,
  Siren,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link, useSearchParams } from "react-router";

import { type ConnectorScope, type ConnectorView, connectorPath } from "@g1t/contracts/connectors";

import { CONTACT } from "../lib/legal";
import {
  type CategoryFilter,
  type ConnectedState,
  arrange,
  askHref,
  categoriesWith,
  categoryCounts,
  categoryFilter,
  categoryTitle,
  groupByCategory,
  monogram,
  tileColor,
} from "../lib/connectors";
import { cn } from "../lib/cn";
import { ProviderMark } from "./model-providers";
import { Badge } from "./ui/badge";
import { Hint } from "./ui/hint";
import { Input } from "./ui";
import { Card } from "./ui/card";

const CATEGORY_ICONS: Record<CategoryFilter, ReactNode> = {
  all: <LayoutGrid size={15} />,
  code: <Code2 size={15} />,
  issues: <ListChecks size={15} />,
  chat: <MessagesSquare size={15} />,
  calendar: <CalendarDays size={15} />,
  docs: <BookOpen size={15} />,
  monitoring: <Siren size={15} />,
  cloud: <Cloud size={15} />,
  ai: <Bot size={15} />,
  data: <BarChart3 size={15} />,
  crm: <Headset size={15} />,
  design: <Palette size={15} />,
  security: <ShieldCheck size={15} />,
  files: <FolderOpen size={15} />,
};

/** A connector's tile: its provider's mark, or its letters on a steady colour. No logos. */
export function ConnectorMark({ view, size = 36 }: { view: Pick<ConnectorView, "id" | "name" | "provider">; size?: number }) {
  if (view.provider) return <ProviderMark provider={view.provider} size={size} />;
  const color = tileColor(view.id);
  const letters = monogram(view.name);
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center font-semibold tracking-tight"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        fontSize: size * (letters.length > 1 ? 0.34 : 0.42),
        background: `color-mix(in srgb, ${color} 16%, transparent)`,
        // Toward the text colour, so the letters read in both themes.
        color: `color-mix(in srgb, ${color} 60%, var(--color-fg))`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 30%, transparent)`,
      }}
    >
      {letters}
    </span>
  );
}

export type ConnectorDirectoryProps = {
  scope: ConnectorScope;
  views: ConnectorView[];
  /** What is connected here, by connector id. */
  connected: Record<string, ConnectedState>;
  /** The workspace's slug on its page; null on your own. */
  workspace: string | null;
  /** Whether the viewer can connect things here (an owner, or anyone for themselves). */
  canManage: boolean;
  /** Category navigation as a sidebar beside the cards (wide pages), or as chips above them. */
  nav?: "sidebar" | "chips";
};

/**
 * The integrations directory: categories to browse, a search, and every
 * connector as a card, sorted into Connected, Available and Soon.
 */
export function ConnectorDirectory({ scope, views, connected, workspace, canManage, nav = "sidebar" }: ConnectorDirectoryProps) {
  const [params, setParams] = useSearchParams();
  const category = categoryFilter(params.get("category"));
  const [query, setQuery] = useState("");
  const counts = categoryCounts(views);
  const categories = categoriesWith(views);
  const found = arrange(views, { category, query, connected: new Set(Object.keys(connected)) });
  const searching = query.trim().length > 0;
  const grouped = category === "all" && !searching;
  const empty = found.connected.length + found.available.length + found.soon.length === 0;

  const choose = (next: CategoryFilter) => {
    setParams(
      (current) => {
        const updated = new URLSearchParams(current);
        if (next === "all") updated.delete("category");
        else updated.set("category", next);
        return updated;
      },
      { replace: true, preventScrollReset: true },
    );
    setQuery("");
  };

  const options: { id: CategoryFilter; title: string }[] = [{ id: "all", title: "All" }, ...categories];
  const card = (view: ConnectorView) => (
    <ConnectorCard
      key={view.id}
      view={view}
      scope={scope}
      state={connected[view.id] ?? null}
      workspace={workspace}
      canManage={canManage}
      showCategory={category === "all" || searching}
    />
  );

  return (
    <div className={cn(nav === "sidebar" && "md:grid md:grid-cols-[12rem_minmax(0,1fr)] md:gap-8")}>
      {/* Categories: a list beside the cards on a wide page, chips that scroll sideways otherwise. */}
      <nav aria-label="Categories" className={cn(nav === "sidebar" && "md:sticky md:top-20 md:self-start")}>
        <ul
          className={cn(
            "-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:px-0",
            nav === "sidebar" && "md:mx-0 md:flex-col md:gap-px md:overflow-visible md:px-0",
          )}
        >
          {options.map((option) => {
            const current = option.id === category;
            return (
              <li key={option.id} className="shrink-0">
                <button
                  type="button"
                  onClick={() => choose(option.id)}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm whitespace-nowrap transition-colors",
                    nav === "sidebar" && "md:w-full md:rounded-md md:border-transparent md:px-2.5",
                    current
                      ? "border-accent/40 bg-accent/10 text-fg md:bg-raised"
                      : "border-line text-muted hover:border-line-strong hover:text-fg md:hover:bg-surface",
                  )}
                >
                  <span className={cn("hidden text-faint", nav === "sidebar" && "md:inline-flex", current && "text-accent")}>
                    {CATEGORY_ICONS[option.id]}
                  </span>
                  <span className="grow text-left">{option.title}</span>
                  <span className="text-xs text-faint tabular-nums">{counts[option.id]}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="mt-5 min-w-0 md:mt-0">
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={category === "all" ? "Search integrations" : `Search all integrations, not just ${categoryTitle(category)}`}
            aria-label="Search integrations"
            className="pl-9"
          />
        </div>

        {empty && (
          <Card asChild tone="plain" className="mt-8 border-dashed px-4 py-8 text-center text-sm text-muted">
            <p>
              Nothing matches “{query.trim()}”.{" "}
              <a
                href={askHref({ connector: { id: "other", name: query.trim() || "something else" }, scope, workspace, address: CONTACT.support })}
                className="text-accent hover:underline"
              >
                Ask for it
              </a>
              , and say what you would use it for.
            </p>
          </Card>
        )}

        {found.connected.length > 0 && (
          <Group title="Connected" count={found.connected.length}>
            <Cards>{found.connected.map(card)}</Cards>
          </Group>
        )}
        {found.available.length > 0 && (
          <Group
            title="Available"
            count={found.available.length}
            about={
              scope === "workspace"
                ? canManage
                  ? "Ready to connect now."
                  : `Ready now. An owner of ${workspace} connects them.`
                : "Ready to connect now."
            }
          >
            <Cards>{found.available.map(card)}</Cards>
          </Group>
        )}
        {found.soon.length > 0 && (
          <Group title="Soon" count={found.soon.length} about="Being built. Ask for the ones you need, and they come sooner.">
            {grouped ? (
              <div className="space-y-6">
                {groupByCategory(found.soon).map((group) => (
                  <div key={group.id}>
                    <p className="mb-2 flex items-center gap-2 text-xs font-medium tracking-wide text-faint uppercase">
                      {CATEGORY_ICONS[group.id]}
                      {group.title}
                    </p>
                    <Cards>{group.views.map((view) => <ConnectorCard key={view.id} view={view} scope={scope} state={null} workspace={workspace} canManage={canManage} showCategory={false} />)}</Cards>
                  </div>
                ))}
              </div>
            ) : (
              <Cards>{found.soon.map(card)}</Cards>
            )}
          </Group>
        )}
      </div>
    </div>
  );
}

function Group({ title, count, about, children }: { title: string; count: number; about?: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="flex items-baseline gap-2 text-sm font-medium">
        {title}
        <span className="text-xs font-normal text-faint tabular-nums">{count}</span>
      </h2>
      {about && <p className="mt-0.5 text-xs text-muted">{about}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Cards({ children }: { children: ReactNode }) {
  return <ul className="grid gap-3 sm:grid-cols-2">{children}</ul>;
}

function ConnectorCard({
  view,
  scope,
  state,
  workspace,
  canManage,
  showCategory,
}: {
  view: ConnectorView;
  scope: ConnectorScope;
  state: ConnectedState | null;
  workspace: string | null;
  canManage: boolean;
  showCategory: boolean;
}) {
  const soon = view.status === "soon";
  const setup = view.href ? connectorPath(view.href, workspace ?? "") : null;
  const to = state?.manage ?? setup;
  const also =
    view.alsoIn === "personal"
      ? "Each person can also connect their own, under their settings."
      : view.alsoIn === "workspace"
        ? "A workspace owner can also connect it for everyone."
        : null;
  return (
    <li
      className={cn(
        "relative flex flex-col rounded-xl border p-4 transition-colors",
        soon ? "border-line/70 bg-surface/40" : "border-line bg-surface",
        !soon && to && "hover:border-line-strong",
      )}
    >
      <div className="flex items-start gap-3">
        <span className={cn(soon && "opacity-70 grayscale-[35%]")}>
          <ConnectorMark view={view} />
        </span>
        <div className="min-w-0 grow">
          <div className="flex items-center gap-2">
            {!soon && to ? (
              // The whole card opens it: the link stretches over the card.
              <Link to={to} className="truncate text-sm font-medium after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none">
                {view.name}
              </Link>
            ) : (
              <p className={cn("truncate text-sm font-medium", soon && "text-fg/80")}>{view.name}</p>
            )}
            {state ? (
              state.problem ? (
                <Hint label={state.problem}>
                  <Badge tone="warn" className="relative z-10" tabIndex={0}>
                    <AlertTriangle size={11} /> Needs attention
                  </Badge>
                </Hint>
              ) : (
                <Badge tone="success">Connected</Badge>
              )
            ) : soon ? (
              <Badge>Soon</Badge>
            ) : null}
          </div>
          {showCategory && <p className="text-xs text-faint">{categoryTitle(view.category)}</p>}
        </div>
      </div>
      <p className={cn("mt-2.5 text-sm", soon ? "text-muted/90" : "text-muted")}>{view.description}</p>
      {state?.detail && <p className="mt-1.5 truncate text-xs text-faint">{state.detail}</p>}
      {view.capabilities.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {view.capabilities.map((capability) => (
            <li key={capability} className="rounded-md bg-raised px-1.5 py-0.5 text-[0.6875rem] text-muted">
              {capability}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-auto flex items-end justify-between gap-3 pt-3">
        <p className="text-[0.6875rem] text-faint">{also}</p>
        {soon ? (
          <a
            href={askHref({ connector: view, scope, workspace, address: CONTACT.support })}
            className="relative z-10 shrink-0 rounded-md border border-line px-2.5 py-1 text-xs font-medium text-fg/80 hover:border-line-strong hover:bg-raised hover:text-fg"
          >
            Ask for this
          </a>
        ) : to ? (
          <span className="flex shrink-0 items-center gap-0.5 text-xs font-medium text-accent">
            {state ? (canManage ? "Manage" : "View") : canManage ? "Set up" : "View"}
            <ChevronRight size={13} />
          </span>
        ) : null}
      </div>
    </li>
  );
}

/** A short line saying who a page's connections are for, and where the other kind lives. */
export function ScopeNote({ scope, workspace }: { scope: ConnectorScope; workspace: string | null }) {
  return (
    <Card asChild tone="plain" className="mb-6 bg-surface/60 px-4 py-3 text-sm text-muted">
      <p>
        {scope === "workspace" ? (
          <>
            Connected here, a tool works <span className="text-fg">for everyone in {workspace}</span>: its people and its agents.
            Your own accounts, such as your calendar, are under{" "}
            <Link to="/settings/integrations" className="text-accent hover:underline">
              your integrations
            </Link>
            .
          </>
        ) : (
          <>
            Connected here, a tool works <span className="text-fg">just for you, in every workspace</span> you belong to. Tools
            the whole team shares are connected by a workspace owner, under the workspace's Integrations.
          </>
        )}
      </p>
    </Card>
  );
}
