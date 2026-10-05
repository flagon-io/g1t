import { BookMarked, Search } from "lucide-react";
import type { ReactNode } from "react";
import { Form, Link } from "react-router";

import type { ExploreRepo } from "@g1t/contracts";

import type { Route } from "./+types/explore";
import { EmptyState, TimeAgo, notACredential } from "../components/ui";
import { page } from "../lib/meta";
import { search } from "../lib/services.server";
import { getViewer } from "../lib/session.server";

export function meta({ loaderData, ...args }: Route.MetaArgs) {
  const filter = loaderData?.language ?? (loaderData?.topic ? `#${loaderData.topic}` : null);
  return page(args, {
    title: filter ? `${filter} · Explore · g1t` : "Explore · g1t",
    description: filter
      ? `Public projects on g1t in ${filter}.`
      : "Public projects on g1t: recently active, newly created, and by language and topic.",
  });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const sort = url.searchParams.get("sort") === "new" ? ("new" as const) : ("active" as const);
  const language = url.searchParams.get("language")?.trim().toLowerCase() || null;
  const topic = url.searchParams.get("topic")?.trim().toLowerCase() || null;
  const pageNumber = Math.min(Math.max(Number(url.searchParams.get("page")) || 1, 1), 50);
  const explore = await search
    .explore(getViewer(context), { sort, language, topic, page: pageNumber })
    .catch(() => null);
  return { sort, language, topic, explore };
}

/** The address of Explore with some of its filters changed. */
function href(current: { sort: string; language: string | null; topic: string | null }, change: Record<string, string | null>) {
  const next = { sort: current.sort, language: current.language, topic: current.topic, ...change };
  const params = new URLSearchParams();
  if (next.sort && next.sort !== "active") params.set("sort", next.sort);
  if (next.language) params.set("language", next.language);
  if (next.topic) params.set("topic", next.topic);
  if (change.page) params.set("page", change.page);
  const query = params.toString();
  return query ? `/explore?${query}` : "/explore";
}

function RepoCard({ repo }: { repo: ExploreRepo }) {
  return (
    <Link
      prefetch="intent"
      to={`/${repo.namespace}/${repo.name}`}
      className="flex h-full flex-col rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong"
    >
      <span className="flex items-center gap-2">
        <BookMarked size={15} className="shrink-0 text-faint" />
        <span className="truncate font-mono text-sm">
          <span className="text-muted">{repo.namespace}/</span>
          <span className="font-medium">{repo.name}</span>
        </span>
      </span>
      <span className="mt-2 line-clamp-2 grow text-sm text-muted">{repo.description ?? "No description."}</span>
      {repo.topics.length > 0 && (
        <span className="mt-3 flex flex-wrap gap-1.5">
          {repo.topics.slice(0, 4).map((topic) => (
            <span key={topic} className="rounded-full bg-raised px-2 py-px text-[0.6875rem] text-muted ring-1 ring-line">
              {topic}
            </span>
          ))}
        </span>
      )}
      <span className="mt-3 flex items-center gap-3 text-xs text-faint">
        {repo.language && <span className="font-mono">{repo.language}</span>}
        <span className="ml-auto">
          {repo.pushedAt ? (
            <>
              Pushed <TimeAgo at={repo.pushedAt} />
            </>
          ) : (
            <>
              Created <TimeAgo at={repo.createdAt} />
            </>
          )}
        </span>
      </span>
    </Link>
  );
}

function Chip({ to, current, children }: { to: string; current: boolean; children: ReactNode }) {
  return (
    <Link
      to={to}
      aria-current={current ? "true" : undefined}
      className={`rounded-full px-2.5 py-1 text-xs transition-colors ring-1 ${
        current ? "bg-accent/15 text-fg ring-accent/50" : "text-muted ring-line hover:text-fg hover:ring-line-strong"
      }`}
    >
      {children}
    </Link>
  );
}

export default function ExplorePage({ loaderData }: Route.ComponentProps) {
  const { sort, language, topic, explore } = loaderData;
  const current = { sort, language, topic };
  const filtered = language || topic;
  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Explore</h1>
      <p className="mt-1 text-muted">
        Public projects on g1t{language ? ` in ${language}` : ""}
        {topic ? ` about ${topic}` : ""}.
      </p>
      <Form action="/search" role="search" className="relative mt-6 max-w-2xl">
        <Search size={16} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-faint" />
        <input
          name="q"
          {...notACredential()}
          placeholder="Search repositories, code, issues and people"
          aria-label="Search g1t"
          className="h-10 w-full rounded-lg border border-line bg-surface pr-4 pl-10 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim"
        />
      </Form>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <section>
          <div className="flex flex-wrap items-center gap-3">
            <nav aria-label="Order" className="flex items-center gap-1 rounded-lg border border-line bg-bg p-1">
              {[
                { value: "active", label: "Recently active" },
                { value: "new", label: "New" },
              ].map((option) => (
                <Link
                  key={option.value}
                  to={href(current, { sort: option.value })}
                  aria-current={sort === option.value ? "page" : undefined}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    sort === option.value ? "bg-raised text-fg ring-1 ring-line" : "text-muted hover:text-fg"
                  }`}
                >
                  {option.label}
                </Link>
              ))}
            </nav>
            {filtered && (
              <Link to={href(current, { language: null, topic: null })} className="text-xs text-muted hover:text-fg">
                Clear {language ? "language" : "topic"}
              </Link>
            )}
          </div>
          {!explore ? (
            <div className="mt-4">
              <EmptyState title="Explore cannot be reached right now">Try again in a moment.</EmptyState>
            </div>
          ) : explore.repos.length === 0 ? (
            <div className="mt-4">
              <EmptyState title="No public projects here yet">
                {filtered ? "Try another language or topic." : "Public projects appear here as they are made."}
              </EmptyState>
            </div>
          ) : (
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {explore.repos.map((repo) => (
                <li key={`${repo.namespace}/${repo.name}`}>
                  <RepoCard repo={repo} />
                </li>
              ))}
            </ul>
          )}
          {explore && (explore.page > 1 || explore.more) && (
            <nav aria-label="Pages" className="mt-6 flex justify-between text-sm">
              {explore.page > 1 ? (
                <Link to={href(current, { page: String(explore.page - 1) })} className="text-muted hover:text-fg">
                  Previous
                </Link>
              ) : (
                <span />
              )}
              {explore.more && (
                <Link to={href(current, { page: String(explore.page + 1) })} className="text-muted hover:text-fg">
                  Next
                </Link>
              )}
            </nav>
          )}
        </section>

        <aside className="space-y-6">
          {explore && explore.languages.length > 0 && (
            <section>
              <h2 className="text-xs font-medium text-faint">Languages</h2>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {explore.languages.map((facet) => (
                  <Chip
                    key={facet.name}
                    to={href(current, { language: language === facet.name ? null : facet.name })}
                    current={language === facet.name}
                  >
                    <span className="font-mono">{facet.name}</span> <span className="text-faint">{facet.count}</span>
                  </Chip>
                ))}
              </div>
            </section>
          )}
          {explore && explore.topics.length > 0 && (
            <section>
              <h2 className="text-xs font-medium text-faint">Topics</h2>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {explore.topics.map((facet) => (
                  <Chip
                    key={facet.name}
                    to={href(current, { topic: topic === facet.name ? null : facet.name })}
                    current={topic === facet.name}
                  >
                    {facet.name} <span className="text-faint">{facet.count}</span>
                  </Chip>
                ))}
              </div>
            </section>
          )}
        </aside>
      </div>
    </main>
  );
}
