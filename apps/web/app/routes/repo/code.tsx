import { Search } from "lucide-react";
import { Form } from "react-router";

import type { Route } from "./+types/code";
import { TreeView } from "../../components/repo-view";
import { notACredential } from "../../components/ui";
import { page } from "../../lib/meta";
import { repos } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Code · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const path = { namespace: params.owner, name: params.repo };
  return unwrap(await repos.tree(path, getViewer(context), null, ""));
}

/**
 * Searches this repository's code: the search page adds `repo:` for it, so
 * the results can be widened to all of g1t from there.
 */
function SearchThisRepository({ repo }: { repo: string }) {
  return (
    <Form action="/search" role="search" className="relative mb-4 max-w-md">
      <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
      <input
        name="q"
        {...notACredential()}
        placeholder="Search this repository's code"
        aria-label={`Search ${repo}`}
        className="h-9 w-full rounded-md border border-line bg-surface pr-3 pl-8 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim"
      />
      <input type="hidden" name="repo" value={repo} />
      <input type="hidden" name="type" value="code" />
    </Form>
  );
}

export default function Code({ loaderData }: Route.ComponentProps) {
  const repo = `${loaderData.repo.namespace}/${loaderData.repo.name}`;
  return (
    <>
      {loaderData.head && <SearchThisRepository repo={repo} />}
      <TreeView tree={loaderData} />
    </>
  );
}
