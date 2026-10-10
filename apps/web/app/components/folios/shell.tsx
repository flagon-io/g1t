/**
 * The header every artifact's page shares, whatever its kind: where it
 * is (a space or Private,
 * then the docs it sits under), who is here, "Offline, changes will
 * sync", and Share, comments, history, favorite and the ⋯ menu. A kind's
 * own actions go in `actions`.
 */
import type { Folio, FolioRef } from "@g1t/contracts";
import { History, MessageSquare, Share2, Star, WifiOff } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useRevalidator } from "react-router";

import { spacePath } from "../../lib/folios";
import { ButtonLink } from "../ui";
import { Button } from "../ui/button";
import { Hint } from "../ui/hint";
import { foliosRequest } from "./actions";
import { FolioGlyph } from "./kinds";
import { FolioMenu } from "./menu";
import { Crumbs, Face } from "./parts";
import type { LiveStatus } from "./provider";
import { ShareDialog } from "./share-dialog";

/** Someone here now, as the live document's awareness says. */
export type Presence = { client: number; key: string; name: string; kind: "user" | "agent"; color: string; avatar: string | null; me: boolean };

export function FolioHeader({
  slug,
  folio,
  breadcrumbs,
  presence,
  status,
  comments,
  onError,
  onTrashed,
  actions,
}: {
  slug: string;
  folio: Folio;
  breadcrumbs: FolioRef[];
  presence: Presence[];
  status: LiveStatus;
  /** The comments toggle, for kinds that have comments. */
  comments?: { open: boolean; onToggle: () => void } | null;
  onError: (message: string) => void;
  onTrashed: () => void;
  actions?: ReactNode;
}) {
  const { revalidate } = useRevalidator();
  const [sharing, setSharing] = useState(false);
  const [favorite, setFavorite] = useState(folio.favorite);
  const others = presence.filter((p) => !p.me);
  const crumbs = [
    folio.space ? { label: folio.space.name, to: spacePath(slug, folio.space.slug) } : { label: "Private", to: `/${slug}/-/artifacts?space=private` },
    ...breadcrumbs.map((b) => ({ label: `${b.icon ? `${b.icon} ` : ""}${b.title || "Untitled"}`, to: b.path })),
    {
      label: (
        <span className="inline-flex items-center gap-1.5">
          <FolioGlyph folio={folio} size={13} />
          {folio.title || "Untitled"}
        </span>
      ),
    },
  ];
  return (
    // Right under the top bar, edge to edge, and one block with it (data-page-head in components/shell.tsx).
    <div data-page-head="sticky" className="sticky top-(--topbar-h) z-20 -mx-4 flex h-14 items-center gap-2 border-b border-line bg-bg/90 px-4 backdrop-blur sm:-mx-6 sm:px-5 lg:-mx-8">
      <div className="min-w-0 grow">
        <Crumbs items={crumbs} />
      </div>
      {status === "offline" && (
        <Hint label="Your changes are kept and sync when the connection is back.">
          <span className="flex items-center gap-1 text-xs text-warn" tabIndex={0}>
            <WifiOff size={13} /> <span className="max-sm:hidden">Offline, changes will sync</span>
          </span>
        </Hint>
      )}
      {others.length > 0 && (
        <span className="flex items-center -space-x-1.5 max-sm:hidden" aria-label={`${others.length} others here`}>
          {others.slice(0, 5).map((p) => (
            <Hint key={p.key} label={`${p.name}${p.kind === "agent" ? " (agent)" : ""}`}>
              <span className="rounded-full ring-2" style={{ ["--tw-ring-color" as string]: p.color }}>
                <Face who={{ kind: p.kind, id: p.key.slice(p.key.indexOf(":") + 1), name: p.name, avatar: p.avatar, avatar_seed: null }} size={24} />
              </span>
            </Hint>
          ))}
          {others.length > 5 && <span className="pl-3 text-xs text-faint">+{others.length - 5}</span>}
        </span>
      )}
      {actions}
      <Button type="button" onClick={() => setSharing(true)} variant="outline" size="sm" className="text-xs text-fg/85 hover:bg-raised max-md:size-10 max-md:justify-center max-md:px-0 font-normal" aria-label="Share">
        <Share2 size={13} /> <span className="max-md:hidden">Share</span>
      </Button>
      {comments && (
        <Hint label={comments.open ? "Hide comments" : "Comments"}>
          <Button type="button" onClick={comments.onToggle} aria-pressed={comments.open} aria-label="Comments" variant="ghost" size="icon-sm" className="text-faint max-md:size-10">
            <MessageSquare size={16} />
          </Button>
        </Hint>
      )}
      <Hint label="History">
        <ButtonLink to={`${folio.path}/history`} aria-label="History" variant="ghost" size="icon-sm" className="text-faint max-md:size-10 max-sm:hidden">
          <History size={16} />
        </ButtonLink>
      </Hint>
      <Hint label={favorite ? "Remove from Favorites" : "Add to Favorites"}>
        <Button
          type="button"
          aria-label={favorite ? "Remove from Favorites" : "Add to Favorites"}
          aria-pressed={favorite}
          onClick={async () => {
            setFavorite(!favorite);
            const done = await foliosRequest(slug, "favorite", { folio_id: folio.id, on: !favorite });
            if (done.ok) void revalidate();
            else {
              setFavorite(favorite);
              onError(done.error.message);
            }
          }}
          variant="ghost"
          size="icon-sm"
          className="text-faint max-md:size-10 max-sm:hidden aria-pressed:bg-transparent aria-pressed:text-faint"
        >
          <Star size={16} className={favorite ? "fill-current text-warn" : ""} />
        </Button>
      </Hint>
      <FolioMenu slug={slug} folio={{ ...folio, favorite }} page onError={onError} onTrashed={onTrashed} />
      <ShareDialog slug={slug} folio={folio} open={sharing} onOpenChange={setSharing} onChanged={() => void revalidate()} />
    </div>
  );
}
