/**
 * Pieces Artifacts' pages share: a face for a person or an agent, who an
 * artifact is shared with, breadcrumbs, a space's icon, a section heading,
 * a template card.
 */
import { FOLIO_SPACE_KIND_LABELS, type DocSpaceKind, type Folio, type FolioTemplate, type MemberProfile } from "@g1t/contracts";
import { ChevronRight, Globe, Library, Link2, Lock, Users } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { AgentAvatar } from "../agent-avatar";

import { Avatar } from "../ui/avatar";
import { Card } from "../ui/card";
import { Hint } from "../ui/hint";
import { KindIcon } from "./kinds";

export function Face({ who, size = 20 }: { who: Pick<MemberProfile, "kind" | "id" | "name" | "avatar" | "avatar_seed">; size?: number }) {
  if (who.kind === "agent") return <AgentAvatar agent={{ id: who.id, handle: who.name, avatar: who.avatar, avatar_seed: who.avatar_seed ?? null }} size={size} />;
  return <Avatar name={who.name} image={who.avatar} size={size} />;
}

export function Faces({ people, size = 22, max = 4 }: { people: MemberProfile[]; size?: number; max?: number }) {
  const shown = people.slice(0, max);
  return (
    <span className="flex items-center -space-x-1.5">
      {shown.map((p) => (
        <Hint key={`${p.kind}:${p.id}`} label={p.display_name}>
          <span className="rounded-full ring-2 ring-bg">
            <Face who={p} size={size} />
          </span>
        </Hint>
      ))}
      {people.length > max && <span className="ml-2 text-xs text-faint">+{people.length - max}</span>}
    </span>
  );
}

/** A space's icon: its emoji, or one for who it's for. */
export function SpaceIcon({ space, size = 15 }: { space: { icon: string | null; kind: DocSpaceKind }; size?: number }) {
  if (space.icon) {
    return (
      <span className="leading-none" style={{ fontSize: size - 1 }} aria-hidden="true">
        {space.icon}
      </span>
    );
  }
  if (space.kind === "private") return <Lock size={size} className="text-faint" aria-hidden="true" />;
  if (space.kind === "team") return <Users size={size} className="text-faint" aria-hidden="true" />;
  return <Library size={size} className="text-faint" aria-hidden="true" />;
}

/** Who a space is for, in its words: Open, Team, Members only. */
export function spaceKindLabel(kind: DocSpaceKind): string {
  return FOLIO_SPACE_KIND_LABELS[kind];
}

/**
 * Who can open an artifact, in a glance: a lock when only its owner can,
 * else the way it is opened up (the workspace, a link) and how many it is
 * shared with directly.
 */
export function AccessMark({ folio }: { folio: Pick<Folio, "private" | "general_access" | "shared_count" | "space" | "inherit"> }) {
  if (folio.private) {
    return (
      <Hint label="Only you can see this">
        <span className="flex size-5 items-center justify-center text-faint" aria-label="Only you can see this">
          <Lock size={13} />
        </span>
      </Hint>
    );
  }
  if (folio.general_access === "workspace") {
    return (
      <Hint label="Everyone in the workspace can open it">
        <span className="flex size-5 items-center justify-center text-faint" aria-label="Everyone in the workspace">
          <Globe size={13} />
        </span>
      </Hint>
    );
  }
  if (folio.general_access === "link") {
    return (
      <Hint label="Anyone in the workspace with the link can open it">
        <span className="flex size-5 items-center justify-center text-faint" aria-label="Anyone in the workspace with the link">
          <Link2 size={13} />
        </span>
      </Hint>
    );
  }
  if (folio.shared_count > 0) {
    const label = `Shared with ${folio.shared_count} ${folio.shared_count === 1 ? "other" : "others"}${folio.space && folio.inherit ? ` and ${folio.space.name}` : ""}`;
    return (
      <Hint label={label}>
        <span className="flex h-5 items-center gap-0.5 text-[0.6875rem] text-faint tabular-nums" aria-label={label}>
          <Users size={13} /> {folio.shared_count}
        </span>
      </Hint>
    );
  }
  return null;
}

export function Crumbs({ items }: { items: { label: ReactNode; to?: string }[] }) {
  return (
    <nav aria-label="Breadcrumbs" className="flex min-w-0 items-center gap-1 overflow-hidden text-xs text-faint">
      {items.map((item, i) => (
        <span key={i} className={`flex items-center gap-1 ${i === items.length - 1 ? "min-w-0" : "shrink-0 max-sm:hidden"}`}>
          {i > 0 && <ChevronRight size={12} className="shrink-0" aria-hidden="true" />}
          {item.to ? (
            <Link to={item.to} prefetch="intent" className="max-w-48 truncate hover:text-fg">
              {item.label}
            </Link>
          ) : (
            <span className="truncate text-muted">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

/** A heading for a section of an Artifacts page. */
export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-sm font-semibold text-fg">{children}</h2>
      {action}
    </div>
  );
}

export function TemplateCard({ template, action }: { template: FolioTemplate; action: ReactNode }) {
  return (
    <Card className="flex flex-col p-4">
      <span className="flex items-center gap-2">
        {template.icon ? (
          <span className="text-2xl leading-none" aria-hidden="true">
            {template.icon}
          </span>
        ) : (
          <KindIcon kind={template.kind} />
        )}
      </span>
      <span className="mt-3 text-sm font-medium">{template.name}</span>
      <span className="mt-1 grow text-xs leading-relaxed text-muted">{template.description || (template.builtin ? "" : `Saved by ${template.created_by?.display_name ?? "your workspace"}.`)}</span>
      <div className="mt-3 flex items-center gap-2">{action}</div>
    </Card>
  );
}
