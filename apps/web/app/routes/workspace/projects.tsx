import { ArrowUpRight, Box, ChevronLeft, ChevronRight, LayoutGrid, List, Lock, Rocket, Search } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef } from "react";
import { Form, Link, useLocation, useNavigation, useSubmit } from "react-router";

import type { Route } from "./+types/projects";
import { host } from "../../components/deploy";
import { PinButton } from "../../components/pin-button";
import { EmptyState, Pill, TimeAgo, notACredential } from "../../components/ui";
import { SelectField } from "../../components/ui/select";
import { page as pageMeta } from "../../lib/meta";
import {
  LANGUAGE_OF,
  type Listed,
  type ProjectQuery,
  SORTS,
  facetsOf,
  filterProjects,
  isFiltered,
  lastUpdated,
  nextRow,
  pageOf,
  projectQueryString,
  readProjectQuery,
} from "../../lib/project-list";
import { kindLabel, primaryLink } from "../../lib/project-kind";
import { deployments, projects } from "../../lib/services.server";
import { getViewer, roleIn } from "../../lib/session.server";
import { workspaceProjects } from "../../lib/workspace-projects.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return pageMeta(args, { title: `Projects · ${params.owner} · g1t` });
}

/**
 * Every project the viewer can see, filtered, sorted and paged here: one
 * listing (shared with the sidebar's), with Deployments and the viewer's
 * pins asked for at the same time.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const slug = params.owner.toLowerCase();
  const role = roleIn(viewer, slug);
  const query = readProjectQuery(new URL(request.url).searchParams);
  const [listed, deploys, shortcuts] = await Promise.all([
    workspaceProjects(slug, viewer),
    role ? deployments.overview(slug, viewer).catch(() => null) : null,
    role ? projects.shortcuts(slug, viewer).catch(() => null) : null,
  ]);
  const live = new Map((deploys?.ok ? deploys.value : []).map((entry) => [entry.slug, entry]));
  const full = new Map((listed.ok ? listed.value : []).map((project) => [project.id, project]));
  const all: Listed[] = (listed.ok ? listed.value : []).map((project) => ({
    id: project.id,
    slug: project.slug,
    name: project.name,
    description: project.description,
    private: project.private,
    archived: project.archived,
    kind: project.kind,
    ecosystem: project.ecosystem,
    updatedAt: project.updatedAt,
    pushedAt: project.pushedAt ?? null,
    activity: project.activity ?? 0,
    deploying: live.get(project.slug)?.enabled ?? false,
  }));
  const matched = filterProjects(all, query);
  const shown = pageOf(matched, query.page);
  return {
    slug,
    role,
    query: { ...query, page: shown.page },
    total: all.length,
    matched: matched.length,
    page: { page: shown.page, pages: shown.pages, from: shown.from, to: shown.to },
    // Production where g1t serves it or elsewhere, else its homepage or docs.
    items: shown.items.map((project) => {
      const one = full.get(project.id)!;
      return { ...project, runs: one.runs, production: primaryLink(one, live.get(project.slug)?.production?.url) };
    }),
    facets: facetsOf(all),
    pinned: (shortcuts?.pinned ?? []).map((project) => project.id),
    failed: !listed.ok,
  };
}

type Item = Route.ComponentProps["loaderData"]["items"][number];

const CONTROL =
  "h-9 rounded-md border border-line bg-surface px-2.5 text-sm text-fg outline-none transition-colors hover:border-line-strong focus:border-accent-dim";
/** A filter's select, on the same surface as the other controls. */
const FILTER = "w-auto bg-surface";

