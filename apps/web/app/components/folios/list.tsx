/**
 * Artifacts as lists show them: rows
 * grouped by the day they were last edited, in the viewer's time zone, or
 * cards with a picture drawn from each one's preview. Each has its kind,
 * who can see it, its space, when it was edited and by whom, and its ⋯
 * menu.
 */
import type { Folio } from "@g1t/contracts";
import { useMemo } from "react";
import { Link } from "react-router";

import { dayGroups } from "../../lib/folios";
import { TimeAgo } from "../ui";
import { Card } from "../ui/card";
import { Hint } from "../ui/hint";
import { useFoliosData } from "./actions";
import { FolioThumbnail, KindIcon, warmDocEditor } from "./kinds";

/**
 * On a link to a doc: as the link's own `prefetch="intent"` fetches the
 * page's code and data on hover or focus, this fetches the editor's, so
 * opening it is a navigation and nothing more.
 */
export function warmOnIntent(folio: Pick<Folio, "kind">): { onMouseEnter?: () => void; onFocus?: () => void; onTouchStart?: () => void } {
  if (folio.kind !== "doc") return {};
  return { onMouseEnter: warmDocEditor, onFocus: warmDocEditor, onTouchStart: warmDocEditor };
}
import { FolioMenu } from "./menu";
import { AccessMark } from "./parts";

/** Where it sits, in a word: its space; else your Private, or whose it is when it's someone else's. */
function placeOf(folio: Folio, me: string | undefined): string {
  if (folio.space) return folio.space.name;
  return `user:${folio.owner.id}` === me ? "Private" : folio.owner.display_name;
}

function Edited({ folio }: { folio: Folio }) {
  const by = folio.edited_by?.display_name;
  return (
    <Hint label={by ? `Edited by ${by}` : "Edited"}>
      <span className="shrink-0 text-xs whitespace-nowrap text-faint" tabIndex={-1}>
        Edited <TimeAgo at={folio.edited_at} />
      </span>
    </Hint>
  );
}

export function FolioRow({ slug, folio, onError }: { slug: string; folio: Folio; onError?: (message: string) => void }) {
  const me = useFoliosData()?.me.key;
  return (
    <li className="group relative flex items-center gap-3 px-3 py-2 transition-colors hover:bg-raised/60 sm:px-4">
      <KindIcon kind={folio.kind} />
      <span className="flex min-w-0 grow items-center gap-2">
        <Link to={folio.path} prefetch="intent" {...warmOnIntent(folio)} className="min-w-0 truncate text-sm text-fg after:absolute after:inset-0 hover:text-accent">
          {folio.icon && <span className="mr-1.5">{folio.icon}</span>}
          {folio.title || "Untitled"}
        </Link>
        {folio.stale && (
          <Hint label="Possibly out of date: code it cites changed">
            <span className="relative size-1.5 shrink-0 rounded-full bg-warn" aria-label="Possibly out of date" />
          </Hint>
        )}
      </span>
      <span className="relative hidden shrink-0 sm:flex">
        <AccessMark folio={folio} />
      </span>
      <span className="hidden w-32 shrink-0 truncate text-xs text-faint md:block">{placeOf(folio, me)}</span>
      <span className="relative w-28 shrink-0 text-right max-sm:w-auto">
        <Edited folio={folio} />
      </span>
      <span className="relative">
        <FolioMenu slug={slug} folio={folio} onError={onError} />
      </span>
    </li>
  );
}

/** Rows under Today, Yesterday, then dates. */
export function FolioDays({ slug, items, zone, onError }: { slug: string; items: Folio[]; zone: string; onError?: (message: string) => void }) {
  const days = useMemo(() => dayGroups(items, (f) => f.edited_at, zone), [items, zone]);
  return (
    <div className="space-y-6">
      {days.map((day) => (
        <section key={day.key} aria-label={day.label}>
          <h3 className="mb-1.5 px-1 text-xs font-medium text-faint">{day.label}</h3>
          <Card asChild divided className="overflow-hidden">
            <ul>
              {day.items.map((f) => (
                <FolioRow key={f.id} slug={slug} folio={f} onError={onError} />
              ))}
            </ul>
          </Card>
        </section>
      ))}
    </div>
  );
}

export function FolioCard({ slug, folio, onError }: { slug: string; folio: Folio; onError?: (message: string) => void }) {
  const me = useFoliosData()?.me.key;
  return (
    <Card className="group relative flex flex-col overflow-hidden transition-colors hover:border-line-strong">
      <div className="pointer-events-none h-32 shrink-0 border-b border-line">
        <FolioThumbnail folio={folio} />
      </div>
      <div className="flex items-start gap-2.5 px-3.5 pt-3 pb-3">
        <KindIcon kind={folio.kind} size={14} box={24} />
        <span className="min-w-0 grow">
          <Link to={folio.path} prefetch="intent" {...warmOnIntent(folio)} className="line-clamp-1 text-sm font-medium text-fg after:absolute after:inset-0 group-hover:text-accent">
            {folio.icon && <span className="mr-1">{folio.icon}</span>}
            {folio.title || "Untitled"}
          </Link>
          <span className="mt-0.5 flex items-center gap-1.5 text-[0.6875rem] text-faint">
            <span className="truncate">{placeOf(folio, me)}</span>
            <span aria-hidden="true">·</span>
            <span className="relative">
              <Edited folio={folio} />
            </span>
          </span>
        </span>
        <span className="relative -mt-1 -mr-1.5 flex items-center">
          <span className="relative">
            <AccessMark folio={folio} />
          </span>
          <FolioMenu slug={slug} folio={folio} onError={onError} />
        </span>
      </div>
    </Card>
  );
}

export function FolioGrid({ slug, items, onError }: { slug: string; items: Folio[]; onError?: (message: string) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {items.map((f) => (
        <FolioCard key={f.id} slug={slug} folio={f} onError={onError} />
      ))}
    </div>
  );
}
