import { Search } from "lucide-react";
import { Form } from "react-router";

import type { Route } from "./+types/explore";
import { page } from "../lib/meta";
import { RepoList } from "../components/repo-list";
import { notACredential } from "../components/ui";
import { repos } from "../lib/services.server";
import { getViewer } from "../lib/session.server";

export function meta({ loaderData, ...args }: Route.MetaArgs) {
  return page(args, {
    title: loaderData?.query ? `${loaderData.query} · Search · g1t` : "Explore · g1t",
    description: loaderData?.query
      ? `Public repositories on g1t matching "${loaderData.query}".`
      : "Public repositories on g1t, and the agents at work on them.",
  });
}

/** Serves both /explore and /search?q=. */
export async function loader({ request, context }: Route.LoaderArgs) {
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  return { query, repos: await repos.list(getViewer(context), { query }) };
}

export default function Explore({ loaderData }: Route.ComponentProps) {
  const { query, repos } = loaderData;
  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">
        {query ? "Search" : "Explore"}
      </h1>
      <p className="mt-1 text-muted">
        {query
          ? `${repos.length} ${repos.length === 1 ? "repository matches" : "repositories match"} "${query}".`
          : "Public repositories on g1t."}
      </p>
      <Form action="/search" role="search" className="relative mt-6">
        <Search
          size={16}
          className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-faint"
        />
        <input
          name="q"
          {...notACredential()}
          defaultValue={query}
          placeholder="Search by name or description"
          aria-label="Search repositories"
          className="w-full rounded-lg border border-line bg-surface py-2.5 pr-4 pl-10 outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim"
        />
      </Form>
      <RepoList repos={repos} />
    </main>
  );
}
