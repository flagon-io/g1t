/**
 * Chat's cards for artifact links (docs/ARTIFACTS_MODE.md section 4.3 rule
 * 3): each viewer asks the site for their own, so someone who can open the
 * artifact sees its kind, title, space and last edit, and anyone else sees
 * only "An artifact you don't have access to", with no title. Looking is
 * not opening: a card never makes a link-shared artifact readable.
 */
import type { FolioKind, Result } from "@g1t/contracts";
import { Lock } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";

import { linkedArtifacts } from "../../lib/folios";
import { TimeAgo } from "../ui";
import { KindIcon } from "./kinds";

/** What the site answers for one link (routes/workspace/folios/api.ts `unfurl`); null: not for this viewer. */
type Card = { id: string; kind: FolioKind; title: string; icon: string | null; path: string; space: string | null; private: boolean; excerpt: string; edited_at: string; edited_by: string | null } | null;

/** The most cards one message shows. */
const MAX_CARDS = 3;
/** How long a card is kept in this tab before it is asked for again. */
const KEEP_MS = 60_000;

const cards = new Map<string, { at: number; card: Promise<Card | undefined> }>();

function cardFor(slug: string, id: string): Promise<Card | undefined> {
  const key = `${slug}/${id}`;
  const kept = cards.get(key);
  if (kept && Date.now() - kept.at < KEEP_MS) return kept.card;
  const card = fetch(`/${slug}/-/artifacts/api?unfurl=${encodeURIComponent(id)}`, { headers: { accept: "application/json" } })
    .then((r) => r.json() as Promise<Result<Card>>)
    .then((r) => (r.ok ? r.value : undefined))
    // Not answered: no card at all, rather than a wrong one.
    .catch(() => undefined);
  cards.set(key, { at: Date.now(), card });
  return card;
}

export function FolioUnfurls({ slug, body }: { slug: string; body: string }) {
  const ids = useMemo(() => linkedArtifacts(body, slug).slice(0, MAX_CARDS), [body, slug]);
  if (!ids.length) return null;
  return (
    <div className="mt-1.5 flex max-w-md flex-col gap-1.5">
      {ids.map((id) => (
        <Unfurl key={id} slug={slug} id={id} />
      ))}
    </div>
  );
}

function Unfurl({ slug, id }: { slug: string; id: string }) {
  const [card, setCard] = useState<Card | undefined | "loading">("loading");
  useEffect(() => {
    let live = true;
    void cardFor(slug, id).then((c) => live && setCard(c));
    return () => {
      live = false;
    };
  }, [slug, id]);
  if (card === "loading" || card === undefined) return null;
  if (card === null) {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-faint">
        <Lock size={14} className="shrink-0" />
        An artifact you don&apos;t have access to
      </div>
    );
  }
  return (
    <Link to={card.path} className="group flex items-start gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 transition-colors hover:border-line-strong">
      <KindIcon kind={card.kind} size={14} box={26} />
      <span className="min-w-0 grow">
        <span className="block truncate text-sm font-medium text-fg group-hover:text-accent">
          {card.icon && <span className="mr-1">{card.icon}</span>}
          {card.title || "Untitled"}
        </span>
        {card.excerpt && <span className="mt-0.5 line-clamp-2 text-xs text-muted">{card.excerpt}</span>}
        <span className="mt-0.5 flex items-center gap-1 text-[0.6875rem] text-faint">
          {card.private && <Lock size={10} aria-label="Only you can see this" />}
          {card.space ?? "Private"} · Edited <TimeAgo at={card.edited_at} />
          {card.edited_by ? ` by ${card.edited_by}` : ""}
        </span>
      </span>
    </Link>
  );
}
