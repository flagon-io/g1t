import { ChevronLeft, ChevronRight, CircleHelp, Search as SearchIcon, X } from "lucide-react";
import type { ReactNode } from "react";
import { Form, Link, redirect, useNavigate } from "react-router";

import { SEARCH_TYPES, type SearchType, searchType } from "@g1t/contracts";

import type { Route } from "./+types/search";
import { SearchHitView } from "../components/search";
import { EmptyState, notACredential } from "../components/ui";
import { TabStrip } from "../components/ui/tab-strip";
import { Combobox } from "../components/ui/combobox";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { page } from "../lib/meta";
import {
  LANGUAGES,
  QUALIFIERS,
  TYPE_LABELS,
  isValue,
  qualifier,
  searchHref,
  shortCount,
  withIs,
  withQualifier,
} from "../lib/search";
import { search } from "../lib/services.server";
import { getViewer } from "../lib/session.server";

export function meta({ loaderData, ...args }: Route.MetaArgs) {
  const q = loaderData?.q;
  return page(args, {
    title: q ? `${q} · Search · g1t` : "Search · g1t",
    description: q
      ? `Repositories, code, issues, pull requests and people on g1t matching "${q}".`
      : "Search all of g1t: repositories, code, issues, pull requests and people.",
  });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 256);
  // From a repository's own search box: the same search, within it.
  const within = url.searchParams.get("repo")?.trim();
  if (within && /^[\w.-]+\/[\w.-]+$/.test(within)) {
    const scoped = withQualifier(q, "repo", within);
    throw redirect(searchHref(scoped, searchType(url.searchParams.get("type"))));
  }
  const type = searchType(url.searchParams.get("type"));
  const pageNumber = Math.min(Math.max(Number(url.searchParams.get("page")) || 1, 1), 50);
  if (!q) return { q, type, results: null, error: null };
  try {
    const found = await search.search(getViewer(context), q, { type, page: pageNumber });
    return found.ok
      ? { q, type, results: found.value, error: null }
      : { q, type, results: null, error: found.error.message };
  } catch {
    return { q, type, results: null, error: "Search cannot be reached right now. Try again in a moment." };
  }
}

const STATES: Record<"issues" | "pulls", { value: string | null; label: string }[]> = {
  issues: [
    { value: null, label: "All" },
    { value: "open", label: "Open" },
    { value: "closed", label: "Closed" },
  ],
  pulls: [
    { value: null, label: "All" },
    { value: "open", label: "Open" },
    { value: "merged", label: "Merged" },
    { value: "closed", label: "Closed" },
  ],
};
const STATE_FAMILY = ["open", "closed", "merged", "draft"];

function SyntaxHelp() {
  return (
    <Popover>
      <PopoverTrigger className="flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 text-sm text-muted transition-colors hover:border-line-strong hover:text-fg">
        <CircleHelp size={15} />
        <span className="hidden sm:inline">Syntax</span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <p className="border-b border-line px-4 py-3 text-xs text-muted">
          Words match anywhere; the last word also matches longer words it starts. Put qualifiers anywhere in the
          query.
        </p>
        <dl className="divide-y divide-line">
          {QUALIFIERS.map((item) => (
            <div key={item.example} className="grid grid-cols-[minmax(0,10rem)_1fr] gap-3 px-4 py-2">
              <dt className="font-mono text-xs text-fg">{item.example}</dt>
              <dd className="text-xs text-muted">{item.means}</dd>
            </div>
          ))}
        </dl>
        <a
          href="https://docs.g1t.sh/guides/search/"
          className="block border-t border-line px-4 py-2.5 text-xs text-accent hover:underline"
        >
          Everything search understands
        </a>
      </PopoverContent>
    </Popover>
  );
}