/** Its language, its kind when it is not an app, and its state, as small words. */
function Facts({ project }: { project: Item }) {
  const language = project.ecosystem ? LANGUAGE_OF[project.ecosystem] : null;
  return (
    <>
      {language && <span>{language}</span>}
      {project.kind !== "app" && <span>{kindLabel(project)}</span>}
      {project.kind === "app" && project.runs === "elsewhere" && <span>Deployed elsewhere</span>}
      {project.deploying && (
        <span className="inline-flex items-center gap-1 text-success">
          <Rocket size={11} />
          Deploys
        </span>
      )}
      <span className="text-faint">
        Updated <TimeAgo at={lastUpdated(project)} />
      </span>
    </>
  );
}

function ProjectRow({ project, slug, pinned, member }: { project: Item; slug: string; pinned: boolean; member: boolean }) {
  const to = `/${slug}/${project.slug}`;
  return (
    <li className="group relative flex items-center gap-3 px-4 py-3 transition-colors focus-within:bg-raised/60 hover:bg-raised/60">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-raised text-muted ring-1 ring-line">
        {project.private ? <Lock size={14} /> : <Box size={14} />}
      </span>
      <div className="min-w-0 grow">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            to={to}
            prefetch="intent"
            data-row
            className="truncate font-medium outline-none after:absolute after:inset-0 hover:underline focus-visible:underline"
          >
            {project.name}
          </Link>
          {project.name.toLowerCase() !== project.slug && <span className="truncate font-mono text-xs text-faint">{project.slug}</span>}
          {project.private && <Pill>private</Pill>}
          {project.archived && <Pill>archived</Pill>}
        </div>
        {project.description && <p className="mt-0.5 truncate text-sm text-muted">{project.description}</p>}
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
          <Facts project={project} />
        </p>
      </div>
      {project.production && (
        <a
          href={project.production}
          className="relative z-10 hidden shrink-0 items-center gap-1 font-mono text-xs text-muted hover:text-accent md:flex"
        >
          {host(project.production)}
          <ArrowUpRight size={11} />
        </a>
      )}
      {member && <PinButton workspace={slug} slug={project.slug} name={project.name} pinned={pinned} compact />}
    </li>
  );
}

function ProjectTile({ project, slug, pinned, member }: { project: Item; slug: string; pinned: boolean; member: boolean }) {
  return (
    <li className="group relative flex flex-col rounded-2xl border border-line bg-surface p-5 transition-colors focus-within:border-line-strong hover:border-line-strong">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-raised text-muted ring-1 ring-line">
          {project.private ? <Lock size={15} /> : <Box size={15} />}
        </span>
        <div className="min-w-0 grow">
          <Link
            to={`/${slug}/${project.slug}`}
            prefetch="intent"
            data-row
            className="block truncate font-medium outline-none after:absolute after:inset-0 hover:underline focus-visible:underline"
          >
            {project.name}
          </Link>
          {project.production ? (
            <a href={project.production} className="relative z-10 mt-0.5 flex items-center gap-1 truncate font-mono text-xs text-muted hover:text-accent">
              {host(project.production)}
              <ArrowUpRight size={11} className="shrink-0" />
            </a>
          ) : (
            <p className="mt-0.5 truncate font-mono text-xs text-faint">{project.slug}</p>
          )}
        </div>
        {member && <PinButton workspace={slug} slug={project.slug} name={project.name} pinned={pinned} compact className="-mt-1 -mr-2" />}
      </div>
      <p className="mt-3 line-clamp-2 min-h-10 text-sm text-muted">{project.description ?? ""}</p>
      <p className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-line pt-3 text-xs text-muted">
        {project.private && <span>Private</span>}
        {project.archived && <span>Archived</span>}
        <Facts project={project} />
      </p>
    </li>
  );
}

/** The pages around the current one: the first, the last, and two either side. */
function pageNumbers(page: number, pages: number): (number | null)[] {
  const wanted = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2].filter((n) => n >= 1 && n <= pages));
  const sorted = [...wanted].sort((a, b) => a - b);
  return sorted.flatMap((n, i) => (i > 0 && n - sorted[i - 1]! > 1 ? [null, n] : [n]));
}

