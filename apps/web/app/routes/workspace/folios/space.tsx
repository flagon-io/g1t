import { DOC_ROLE_LABELS, type DocSpace, type FolioList } from "@g1t/contracts";
import { FilePlus2, Settings } from "lucide-react";
import { useState } from "react";
import { Form, Link, data, useNavigation } from "react-router";

import type { Route } from "./+types/space";
import { useFoliosAction, useFoliosData, useViewerZone } from "../../../components/folios/actions";
import { FolioDays } from "../../../components/folios/list";
import { SpaceIcon, spaceKindLabel } from "../../../components/folios/parts";
import { EmptyState, ErrorText } from "../../../components/ui";
import { Button } from "../../../components/ui/button";
import { Hint } from "../../../components/ui/hint";
import { canDo, spacePath } from "../../../lib/folios";
import { page } from "../../../lib/meta";
import { docs, folios } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ loaderData: loaded, params, ...args }: Route.MetaArgs) {
  return page(args, { title: `${loaded?.space.name ?? "Space"} · Artifacts · ${params.owner} · g1t`, description: loaded?.space.description ?? undefined });
}

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ space: DocSpace; list: FolioList | null }> {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const found = await docs.space(slug, params.space, viewer).catch(() => null);
  if (!found?.ok || found.value.space.archived_at) throw data(null, { status: 404 });
  const list = await folios
    .list(slug, viewer, { tab: "all", space_id: found.value.space.id, limit: 100 })
    .then((r) => (r.ok ? r.value : null))
    .catch(() => null);
  return { space: found.value.space, list };
}

/** A space: who it's for, joining it (an open one), making a doc in it, and everything in it the viewer can open, by day. */
export default function SpacePage({ loaderData, params }: Route.ComponentProps) {
  const slug = params.owner.toLowerCase();
  const { space, list } = loaderData;
  const layout = useFoliosData();
  const zone = useViewerZone();
  const { send, busy, error } = useFoliosAction(slug);
  const [failed, setFailed] = useState<string | null>(null);
  const starting = useNavigation().state !== "idle";
  const joined = (layout?.sidebar?.spaces ?? []).some((s) => s.id === space.id);
  const joinable = space.kind === "workspace" && !space.is_default;
  const who = space.kind === "workspace" ? `Everyone in the workspace (${space.default_role ? DOC_ROLE_LABELS[space.default_role].toLowerCase() : "listed members only"})` : space.kind === "team" ? `The ${space.team} team, and members added to it` : "Only its members";
  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-start gap-4">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-raised text-2xl">
          <SpaceIcon space={space} size={22} />
        </span>
        <div className="min-w-0 grow">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{space.name}</h1>
          <p className="mt-1 text-sm text-muted">{space.description || "No description."}</p>
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-faint">
            <span className="rounded-full px-2 py-0.5 ring-1 ring-line">{spaceKindLabel(space.kind)}</span>
            <span>{who}</span>
            <span>Agents here: {space.agent_mode === "edit" ? "edit directly" : "suggest changes"}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {joinable && (
            <Button type="button" disabled={busy} onClick={() => send(joined ? "leave_space" : "join_space", { space_id: space.id })} variant="outline" className="px-3 disabled:opacity-60 font-normal">
              {joined ? "Leave" : "Join"}
            </Button>
          )}
          {canDo(space.viewer_role, "manage") && (
            <Hint label="Space settings">
              <Link to={`${spacePath(slug, space.slug)}/settings`} aria-label="Space settings" className="flex size-9 items-center justify-center rounded-md border border-line text-muted hover:border-line-strong hover:bg-surface hover:text-fg">
                <Settings size={16} />
              </Link>
            </Hint>
          )}
          {canDo(space.viewer_role, "edit") && (
            <Form method="post" action={`/${slug}/-/artifacts/new/doc`}>
              <input type="hidden" name="space" value={space.id} />
              <Button type="submit" disabled={starting} variant="accent" className="gap-1.5 px-3 disabled:opacity-60">
                <FilePlus2 size={15} /> {starting ? "Starting…" : "New doc"}
              </Button>
            </Form>
          )}
        </div>
      </div>
      {(error || failed) && (
        <div className="mt-3">
          <ErrorText>{error ?? failed}</ErrorText>
        </div>
      )}
      <div className="mt-8 mb-8">
        {!list ? (
          <EmptyState title="Artifacts didn't answer">Try again in a moment.</EmptyState>
        ) : list.items.length === 0 ? (
          <EmptyState title="Nothing here yet">{canDo(space.viewer_role, "edit") ? "Start a doc with New doc, or move something here from its ⋯ menu." : "When someone adds an artifact here, it shows up for you."}</EmptyState>
        ) : (
          <FolioDays slug={slug} items={list.items} zone={zone} onError={setFailed} />
        )}
      </div>
    </div>
  );
}
