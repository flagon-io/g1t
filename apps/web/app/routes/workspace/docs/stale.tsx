import type { DocPage } from "@g1t/contracts";
import { AlertTriangle } from "lucide-react";
import { Link, data } from "react-router";

import type { Route } from "./+types/stale";
import { useDocsData } from "../../../components/docs/actions";
import { Faces } from "../../../components/docs/parts";
import { PageIcon } from "../../../components/docs/sidebar";
import { EmptyState, TimeAgo } from "../../../components/ui";
import { page } from "../../../lib/meta";
import { docs } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Possibly stale · Docs · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ pages: DocPage[] | null; repo: string | null }> {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const repo = new URL(request.url).searchParams.get("repo") || null;
  const found = await docs.stalePages(params.owner.toLowerCase(), viewer, { repo }).catch(() => null);
  return { pages: found?.ok ? found.value : null, repo };
}

/** Pages whose cited code changed since someone last marked them current, most recently flagged first. */
export default function DocsStale({ loaderData }: Route.ComponentProps) {
  const { pages, repo } = loaderData;
  const layout = useDocsData();
  const spaces = new Map((layout?.sidebar?.spaces ?? []).map((s) => [s.id, s.name]));
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
        <AlertTriangle size={18} className="text-warn" /> Possibly stale{repo ? ` · ${repo}` : ""}
      </h1>
      <p className="mt-1 text-sm text-muted">A merged pull request or a push to a default branch changed code these pages cite. Read what changed, update the page (or ask an agent to), then mark it current.</p>
      <div className="mt-6">
        {pages === null ? (
          <EmptyState title="Docs didn't answer">Try again in a moment.</EmptyState>
        ) : pages.length === 0 ? (
          <EmptyState title="Everything is current">No page you can read cites code that changed since it was last checked.</EmptyState>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {pages.map((p) => (
              <li key={p.id}>
                <Link to={p.path} prefetch="intent" className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-raised">
                  <PageIcon icon={p.icon} />
                  <span className="min-w-0 grow">
                    <span className="block truncate text-sm">{p.title || "Untitled"}</span>
                    <span className="block text-xs text-faint">
                      {spaces.get(p.space_id) ?? p.space_slug} · edited <TimeAgo at={p.updated_at} />
                    </span>
                  </span>
                  {p.owners.length > 0 && <Faces people={p.owners} size={18} />}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
