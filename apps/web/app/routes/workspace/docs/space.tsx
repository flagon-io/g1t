import { DOC_AGENT_MODE_LABELS, DOC_ROLE_LABELS, DOC_SPACE_KIND_LABELS, type DocPage, type DocSpace, type DocSpaceMember } from "@g1t/contracts";
import { Download, FilePlus2, Settings } from "lucide-react";
import { Link, data, useNavigate } from "react-router";

import type { Route } from "./+types/space";
import { useDocsAction } from "../../../components/docs/actions";
import { Face, SectionTitle } from "../../../components/docs/parts";
import { PageIcon, SpaceIcon } from "../../../components/docs/sidebar";
import { ButtonLink, EmptyState, ErrorText, TimeAgo } from "../../../components/ui";
import { buildTree, canDo, flatten } from "../../../lib/docs";
import { page } from "../../../lib/meta";
import { docs } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ loaderData: loaded, params, ...args }: Route.MetaArgs) {
  return page(args, { title: `${loaded?.space.name ?? "Space"} · Docs · ${params.owner} · g1t`, description: loaded?.space.description });
}

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ space: DocSpace; members: DocSpaceMember[]; pages: DocPage[] }> {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const found = await docs.space(params.owner.toLowerCase(), params.space, viewer);
  if (!found.ok) throw data(null, { status: found.error.code === "not_found" ? 404 : 403 });
  return found.value;
}

/** A space: what it is, who it's for, and its pages as a tree. */
export default function SpacePage({ loaderData, params }: Route.ComponentProps) {
  const slug = params.owner.toLowerCase();
  const { space, members, pages } = loaderData;
  const navigate = useNavigate();
  const { send, busy, error } = useDocsAction(slug);
  const tree = flatten(buildTree(pages.map((p) => ({ id: p.id, parent_id: p.parent_id, position: p.position, title: p.title, icon: p.icon, slug: p.slug }))));
  const byId = new Map(pages.map((p) => [p.id, p]));
  const create = async () => {
    const made = await send<{ path: string }>("create_page", { page: { space_id: space.id } });
    if (made.ok) navigate(made.value.path);
  };
  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex flex-wrap items-start gap-4">
        <span className="flex size-14 items-center justify-center rounded-2xl bg-raised text-2xl">
          <SpaceIcon space={space} size={26} />
        </span>
        <div className="min-w-0 grow">
          <h1 className="text-2xl font-semibold tracking-tight">{space.name}</h1>
          {space.description && <p className="mt-1 text-sm text-muted">{space.description}</p>}
          <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-faint">
            <span>{space.kind === "team" ? `Team @${space.team}` : DOC_SPACE_KIND_LABELS[space.kind]}</span>
            {space.default_role && <span>{DOC_ROLE_LABELS[space.default_role]}</span>}
            <span>Agents: {DOC_AGENT_MODE_LABELS[space.agent_mode].toLowerCase()}</span>
            <span>Your access: {DOC_ROLE_LABELS[space.viewer_role].toLowerCase()}</span>
            {space.projects.map((p) => (
              <Link key={p} to={`/${p}`} className="font-mono hover:text-fg">
                {p}
              </Link>
            ))}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a href={`/${slug}/-/docs/export?space=${encodeURIComponent(space.id)}`} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line px-3 text-sm text-fg/80 hover:bg-surface hover:text-fg">
            <Download size={15} /> Export
          </a>
          {canDo(space.viewer_role, "manage") && (
            <ButtonLink to={`/${slug}/-/docs/${space.slug}/settings`} variant="quiet">
              <Settings size={15} /> Settings
            </ButtonLink>
          )}
          {canDo(space.viewer_role, "edit") && (
            <button type="button" disabled={busy} onClick={create} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-bg hover:bg-accent-hover">
              <FilePlus2 size={15} /> New page
            </button>
          )}
        </div>
      </div>
      {error && (
        <div className="mt-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      <section className="mt-8">
        <SectionTitle>Pages</SectionTitle>
        {tree.length === 0 ? (
          <EmptyState title="No pages yet">{canDo(space.viewer_role, "edit") ? "Start with New page, or from a template." : "Nothing has been written here yet."}</EmptyState>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {tree.map((item) => {
              const p = byId.get(item.id)!;
              return (
                <li key={item.id}>
                  <Link to={p.path} prefetch="intent" className="flex items-center gap-3 py-2.5 pr-4 text-sm transition-colors hover:bg-raised" style={{ paddingLeft: 16 + item.depth * 20 }}>
                    <PageIcon icon={p.icon} />
                    <span className="min-w-0 grow truncate">{p.title || "Untitled"}</span>
                    <span className="hidden shrink-0 items-center gap-1.5 text-xs text-faint sm:flex">
                      {p.updated_by && <Face who={p.updated_by} size={14} />}
                      <TimeAgo at={p.updated_at} />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {members.length > 0 && (
        <section className="mt-8">
          <SectionTitle>Members</SectionTitle>
          <ul className="flex flex-wrap gap-2">
            {members.map((m) => (
              <li key={m.key} className="flex items-center gap-2 rounded-full border border-line bg-surface py-1 pr-3 pl-1 text-xs">
                {m.kind === "team" ? <span className="flex size-5 items-center justify-center rounded-full bg-raised text-[0.625rem]">@</span> : <Face who={{ kind: m.kind, id: m.key.slice(m.key.indexOf(":") + 1), name: m.name, avatar: m.avatar, avatar_seed: m.avatar_seed ?? null }} size={20} />}
                <span>{m.display_name}</span>
                <span className="text-faint">{DOC_ROLE_LABELS[m.role]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
