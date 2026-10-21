import type { DocSpace } from "@g1t/contracts";
import { Archive, Check, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, data } from "react-router";

import type { Route } from "./+types/spaces";
import { useFoliosAction, useFoliosData } from "../../../components/folios/actions";
import { SpaceIcon, spaceKindLabel } from "../../../components/folios/parts";
import { EmptyState, ErrorText, TimeAgo } from "../../../components/ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../components/ui/alert-dialog";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { canDo, spacePath } from "../../../lib/folios";
import { page } from "../../../lib/meta";
import { docs } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Spaces · Artifacts · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ spaces: DocSpace[] | null }> {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const found = await docs.spaces(params.owner.toLowerCase(), viewer).catch(() => null);
  return { spaces: found?.ok ? found.value : null };
}

/**
 * Every space the viewer can open. Open spaces are joined to show in the
 * sidebar, so it doesn't fill up; team and members-only spaces show
 * there already. Archived spaces are listed apart at the bottom, where
 * they are brought back or deleted.
 */
export default function BrowseSpaces({ loaderData, params }: Route.ComponentProps) {
  const slug = params.owner.toLowerCase();
  const layout = useFoliosData();
  const { send, busy, error } = useFoliosAction(slug);
  const shown = new Set((layout?.sidebar?.spaces ?? []).map((s) => s.id));
  const owner = layout?.role === "owner";
  const [deleting, setDeleting] = useState<DocSpace | null>(null);
  const spaces = loaderData.spaces;
  const live = (spaces ?? []).filter((s) => !s.archived_at);
  const archived = (spaces ?? []).filter((s) => s.archived_at);
  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Spaces</h1>
          <p className="mt-1 text-sm text-muted">A space holds artifacts for a team, a project or a topic. Join an open space to see it in your sidebar.</p>
        </div>
        <Button asChild variant="outline">
          <Link to={`/${slug}/-/library/artifacts/spaces/new`}>
            <Plus size={15} /> New space
          </Link>
        </Button>
      </div>
      {error && (
        <div className="mt-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      <div className="mt-6">
        {spaces === null ? (
          <EmptyState title="Artifacts didn't answer">Try again in a moment.</EmptyState>
        ) : live.length === 0 ? (
          <EmptyState title="No spaces yet">Make one for a team, a project or a topic. Artifacts in no space live in their owners&apos; Private.</EmptyState>
        ) : (
          <Card asChild divided className="overflow-hidden">
            <ul>
              {live.map((s) => {
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
                      <Button
                        type="button"
                        size="sm"
                        variant={joined ? "outline" : "accent"}
                        disabled={busy}
                        onClick={() => send(joined ? "leave_space" : "join_space", { space_id: s.id })}
                        className="shrink-0"
                      >
                        {joined ? "Leave" : "Join"}
                      </Button>
                    ) : (
                      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-faint">
                        <Check size={13} /> In your sidebar
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </div>
      {archived.length > 0 && (
        <section className="mt-10">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Archive size={14} className="text-faint" /> Archived
          </h2>
          <p className="mt-1 mb-4 text-xs leading-relaxed text-faint">
            Out of the sidebar and search, with everything in them kept. Bring one back, or delete it: its artifacts go to the trash.
          </p>
          <Card asChild divided className="overflow-hidden">
            <ul>
              {archived.map((s) => {
                const manages = canDo(s.viewer_role, "manage") || owner;
                return (
                  <li key={s.id} className="flex items-center gap-3 px-4 py-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-raised text-base opacity-70">
                      <SpaceIcon space={s} size={16} />
                    </span>
                    <span className="min-w-0 grow">
                      <span className="block truncate text-sm font-medium text-fg">{s.name}</span>
                      <span className="block truncate text-xs text-faint">
                        {spaceKindLabel(s.kind)} · archived {s.archived_at ? <TimeAgo at={s.archived_at} /> : null}
                      </span>
                    </span>
                    {manages && (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => send("update_space", { space_id: s.id, space_change: { archived: false } })}
                          className="shrink-0 text-xs font-normal"
                        >
                          <RotateCcw size={13} /> Restore
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          disabled={busy}
                          onClick={() => setDeleting(s)}
                          className="shrink-0 text-xs font-normal"
                        >
                          <Trash2 size={13} /> <span className="max-sm:hidden">Delete</span>
                        </Button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        </section>
      )}
      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Everything in it goes to the trash, where anyone who could edit it can restore it for 30 days. The space itself, its members and settings are gone
              for good.
              {deleting?.is_default ? " The workspace will have no General space; none takes its place." : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleting) void send("delete_space", { space_id: deleting.id });
                setDeleting(null);
              }}
            >
              Delete space
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
