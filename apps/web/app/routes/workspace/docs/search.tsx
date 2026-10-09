import type { DocSearchHit } from "@g1t/contracts";
import { FolderGit2, Search } from "lucide-react";
import { Form, Link, data, useSubmit } from "react-router";

import type { Route } from "./+types/search";
import { useDocsData } from "../../../components/docs/actions";
import { PageIcon } from "../../../components/docs/sidebar";
import { EmptyState, TimeAgo } from "../../../components/ui";
import { SelectField } from "../../../components/ui/select";
import { snippetParts } from "../../../lib/docs";
import { page } from "../../../lib/meta";
import { docs } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Search docs · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const space = url.searchParams.get("space") || null;
  const project = url.searchParams.get("project") || null;
  const found = q.trim()
    ? await docs.search(params.owner.toLowerCase(), viewer, { query: q, space_id: space, project, limit: 50, mode: "hybrid" }).catch(() => null)
    : null;
  return { q, space, project, hits: found?.ok ? found.value : q.trim() ? null : ([] as DocSearchHit[]) };
}

/**
 * Every page the viewer can read, and the projects' docs shown in Docs,
 * by words and by meaning at once; by space and by project. Each hit shows
 * the passage that matched, under its heading.
 */
export default function DocsSearch({ loaderData, params }: Route.ComponentProps) {
  const slug = params.owner.toLowerCase();
  const { q, space, project, hits } = loaderData;
  const layout = useDocsData();
  const submit = useSubmit();
  const spaces = layout?.sidebar?.spaces ?? [];
  const projects = [...new Set(spaces.flatMap((s) => s.projects))].sort();
  const refresh = () => submit(document.getElementById("docs-search") as HTMLFormElement);
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-xl font-semibold tracking-tight">Search docs</h1>
      <Form method="get" id="docs-search" className="mt-4 flex flex-wrap gap-2">
        <label className="flex h-10 min-w-0 grow items-center gap-2 rounded-md border border-line bg-surface px-3 focus-within:border-accent/60">
          <Search size={16} className="text-faint" aria-hidden="true" />
          <input name="q" defaultValue={q} autoFocus placeholder="Words, or a question" aria-label="Search" className="min-w-0 grow bg-transparent text-sm outline-none placeholder:text-faint" />
        </label>
        <SelectField
          name="space"
          aria-label="Space"
          value={space ?? ""}
          afterChange={refresh}
          options={[{ value: "", label: "Every space" }, ...spaces.map((s) => ({ value: s.id, label: s.name }))]}
          className="h-10 min-w-40"
        />
        {projects.length > 0 && (
          <SelectField name="project" aria-label="Project" value={project ?? ""} afterChange={refresh} options={[{ value: "", label: "Any project" }, ...projects.map((p) => ({ value: p, label: p }))]} className="h-10 min-w-40" />
        )}
      </Form>
      <div className="mt-6">
        {hits === null ? (
          <EmptyState title="Search didn't answer">Try again in a moment.</EmptyState>
        ) : !q.trim() ? (
          <p className="text-sm text-muted">
            Search every space you can read, and the projects&apos; docs shown in Docs, by their words and by what they mean: ask a question and the passage that answers it comes up even when it words it differently. Agents recall from
            Docs the same way, and only from what everyone they answer can read.
          </p>
        ) : hits.length === 0 ? (
          <EmptyState title="Nothing found">No page you can read matches &ldquo;{q}&rdquo;.</EmptyState>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {hits.map((hit) => (
              <li key={hit.id}>
                <Link to={hit.path} className="block px-4 py-3 transition-colors hover:bg-raised">
                  <span className="flex items-center gap-2">
                    {hit.repo_file ? <FolderGit2 size={15} className="shrink-0 text-faint" aria-hidden="true" /> : <PageIcon icon={hit.icon} />}
                    <span className="truncate text-sm font-medium">{hit.title || "Untitled"}</span>
                    <span className="ml-auto shrink-0 text-xs text-faint">
                      {hit.space_name} · <TimeAgo at={hit.updated_at} />
                    </span>
                  </span>
                  {hit.heading && <span className="mt-0.5 block truncate text-xs font-medium text-muted">{hit.heading}</span>}
                  <span className="mt-1 line-clamp-2 block text-xs leading-relaxed text-muted">
                    {snippetParts(hit.snippet).map((part, i) =>
                      part.match ? (
                        <mark key={i} className="rounded bg-accent/20 px-0.5 text-fg">
                          {part.text}
                        </mark>
                      ) : (
                        <span key={i}>{part.text}</span>
                      ),
                    )}
                  </span>
                  {hit.projects.length > 0 && <span className="mt-1 block text-[0.6875rem] text-faint">{hit.projects.join(" · ")}</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="mt-4 text-xs text-faint">
        <Link to={`/${slug}/-/docs`} className="hover:text-fg">
          Back to Docs
        </Link>
      </p>
    </div>
  );
}
