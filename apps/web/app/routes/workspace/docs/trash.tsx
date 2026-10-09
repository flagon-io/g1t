import type { DocPage } from "@g1t/contracts";
import { RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { data } from "react-router";

import type { Route } from "./+types/trash";
import { useDocsAction } from "../../../components/docs/actions";
import { PageIcon } from "../../../components/docs/sidebar";
import { EmptyState, ErrorText, TimeAgo } from "../../../components/ui";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../components/ui/alert-dialog";
import { page } from "../../../lib/meta";
import { docs } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Trash · Docs · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ pages: DocPage[] | null }> {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const found = await docs.trash(params.owner.toLowerCase(), viewer).catch(() => null);
  return { pages: found?.ok ? found.value : null };
}

/** Pages moved to the trash, in spaces the viewer can edit: restore them, or delete them for good. */
export default function DocsTrash({ loaderData, params }: Route.ComponentProps) {
  const slug = params.owner.toLowerCase();
  const { send, error } = useDocsAction(slug);
  const [forever, setForever] = useState<DocPage | null>(null);
  const pages = loaderData.pages;
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-xl font-semibold tracking-tight">Trash</h1>
      <p className="mt-1 text-sm text-muted">Pages come back with what was under them. Deleting for good can&apos;t be undone and needs full access to the space.</p>
      {error && (
        <div className="mt-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      <div className="mt-6">
        {pages === null ? (
          <EmptyState title="Docs didn't answer">Try again in a moment.</EmptyState>
        ) : pages.length === 0 ? (
          <EmptyState title="The trash is empty" />
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {pages.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-4 py-2.5">
                <PageIcon icon={p.icon} />
                <span className="min-w-0 grow">
                  <span className="block truncate text-sm">{p.title || "Untitled"}</span>
                  <span className="block text-xs text-faint">
                    {p.space_slug} · trashed {p.archived_at ? <TimeAgo at={p.archived_at} /> : null}
                  </span>
                </span>
                <button type="button" onClick={() => send("restore_page", { page_id: p.id })} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-xs text-fg hover:bg-raised">
                  <RotateCcw size={13} /> Restore
                </button>
                <button type="button" onClick={() => setForever(p)} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-danger/40 px-2.5 text-xs text-danger hover:bg-danger/10">
                  <Trash2 size={13} /> Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <AlertDialog open={!!forever} onOpenChange={(open) => !open && setForever(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{forever?.title || "Untitled"}&rdquo; for good?</AlertDialogTitle>
            <AlertDialogDescription>It goes with its history, comments and every page under it. This can&apos;t be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (forever) void send("delete_page", { page_id: forever.id });
                setForever(null);
              }}
            >
              Delete for good
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
