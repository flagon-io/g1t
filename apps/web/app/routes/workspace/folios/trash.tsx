import type { Folio } from "@g1t/contracts";
import { RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { data } from "react-router";

import type { Route } from "./+types/trash";
import { useFoliosAction } from "../../../components/folios/actions";
import { KindIcon } from "../../../components/folios/kinds";
import { EmptyState, ErrorText, TimeAgo } from "../../../components/ui";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../components/ui/alert-dialog";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { canDo } from "../../../lib/folios";
import { page } from "../../../lib/meta";
import { folios } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Trash · Artifacts · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ items: Folio[] | null }> {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const found = await folios.trashed(params.owner.toLowerCase(), viewer).catch(() => null);
  return { items: found?.ok ? found.value : null };
}

const count = (n: number) => `${n} ${n === 1 ? "artifact" : "artifacts"}`;

/**
 * Artifacts moved to the trash that the viewer can change: restore them,
 * delete one for good, or empty the trash (everything they have full
 * access to goes). After 30 days they go on their own. Every change
 * reloads the sidebar's count with the page.
 */
export default function FoliosTrash({ loaderData, params }: Route.ComponentProps) {
  const slug = params.owner.toLowerCase();
  const { send, busy, error } = useFoliosAction(slug);
  const [forever, setForever] = useState<Folio | null>(null);
  const [emptying, setEmptying] = useState(false);
  const items = loaderData.items;
  const deletable = (items ?? []).filter((f) => canDo(f.viewer_role, "manage"));
  const kept = (items?.length ?? 0) - deletable.length;
  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Trash</h1>
          <p className="mt-1 text-sm text-muted">Artifacts come back with what was inside them. After 30 days in the trash they are deleted for good.</p>
        </div>
        {deletable.length > 0 && (
          <Button type="button" variant="destructive" disabled={busy} onClick={() => setEmptying(true)}>
            <Trash2 size={14} /> Empty trash
          </Button>
        )}
      </div>
      {error && (
        <div className="mt-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      <div className="mt-6">
        {items === null ? (
          <EmptyState title="Artifacts didn't answer">Try again in a moment.</EmptyState>
        ) : items.length === 0 ? (
          <EmptyState title="The trash is empty" />
        ) : (
          <Card asChild divided className="overflow-hidden">
            <ul>
              {items.map((f) => (
                <li key={f.id} className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
                  <KindIcon kind={f.kind} />
                  <span className="min-w-0 grow">
                    <span className="block truncate text-sm">{f.title || "Untitled"}</span>
                    <span className="block truncate text-xs text-faint">
                      {f.space?.name ?? "Private"} · trashed {f.trashed_at ? <TimeAgo at={f.trashed_at} /> : null}
                    </span>
                  </span>
                  <Button type="button" disabled={busy} onClick={() => send("restore", { folio_id: f.id })} variant="outline" size="sm" className="text-xs text-fg hover:bg-raised font-normal">
                    <RotateCcw size={13} /> Restore
                  </Button>
                  {canDo(f.viewer_role, "manage") && (
                    <Button type="button" disabled={busy} onClick={() => setForever(f)} variant="destructive" size="sm" className="text-xs font-normal">
                      <Trash2 size={13} /> <span className="max-sm:hidden">Delete</span>
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
      <AlertDialog open={!!forever} onOpenChange={(open) => !open && setForever(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{forever?.title || "Untitled"}&rdquo; for good?</AlertDialogTitle>
            <AlertDialogDescription>It goes with its history, comments and everything inside it. This can&apos;t be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (forever) void send("delete", { folio_id: forever.id });
                setForever(null);
              }}
            >
              Delete for good
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={emptying} onOpenChange={setEmptying}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Empty the trash?</AlertDialogTitle>
            <AlertDialogDescription>
              {count(deletable.length)} you have full access to {deletable.length === 1 ? "goes" : "go"} for good, with {deletable.length === 1 ? "its" : "their"} history, comments and everything inside.
              {kept > 0 ? ` The ${count(kept)} you can only edit ${kept === 1 ? "stays" : "stay"}.` : ""} This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep everything</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void send("empty_trash");
                setEmptying(false);
              }}
            >
              Delete {count(deletable.length)} for good
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
