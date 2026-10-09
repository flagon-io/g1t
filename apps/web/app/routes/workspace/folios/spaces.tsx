import type { DocSpace } from "@g1t/contracts";
import { Check, Plus } from "lucide-react";
import { Link, data } from "react-router";

import type { Route } from "./+types/spaces";
import { useFoliosAction, useFoliosData } from "../../../components/folios/actions";
import { SpaceIcon, spaceKindLabel } from "../../../components/folios/parts";
import { EmptyState, ErrorText } from "../../../components/ui";
import { spacePath } from "../../../lib/folios";
import { page } from "../../../lib/meta";
import { docs } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Spaces · Artifacts · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ spaces: DocSpace[] | null }> {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const found = await docs.sidebar(params.owner.toLowerCase(), viewer).catch(() => null);
  return { spaces: found?.ok ? found.value.spaces.filter((s) => !s.archived_at).map(({ pages: _pages, ...space }) => space) : null };
}

/**
 * Every space the viewer can open. Open spaces are joined to show in the
 * sidebar, so it doesn't fill up; team and members-only spaces show
 * there already.
 */
export default function BrowseSpaces({ loaderData, params }: Route.ComponentProps) {
  const slug = params.owner.toLowerCase();
  const layout = useFoliosData();
  const { send, busy, error } = useFoliosAction(slug);
  const shown = new Set((layout?.sidebar?.spaces ?? []).map((s) => s.id));
  const spaces = loaderData.spaces;
  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Spaces</h1>
          <p className="mt-1 text-sm text-muted">A space holds artifacts for a team, a project or a topic. Join an open space to see it in your sidebar.</p>
        </div>
        <Link to={`/${slug}/-/artifacts/spaces/new`} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line px-3 text-sm text-fg/80 hover:border-line-strong hover:bg-surface hover:text-fg">
          <Plus size={15} /> New space
        </Link>
      </div>
      {error && (
        <div className="mt-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      <div className="mt-6">
        {spaces === null ? (
          <EmptyState title="Artifacts didn't answer">Try again in a moment.</EmptyState>
        ) : spaces.length === 0 ? (
          <EmptyState title="No spaces yet">Make one for a team, a project or a topic.</EmptyState>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {spaces.map((s) => {
              const joined = shown.has(s.id);
              const joinable = s.kind === "workspace" && !s.is_default;
              return (
                <li key={s.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-raised text-base">
                    <SpaceIcon space={s} size={16} />
                  </span>
                  <span className="min-w-0 grow">
                    <Link to={spacePath(slug, s.slug)} className="block truncate text-sm font-medium text-fg hover:text-accent">
                      {s.name}
                    </Link>
                    <span className="block truncate text-xs text-faint">
                      {spaceKindLabel(s.kind)}
                      {s.description ? ` · ${s.description}` : ""}
                    </span>
                  </span>
                  {joinable ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => send(joined ? "leave_space" : "join_space", { space_id: s.id })}
                      className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-xs font-medium disabled:opacity-60 ${joined ? "border border-line text-muted hover:border-danger/40 hover:text-danger" : "bg-accent text-bg hover:bg-accent-hover"}`}
                    >
                      {joined ? "Leave" : "Join"}
                    </button>
                  ) : (
                    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-faint">
                      <Check size={13} /> In your sidebar
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