function Pages({ query, page, pages }: { query: ProjectQuery; page: number; pages: number }) {
  if (pages <= 1) return null;
  const link = "flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-sm transition-colors";
  return (
    <nav aria-label="Pages" className="mt-6 flex flex-wrap items-center justify-center gap-1">
      {page > 1 ? (
        <Link to={projectQueryString(query, { page: page - 1 })} className={`${link} gap-1 text-muted hover:bg-raised hover:text-fg`}>
          <ChevronLeft size={14} />
          Previous
        </Link>
      ) : null}
      {pageNumbers(page, pages).map((n, i) =>
        n == null ? (
          <span key={`gap${i}`} className="px-1 text-faint">
            …
          </span>
        ) : (
          <Link
            key={n}
            to={projectQueryString(query, { page: n })}
            aria-current={n === page ? "page" : undefined}
            className={`${link} tabular-nums ${n === page ? "bg-raised font-medium text-fg ring-1 ring-line" : "text-muted hover:bg-raised hover:text-fg"}`}
          >
            {n}
          </Link>
        ),
      )}
      {page < pages ? (
        <Link to={projectQueryString(query, { page: page + 1 })} className={`${link} gap-1 text-muted hover:bg-raised hover:text-fg`}>
          Next
          <ChevronRight size={14} />
        </Link>
      ) : null}
    </nav>
  );
}

