/**
 * Each kind of artifact as the site shows it: its icon and colour, whether
 * it can be made yet, and its page body. One line per kind, so each kind's
 * phase adds its own (docs/ARTIFACTS_MODE.md section 8: slides, design and
 * dashboards are "Coming soon" until theirs ships). Bodies are lazy, so
 * Home and the sidebar carry no editor code.
 */
import { FOLIO_KIND_LABELS, type DocRole, type Folio, type FolioKind, type FolioPage, type FolioPreview } from "@g1t/contracts";
import { FileText, LayoutDashboard, type LucideIcon, PenTool, Presentation } from "lucide-react";
import { type ComponentType, type LazyExoticComponent, lazy } from "react";

import type { LiveStatus } from "./provider";
import type { Presence } from "./shell";

/**
 * What a kind's page body is given: the folio's page and the folio as it
 * is now, the viewer's role, and the header's comment toggle; it tells the
 * header who is here, how the connection is, and what changed live.
 */
export type FolioBodyProps = {
  slug: string;
  page: FolioPage;
  folio: Folio;
  role: DocRole;
  showComments: boolean;
  onPresence: (people: Presence[]) => void;
  onStatus: (status: LiveStatus) => void;
  /** A rename or another change to the folio, from the room. */
  onFolio: (folio: Folio) => void;
  /** The viewer's role changed; null: their access ended. */
  onRole: (role: DocRole | null) => void;
  onError: (message: string) => void;
};

export type FolioKindUi = {
  label: string;
  icon: LucideIcon;
  /** Tailwind classes for the kind's icon on its soft square. */
  tone: string;
  /** False: its tile says "Coming soon" and nothing makes one yet. */
  ready: boolean;
  beta?: boolean;
  /** Can be edited on a phone (docs can; a design canvas can't). */
  mobileEditable: boolean;
  Body: LazyExoticComponent<ComponentType<FolioBodyProps>> | null;
};

export const FOLIO_KIND_UI: Record<FolioKind, FolioKindUi> = {
  doc: { label: FOLIO_KIND_LABELS.doc, icon: FileText, tone: "text-info bg-info/12", ready: true, mobileEditable: true, Body: lazy(() => import("./doc/body")) },
  slides: { label: FOLIO_KIND_LABELS.slides, icon: Presentation, tone: "text-warn bg-warn/12", ready: false, mobileEditable: false, Body: null },
  design: { label: FOLIO_KIND_LABELS.design, icon: PenTool, tone: "text-merged bg-merged/12", ready: false, mobileEditable: false, Body: null },
  dashboard: { label: FOLIO_KIND_LABELS.dashboard, icon: LayoutDashboard, tone: "text-success bg-success/12", ready: false, beta: true, mobileEditable: false, Body: null },
};

/** A kind's icon in its colour on a soft square, as list rows and tiles show it. */
export function KindIcon({ kind, size = 16, box = 28 }: { kind: FolioKind; size?: number; box?: number }) {
  const ui = FOLIO_KIND_UI[kind];
  const Icon = ui.icon;
  return (
    <span className={`flex shrink-0 items-center justify-center rounded-md ${ui.tone}`} style={{ width: box, height: box }} aria-hidden="true">
      <Icon size={size} />
    </span>
  );
}

/** A folio's own icon: its emoji, or its kind's icon in its colour (no square). */
export function FolioGlyph({ folio, size = 15 }: { folio: { kind: FolioKind; icon: string | null }; size?: number }) {
  if (folio.icon) {
    return (
      <span className="leading-none" style={{ fontSize: size - 1 }} aria-hidden="true">
        {folio.icon}
      </span>
    );
  }
  const ui = FOLIO_KIND_UI[folio.kind];
  const Icon = ui.icon;
  return <Icon size={size} className={ui.tone.split(" ")[0]} aria-hidden="true" />;
}

/**
 * A card's picture, drawn from `preview` (written when the folio is
 * saved; never data values): a doc's first lines, a deck's first slide, a
 * design's frame, a dashboard's tile boxes.
 */
export function FolioThumbnail({ folio }: { folio: Pick<Folio, "kind" | "preview" | "excerpt" | "title"> }) {
  const preview: FolioPreview | null = folio.preview;
  if (preview?.kind === "doc" || (!preview && folio.kind === "doc")) {
    const lines = preview?.kind === "doc" ? preview.lines : folio.excerpt ? [folio.excerpt] : [];
    return (
      <div className="h-full overflow-hidden bg-bg px-4 pt-4 text-[0.6875rem] leading-relaxed text-muted">
        <p className="mb-1.5 line-clamp-1 text-xs font-semibold text-fg-soft">{folio.title || "Untitled"}</p>
        {lines.length ? (
          lines.slice(0, 6).map((line, i) => (
            <p key={i} className="line-clamp-2">
              {line}
            </p>
          ))
        ) : (
          <div className="space-y-1.5 pt-1" aria-hidden="true">
            <div className="h-1.5 w-11/12 rounded bg-line" />
            <div className="h-1.5 w-4/5 rounded bg-line" />
            <div className="h-1.5 w-2/3 rounded bg-line" />
          </div>
        )}
      </div>
    );
  }
  // The other kinds draw their own once they ship; until then, the kind's mark.
  return (
    <div className="flex h-full items-center justify-center bg-bg">
      <KindIcon kind={folio.kind} size={22} box={44} />
    </div>
  );
}
