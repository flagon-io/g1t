/**
 * Pieces Docs' pages share: a page card, a space card, a face for a
 * person or an agent, a page's breadcrumbs, the template gallery.
 */
import type { DocPage, DocSpace, DocTemplate, MemberProfile } from "@g1t/contracts";
import { ChevronRight, Lock, Users } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { coverStyle } from "../../lib/docs";
import { AgentAvatar } from "../agent-avatar";
import { Avatar, TimeAgo } from "../ui";
import { Hint } from "../ui/hint";
import { PageIcon, SpaceIcon } from "./sidebar";

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

export function PageCard({ page, space }: { page: DocPage; space?: Pick<DocSpace, "name"> | null }) {
  const cover = coverStyle(page.cover);
  return (
    <Link to={page.path} prefetch="intent" className="group flex flex-col overflow-hidden rounded-xl border border-line bg-surface transition-colors hover:border-line-strong">
      <div className="h-14 shrink-0 border-b border-line" style={{ background: cover ?? "linear-gradient(120deg, color-mix(in srgb, var(--g1t-accent) 10%, var(--g1t-surface)), var(--g1t-surface))" }} />
      <div className="-mt-5 flex min-h-0 grow flex-col px-4 pb-3.5">
        <span className="flex size-9 items-center justify-center rounded-lg border border-line bg-bg text-lg">
          <PageIcon icon={page.icon} size={18} />
        </span>
        <span className="mt-2 flex items-center gap-2">
          <span className="line-clamp-1 min-w-0 text-sm font-medium text-fg group-hover:text-accent">{page.title || "Untitled"}</span>
          {page.stale && <span className="shrink-0 rounded-full bg-warn/12 px-1.5 py-px text-[0.625rem] font-medium text-warn">Possibly stale</span>}
        </span>
        <span className="mt-1 line-clamp-2 min-h-[2.5em] text-xs leading-relaxed text-muted">{page.excerpt || "Nothing written yet."}</span>
        <span className="mt-3 flex items-center gap-1.5 text-[0.6875rem] text-faint">
          {page.updated_by && <Face who={page.updated_by} size={14} />}
          <span className="truncate">
            {space ? `${space.name} · ` : ""}
            <TimeAgo at={page.updated_at} />
          </span>
        </span>
      </div>
    </Link>
  );
}

export function SpaceCard({ slug, space }: { slug: string; space: DocSpace }) {
  return (
    <Link to={`/${slug}/-/docs/${space.slug}`} prefetch="intent" className="group flex gap-3 rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-raised text-lg">
        <SpaceIcon space={space} size={18} />
      </span>
      <span className="min-w-0 grow">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-fg group-hover:text-accent">{space.name}</span>
          {space.kind === "private" && <Lock size={12} className="shrink-0 text-faint" aria-label="Private" />}
          {space.kind === "team" && <Users size={12} className="shrink-0 text-faint" aria-label="Team space" />}
        </span>
        <span className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted">{space.description || "No description."}</span>
        <span className="mt-2 block text-[0.6875rem] text-faint">
          {space.page_count} {space.page_count === 1 ? "page" : "pages"}
          {space.projects.length > 0 && ` · ${space.projects.join(", ")}`}
        </span>
      </span>
    </Link>
  );
}

export function TemplateCard({ template, action }: { template: DocTemplate; action: ReactNode }) {
  return (
    <div className="flex flex-col rounded-xl border border-line bg-surface p-4">
      <span className="text-2xl leading-none" aria-hidden="true">
        {template.icon}
      </span>
      <span className="mt-3 text-sm font-medium">{template.name}</span>
      <span className="mt-1 grow text-xs leading-relaxed text-muted">{template.description || (template.builtin ? "" : "Saved by your workspace.")}</span>
      <div className="mt-3 flex items-center gap-2">{action}</div>
    </div>
  );
}

export function Crumbs({ items }: { items: { label: ReactNode; to?: string }[] }) {
  return (
    <nav aria-label="Breadcrumbs" className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-faint">
      {items.map((item, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1">
          {i > 0 && <ChevronRight size={12} className="shrink-0" aria-hidden="true" />}
          {item.to ? (
            <Link to={item.to} prefetch="intent" className="truncate hover:text-fg">
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

/** A heading for a section of a Docs page. */
export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-sm font-semibold text-fg">{children}</h2>
      {action}
    </div>
  );
}