export default function WorkspaceProjects({ loaderData }: Route.ComponentProps) {
  const { slug, role, query, total, matched, page, items, facets, pinned, failed } = loaderData;
  const submit = useSubmit();
  const navigation = useNavigation();
  const { pathname } = useLocation();
  const form = useRef<HTMLFormElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const typing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const member = role != null;
  const pins = new Set(pinned);
  // A filter or page of this list on its way: the list says it is busy.
  const busy = navigation.state === "loading" && navigation.location?.pathname === pathname;

  const apply = (delay = 0) => {
    if (typing.current) clearTimeout(typing.current);
    typing.current = setTimeout(() => {
      if (form.current) submit(form.current, { replace: true, preventScrollReset: true });
    }, delay);
  };
  useEffect(() => () => void (typing.current && clearTimeout(typing.current)), []);
  // Back and forward change the address, not the fields: they follow it,
  // except the one being used.
  useEffect(() => {
    const fields = form.current?.elements;
    if (!fields) return;
    const values: Record<string, string> = {
      q: query.q,
      visibility: query.visibility,
      kind: query.kind,
      language: query.language ?? "",
      archived: query.archived,
      sort: query.sort,
    };
    for (const [name, value] of Object.entries(values)) {
      const field = fields.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
      if (field && field !== document.activeElement && "value" in field) field.value = value;
    }
    const deploys = fields.namedItem("deployments") as HTMLInputElement | null;
    if (deploys && deploys !== document.activeElement) deploys.checked = query.deployments;
  }, [query]);

  // `/` goes to the search, from anywhere on the page that is not a field.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      searchBox.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The arrows (and j and k) move between projects; Enter opens one.
  const list = useRef<HTMLDivElement>(null);
  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const rows = [...(list.current?.querySelectorAll<HTMLAnchorElement>("a[data-row]") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLAnchorElement);
    const key = event.key === "ArrowRight" ? "ArrowDown" : event.key === "ArrowLeft" ? "ArrowUp" : event.key;
    if (at < 0 && key !== "ArrowDown" && key !== "j") return;
    const to = nextRow(key, at, rows.length);
    if (to == null || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    rows[to]?.focus();
  };
  // From the search box, down goes to the first project.
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      list.current?.querySelector<HTMLAnchorElement>("a[data-row]")?.focus();
    }
    if (event.key === "Escape" && event.currentTarget.value) {
      event.currentTarget.value = "";
      apply();
    }
  };

  const filtered = isFiltered(query);
  const option = (label: string, count: number) => `${label} (${count})`;

  return (
    <div>
      <Form ref={form} id="project-filters" method="get" role="search" aria-label="Find projects" className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
          <input
            ref={searchBox}
            type="search"
            name="q"
            defaultValue={query.q}
            {...notACredential()}
            placeholder="Find a project…"
            aria-label="Find a project"
            aria-keyshortcuts="/"
            onChange={() => apply(250)}
            onKeyDown={onSearchKey}
            className={`${CONTROL} w-full pr-8 pl-8 placeholder:text-faint`}
          />
          <kbd className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded bg-raised px-1.5 font-mono text-[0.625rem] text-muted ring-1 ring-line sm:block">
            /
          </kbd>
        </div>
        <SelectField
          key={`visibility-${query.visibility}`}
          name="visibility"
          aria-label="Visibility"
          defaultValue={query.visibility}
          afterChange={() => apply()}
          className={FILTER}
          options={[
            { value: "all", label: "All visibility" },
            { value: "public", label: option("Public", facets.visibility.public) },
            { value: "private", label: option("Private", facets.visibility.private) },
          ]}
        />
        <SelectField
          key={`kind-${query.kind}`}
          name="kind"
          aria-label="Kind"
          defaultValue={query.kind}
          afterChange={() => apply()}
          className={FILTER}
          options={[
            { value: "all", label: "All kinds" },
            { value: "app", label: option("Apps", facets.kind.app) },
            { value: "library", label: option("Libraries", facets.kind.library) },
            ...(facets.kind.tool > 0 || query.kind === "tool" ? [{ value: "tool", label: option("Tools", facets.kind.tool) }] : []),
            ...(facets.kind.docs > 0 || query.kind === "docs" ? [{ value: "docs", label: option("Docs", facets.kind.docs) }] : []),
            ...(facets.kind.other > 0 || query.kind === "other" ? [{ value: "other", label: option("Other", facets.kind.other) }] : []),
          ]}
        />
        {(facets.languages.length > 0 || query.language) && (
          <SelectField
            key={`language-${query.language ?? ""}`}
            name="language"
            aria-label="Language"
            defaultValue={query.language ?? ""}
            afterChange={() => apply()}
            className={FILTER}
            options={[
              { value: "", label: "Any language" },
              ...facets.languages.map((language) => ({ value: language.name, label: option(language.name, language.count) })),
            ]}
          />
        )}
        {(facets.archived > 0 || query.archived !== "hide") && (
          <SelectField
            key={`archived-${query.archived}`}
            name="archived"
            aria-label="Archived"
            defaultValue={query.archived}
            afterChange={() => apply()}
            className={FILTER}
            options={[
              { value: "hide", label: "Without archived" },
              { value: "include", label: "With archived" },
              { value: "only", label: option("Only archived", facets.archived) },
            ]}
          />
        )}
        {member && (
          <label className={`${CONTROL} flex cursor-pointer items-center gap-2 select-none`}>
            <input
              type="checkbox"
              name="deployments"
              value="on"
              defaultChecked={query.deployments}
              onChange={() => apply()}
              className="accent-[var(--color-accent)]"
            />
            Deploys
            <span className="text-xs tabular-nums text-faint">{facets.deploying}</span>
          </label>
        )}
        {query.view !== "list" && <input type="hidden" name="view" value={query.view} />}
        <noscript>
          <button type="submit" className={CONTROL}>
            Apply
          </button>
        </noscript>
      </Form>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        <p className="text-muted" aria-live="polite">
          {filtered ? (
            <>
              <span className="font-medium text-fg tabular-nums">{matched}</span> of {total} {total === 1 ? "project" : "projects"}
              {query.q && (
                <>
                  {" "}
                  matching <span className="text-fg">“{query.q}”</span>
                </>
              )}
            </>
          ) : (
            <>
              <span className="font-medium text-fg tabular-nums">{total}</span> {total === 1 ? "project" : "projects"}
            </>
          )}
          {page.pages > 1 && (
            <span className="text-faint">
              {" "}
              · showing {page.from}–{page.to}
            </span>
          )}
        </p>
        {filtered && (
          <Link to={projectQueryString({ ...query, q: "", visibility: "all", kind: "all", language: null, deployments: false, archived: "hide" })} className="text-xs text-muted hover:text-fg">
            Clear filters
          </Link>
        )}
        <div className="ml-auto flex items-center gap-2">
          {/* Part of the filters' form, beside the view it orders. */}
          <SelectField
            key={`sort-${query.sort}`}
            form="project-filters"
            name="sort"
            aria-label="Sort"
            defaultValue={query.sort}
            afterChange={() => apply()}
            size="sm"
            className={FILTER}
            align="end"
            options={SORTS.map((sort) => ({ value: sort.value, label: sort.label }))}
          />
          <nav aria-label="View" className="flex items-center gap-0.5 rounded-lg border border-line bg-bg p-0.5">
            {(
              [
                ["list", "List", <List key="list" size={14} />],
                ["grid", "Grid", <LayoutGrid key="grid" size={14} />],
              ] as const
            ).map(([view, label, icon]) => (
              <Link
                key={view}
                to={projectQueryString(query, { view, page: query.page })}
                replace
                preventScrollReset
                aria-label={`${label} view`}
                aria-current={query.view === view ? "true" : undefined}
                className={`flex size-7 items-center justify-center rounded-md transition-colors ${
                  query.view === view ? "bg-raised text-fg ring-1 ring-line" : "text-faint hover:text-fg"
                }`}
              >
                {icon}
              </Link>
            ))}
          </nav>
        </div>
      </div>

      <div ref={list} onKeyDown={onListKey} aria-busy={busy || undefined} className={`mt-4 transition-opacity ${busy ? "opacity-60" : ""}`}>
        {failed ? (
          <EmptyState title="Projects cannot be listed right now">Try again in a moment.</EmptyState>
        ) : total === 0 ? (
          <EmptyState title="No projects yet">
            {member ? (
              <>
                <Link to={`/new?workspace=${slug}`} className="text-accent hover:underline">
                  Create one
                </Link>
                , or push a repository and it becomes one.
              </>
            ) : (
              "This workspace has no public projects."
            )}
          </EmptyState>
        ) : items.length === 0 ? (
          <EmptyState title="No projects match">
            Try other words or filters, or{" "}
            <Link to={projectQueryString({ ...query, q: "", visibility: "all", kind: "all", language: null, deployments: false, archived: "hide" })} className="text-accent hover:underline">
              clear them
            </Link>
            .
          </EmptyState>
        ) : query.view === "grid" ? (
          <ul aria-label="Projects" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((project) => (
              <ProjectTile key={project.id} project={project} slug={slug} pinned={pins.has(project.id)} member={member} />
            ))}
          </ul>
        ) : (
          <ul aria-label="Projects" className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {items.map((project) => (
              <ProjectRow key={project.id} project={project} slug={slug} pinned={pins.has(project.id)} member={member} />
            ))}
          </ul>
        )}
      </div>
      <Pages query={query} page={page.page} pages={page.pages} />
      {items.length > 0 && (
        <p className="mt-4 hidden text-center text-xs text-faint sm:block">
          <kbd className="rounded bg-raised px-1 font-mono ring-1 ring-line">/</kbd> to find,{" "}
          <kbd className="rounded bg-raised px-1 font-mono ring-1 ring-line">↑</kbd>{" "}
          <kbd className="rounded bg-raised px-1 font-mono ring-1 ring-line">↓</kbd> to move,{" "}
          <kbd className="rounded bg-raised px-1 font-mono ring-1 ring-line">Enter</kbd> to open
        </p>
      )}
    </div>
  );
}