function Pill({ to, current, children }: { to: string; current: boolean; children: ReactNode }) {
  return (
    <Link
      to={to}
      aria-current={current ? "true" : undefined}
      className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
        current ? "bg-raised text-fg ring-1 ring-line" : "text-muted hover:text-fg"
      }`}
    >
      {children}
    </Link>
  );
}

export default function Search({ loaderData }: Route.ComponentProps) {
  const { q, results, error } = loaderData;
  const navigate = useNavigate();
  const type: SearchType = results?.type ?? loaderData.type ?? "repositories";
  const repo = qualifier(q, "repo");
  const language = qualifier(q, "language") ?? qualifier(q, "lang");
  const go = (next: string, nextType: SearchType | null = type) => navigate(searchHref(next, nextType));
  const languages = [...new Set([...(language ? [language] : []), ...LANGUAGES])];
  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Search</h1>
      <p className="mt-1 text-sm text-muted">
        Repositories, code, issues, pull requests and people: everything public on g1t, and what is private to the
        workspaces you belong to.
      </p>
      <div className="mt-6 flex gap-2">
        <Form action="/search" role="search" className="relative grow">
          <SearchIcon
            size={16}
            className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-faint"
          />
          <input
            key={q}
            name="q"
            {...notACredential()}
            defaultValue={q}
            autoFocus={!q}
            placeholder="Search g1t, or try language:rust parse_query"
            aria-label="Search g1t"
            className="h-10 w-full rounded-lg border border-line bg-surface pr-4 pl-10 font-mono text-sm outline-none transition-colors placeholder:font-sans placeholder:text-faint hover:border-line-strong focus:border-accent-dim"
          />
          {results && <input type="hidden" name="type" value={type} />}
        </Form>
        <SyntaxHelp />
      </div>

      {repo && (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted">
          Searching <span className="font-mono text-fg">{repo}</span>
          <Link
            to={searchHref(withQualifier(q, "repo", null), type)}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted ring-1 ring-line hover:text-fg"
          >
            <X size={12} />
            Search all of g1t
          </Link>
        </p>
      )}

      {q && (
        <TabStrip label="Kinds of results" className="mt-6 gap-1 border-b border-line">
          {SEARCH_TYPES.map((each) => (
            <Link
              key={each}
              to={searchHref(q, each)}
              aria-current={each === type ? "page" : undefined}
              className={`-mb-px flex items-center gap-2 border-b-2 px-3 pb-3 text-sm whitespace-nowrap transition-colors ${
                each === type ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg"
              }`}
            >
              {TYPE_LABELS[each]}
              {results && (
                <span className="rounded-full bg-raised px-1.5 py-px text-xs tabular-nums text-muted">
                  {shortCount(results.counts[each])}
                </span>
              )}
            </Link>
          ))}
        </TabStrip>
      )}

      {results && (type === "code" || type === "repositories" || type === "issues" || type === "pulls") && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {(type === "code" || type === "repositories") && (
            <div className="w-56">
              <Combobox
                aria-label="Language"
                value={language ?? "any"}
                placeholder="Any language"
                searchPlaceholder="Find a language…"
                options={[
                  { value: "any", label: "Any language" },
                  ...languages.map((name) => ({ value: name, label: name })),
                ]}
                onValueChange={(value) => go(withQualifier(q, "language", value === "any" ? null : value, ["lang"]))}
              />
            </div>
          )}
          {(type === "issues" || type === "pulls") && (
            <div className="flex items-center gap-1 rounded-lg border border-line bg-bg p-1">
              {STATES[type].map((state) => (
                <Pill
                  key={state.label}
                  to={searchHref(withIs(q, STATE_FAMILY, state.value), type)}
                  current={isValue(q, STATE_FAMILY) === state.value}
                >
                  {state.label}
                </Pill>
              ))}
            </div>
          )}
          {type === "code" && (
            <p className="text-xs text-faint">
              Narrow with <span className="font-mono text-muted">path:src/</span> or{" "}
              <span className="font-mono text-muted">path:*.rs</span>.
            </p>
          )}
          {(type === "issues" || type === "pulls") && (
            <p className="text-xs text-faint">
              Narrow with <span className="font-mono text-muted">author:</span> and{" "}
              <span className="font-mono text-muted">label:</span>.
            </p>
          )}
        </div>
      )}

      {results?.notes.map((note) => (
        <p key={note} className="mt-4 rounded-lg border border-line bg-surface px-4 py-3 text-sm text-muted">
          {note}
        </p>
      ))}
      {error && <p className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm">{error}</p>}

      {!q && (
        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          {QUALIFIERS.slice(0, 8).map((item) => (
            <div key={item.example} className="rounded-lg border border-line bg-surface px-4 py-3">
              <p className="font-mono text-sm">{item.example}</p>
              <p className="mt-1 text-xs text-muted">{item.means}</p>
            </div>
          ))}
        </div>
      )}

      {results && results.hits.length === 0 && (
        <div className="mt-6">
          <EmptyState title={`No ${TYPE_LABELS[type].toLowerCase()} match`}>
            {SEARCH_TYPES.some((each) => each !== type && results.counts[each] > 0) ? (
              <>
                Try{" "}
                {SEARCH_TYPES.filter((each) => each !== type && results.counts[each] > 0).map((each, index, list) => (
                  <span key={each}>
                    <Link to={searchHref(q, each)} className="text-accent hover:underline">
                      {TYPE_LABELS[each].toLowerCase()} ({shortCount(results.counts[each])})
                    </Link>
                    {index < list.length - 1 ? ", " : ""}
                  </span>
                ))}
                .
              </>
            ) : (
              "Try fewer words, or a different qualifier."
            )}
          </EmptyState>
        </div>
      )}

      {results && results.hits.length > 0 && (
        <ol className={`mt-6 ${type === "code" ? "space-y-4" : "divide-y divide-line"}`}>
          {results.hits.map((hit) => (
            <li key={`${hit.kind}:${hit.url}`} className={type === "code" ? undefined : "py-4"}>
              <SearchHitView hit={hit} />
            </li>
          ))}
        </ol>
      )}

      {results && (results.page > 1 || results.more) && (
        <nav aria-label="Pages" className="mt-8 flex items-center justify-between">
          {results.page > 1 ? (
            <Link
              to={searchHref(q, type, results.page - 1)}
              className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:border-line-strong hover:text-fg"
            >
              <ChevronLeft size={14} />
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-xs text-faint">Page {results.page}</span>
          {results.more ? (
            <Link
              to={searchHref(q, type, results.page + 1)}
              className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:border-line-strong hover:text-fg"
            >
              Next
              <ChevronRight size={14} />
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </main>
  );
}
