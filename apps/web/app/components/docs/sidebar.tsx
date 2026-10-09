/**
 * Docs mode's sidebar (beside the rail, docs/WORKSPACE.md "Shell"):
 * search, Home, Templates and Trash; Favorites and Recent; then each
 * space with its page tree, which opens to the page being read. Pages are
 * dragged to reorder them or to put one inside another; the ⋯ menu moves
 * them too, for keyboards and phones.
 */
import type { DocsSidebarSpace } from "@g1t/contracts";
import { BookOpen, ChevronRight, Clock, FileText, Home, LayoutTemplate, Lock, Plus, Search, Settings, Star, Trash2, Users } from "lucide-react";
import { type DragEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { NavLink, useLocation, useNavigate, useParams } from "react-router";

import { buildTree, canDo, pageIdOf, pagePath, pathTo, type TreeItem } from "../../lib/docs";
import { Hint } from "../ui/hint";
import { Skeleton } from "../ui/skeleton";
import { docsRequest, useDocsAction, useDocsData } from "./actions";

const ROW = "group flex h-8 items-center gap-1.5 rounded-md pr-1 text-[0.8125rem] transition-colors";

function SideLink({ to, end, icon, children, trailing }: { to: string; end?: boolean; icon: ReactNode; children: ReactNode; trailing?: ReactNode }) {
  return (
    <NavLink
      to={to}
      end={end}
      prefetch="intent"
      className={({ isActive }) => `${ROW} pl-2 ${isActive ? "bg-raised font-medium text-fg" : "text-muted hover:bg-raised/60 hover:text-fg"}`}
    >
      <span className="flex w-5 shrink-0 justify-center text-faint">{icon}</span>
      <span className="min-w-0 grow truncate">{children}</span>
      {trailing}
    </NavLink>
  );
}

function Section({ title, children, action, open: initially = true }: { title: string; children: ReactNode; action?: ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(initially);
  return (
    <section className="mt-4">
      <div className="mb-0.5 flex items-center gap-1 pr-1">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex grow items-center gap-1 rounded px-1 text-xs font-medium text-faint transition-colors hover:text-muted">
          <ChevronRight size={12} className={`transition-transform ${open ? "rotate-90" : ""}`} />
          {title}
        </button>
        {action}
      </div>
      {open && children}
    </section>
  );
}

/** A page's icon: its emoji, or the plain page. */
export function PageIcon({ icon, size = 15 }: { icon: string | null | undefined; size?: number }) {
  if (icon) return <span className="leading-none" style={{ fontSize: size - 1 }} aria-hidden="true">{icon}</span>;
  return <FileText size={size} className="text-faint" aria-hidden="true" />;
}

/** A space's icon: its emoji, or the book. */
export function SpaceIcon({ space, size = 15 }: { space: Pick<DocsSidebarSpace, "icon" | "kind">; size?: number }) {
  if (space.icon) return <span className="leading-none" style={{ fontSize: size - 1 }} aria-hidden="true">{space.icon}</span>;
  if (space.kind === "private") return <Lock size={size} className="text-faint" aria-hidden="true" />;
  if (space.kind === "team") return <Users size={size} className="text-faint" aria-hidden="true" />;
  return <BookOpen size={size} className="text-faint" aria-hidden="true" />;
}

type Drag = { id: string; space: string } | null;

function TreeRow({
  slug,
  space,
  item,
  current,
  open,
  toggle,
  drag,
  setDrag,
  onDrop,
  onAdd,
}: {
  slug: string;
  space: DocsSidebarSpace;
  item: TreeItem;
  current: string | null;
  open: Set<string>;
  toggle: (id: string) => void;
  drag: Drag;
  setDrag: (d: Drag) => void;
  onDrop: (target: TreeItem, where: "before" | "inside") => void;
  onAdd: (parent: string) => void;
}) {
  const [over, setOver] = useState<"before" | "inside" | null>(null);
  const expanded = open.has(item.id);
  const active = current === item.id;
  const editable = canDo(space.viewer_role, "edit");
  const zone = (e: DragEvent<HTMLElement>): "before" | "inside" => {
    const box = e.currentTarget.getBoundingClientRect();
    return e.clientY - box.top < box.height * 0.35 ? "before" : "inside";
  };
  return (
    <li>
      <div
        draggable={editable}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", item.id);
          setDrag({ id: item.id, space: space.id });
        }}
        onDragEnd={() => setDrag(null)}
        onDragOver={(e) => {
          if (!drag || drag.id === item.id || !editable) return;
          e.preventDefault();
          setOver(zone(e));
        }}
        onDragLeave={() => setOver(null)}
        onDrop={(e) => {
          e.preventDefault();
          const where = zone(e);
          setOver(null);
          if (drag && drag.id !== item.id) onDrop(item, where);
        }}
        className={`${ROW} relative ${active ? "bg-raised font-medium text-fg" : "text-muted hover:bg-raised/60 hover:text-fg"} ${over === "inside" ? "ring-1 ring-accent/60 ring-inset" : ""}`}
        style={{ paddingLeft: 4 + item.depth * 14 }}
      >
        {over === "before" && <span className="pointer-events-none absolute inset-x-1 -top-px h-0.5 rounded bg-accent" aria-hidden="true" />}
        <button
          type="button"
          onClick={() => toggle(item.id)}
          aria-label={expanded ? "Collapse" : "Expand"}
          aria-expanded={expanded}
          className={`flex size-5 shrink-0 items-center justify-center rounded text-faint hover:bg-line hover:text-fg ${item.children.length ? "" : "invisible"}`}
        >
          <ChevronRight size={13} className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
        </button>
        <NavLink to={pagePath(slug, space.slug, item.title, item.id)} prefetch="intent" className="flex min-w-0 grow items-center gap-1.5">
          <span className="flex w-4 shrink-0 justify-center">
            <PageIcon icon={item.icon} size={14} />
          </span>
          <span className="min-w-0 truncate">{item.title || "Untitled"}</span>
        </NavLink>
        {editable && (
          <Hint label="Add a page inside">
            <button
              type="button"
              onClick={() => onAdd(item.id)}
              aria-label={`Add a page inside ${item.title || "Untitled"}`}
              className="flex size-6 shrink-0 items-center justify-center rounded text-faint opacity-0 group-hover:opacity-100 hover:bg-line hover:text-fg focus-visible:opacity-100"
            >
              <Plus size={13} />
            </button>
          </Hint>
        )}
      </div>
      {expanded && item.children.length > 0 && (
        <ul>
          {item.children.map((child) => (
            <TreeRow key={child.id} slug={slug} space={space} item={child} current={current} open={open} toggle={toggle} drag={drag} setDrag={setDrag} onDrop={onDrop} onAdd={onAdd} />
          ))}
        </ul>
      )}
    </li>
  );
}

function SpaceTree({ slug, space, current, drag, setDrag }: { slug: string; space: DocsSidebarSpace; current: string | null; drag: Drag; setDrag: (d: Drag) => void }) {
  const navigate = useNavigate();
  const { send } = useDocsAction(slug);
  const tree = useMemo(() => buildTree(space.pages), [space.pages]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(pathTo(space.pages, current)));
  const [collapsed, setCollapsed] = useState(false);
  // Opening a page opens the way to it.
  useEffect(() => {
    if (!current) return;
    const path = pathTo(space.pages, current);
    if (path.length) setOpen((was) => new Set([...was, ...path]));
  }, [current, space.pages]);
  const toggle = (id: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const add = async (parent: string | null) => {
    const made = await send<{ path: string }>("create_page", { page: { space_id: space.id, parent_id: parent } });
    if (made.ok) {
      if (parent) setOpen((was) => new Set([...was, parent]));
      navigate(made.value.path);
    }
  };
  const drop = async (target: TreeItem, where: "before" | "inside") => {
    if (!drag) return;
    const move = where === "inside" ? { space_id: space.id, parent_id: target.id, before_id: null } : { space_id: space.id, parent_id: target.parent_id, before_id: target.id };
    setDrag(null);
    await send("move_page", { page_id: drag.id, move });
    if (where === "inside") setOpen((was) => new Set([...was, target.id]));
  };
  const editable = canDo(space.viewer_role, "edit");
  return (
    <li className="mt-1">
      <div
        className={`${ROW} text-fg-soft`}
        onDragOver={(e) => {
          if (drag && editable) e.preventDefault();
        }}
        onDrop={async (e) => {
          // Dropped on the space itself: to the top of it, at the end.
          e.preventDefault();
          if (!drag) return;
          const id = drag.id;
          setDrag(null);
          await send("move_page", { page_id: id, move: { space_id: space.id, parent_id: null, before_id: null } });
        }}
      >
        <button type="button" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} aria-label={collapsed ? `Show ${space.name}` : `Hide ${space.name}`} className="flex size-5 shrink-0 items-center justify-center rounded text-faint hover:bg-line hover:text-fg">
          <ChevronRight size={13} className={`transition-transform ${collapsed ? "" : "rotate-90"}`} />
        </button>
        <NavLink to={`/${slug}/-/docs/${space.slug}`} end prefetch="intent" className={({ isActive }) => `flex min-w-0 grow items-center gap-1.5 font-medium ${isActive ? "text-fg" : ""}`}>
          <span className="flex w-4 shrink-0 justify-center">
            <SpaceIcon space={space} size={14} />
          </span>
          <span className="min-w-0 truncate">{space.name}</span>
        </NavLink>
        {canDo(space.viewer_role, "manage") && (
          <Hint label="Space settings">
            <NavLink to={`/${slug}/-/docs/${space.slug}/settings`} aria-label={`${space.name} settings`} className="flex size-6 shrink-0 items-center justify-center rounded text-faint opacity-0 group-hover:opacity-100 hover:bg-line hover:text-fg focus-visible:opacity-100">
              <Settings size={13} />
            </NavLink>
          </Hint>
        )}
        {editable && (
          <Hint label={`New page in ${space.name}`}>
            <button type="button" onClick={() => add(null)} aria-label={`New page in ${space.name}`} className="flex size-6 shrink-0 items-center justify-center rounded text-faint opacity-0 group-hover:opacity-100 hover:bg-line hover:text-fg focus-visible:opacity-100">
              <Plus size={13} />
            </button>
          </Hint>
        )}
      </div>
      {!collapsed && (
        <ul>
          {tree.map((item) => (
            <TreeRow key={item.id} slug={slug} space={space} item={item} current={current} open={open} toggle={toggle} drag={drag} setDrag={setDrag} onDrop={drop} onAdd={add} />
          ))}
          {tree.length === 0 && <li className="py-1 pr-2 pl-9 text-xs text-faint">No pages yet.</li>}
        </ul>
      )}
    </li>
  );
}

export function DocsSidebar({ slug, onClose }: { slug: string; onClose?: () => void }) {
  const data = useDocsData();
  const navigate = useNavigate();
  const params = useParams();
  const { pathname } = useLocation();
  const current = pageIdOf(params.page);
  const [drag, setDrag] = useState<Drag>(null);
  const [query, setQuery] = useState("");
  const sidebar = data?.sidebar;
  const general = sidebar?.spaces.find((s) => s.is_default) ?? sidebar?.spaces.find((s) => canDo(s.viewer_role, "edit"));
  const newPage = async () => {
    if (!general) return;
    const made = await docsRequest<{ path: string }>(slug, "create_page", { page: { space_id: general.id } });
    if (made.ok) navigate(made.value.path);
  };
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center gap-1 border-b border-line pr-2.5 pl-4">
        <h2 className="min-w-0 grow truncate text-[0.9375rem] font-semibold">Docs</h2>
        {general && (
          <Hint label="New page">
            <button type="button" onClick={newPage} aria-label="New page" className="flex size-8 items-center justify-center rounded-md text-faint transition-colors hover:bg-raised hover:text-fg">
              <Plus size={16} />
            </button>
          </Hint>
        )}
        {onClose && (
          <button type="button" aria-label="Close menu" onClick={onClose} className="flex size-8 shrink-0 items-center justify-center rounded-md text-faint hover:bg-raised hover:text-fg">
            <ChevronRight size={16} className="rotate-180" />
          </button>
        )}
      </div>
      <nav aria-label="Docs" className="min-h-0 grow overflow-y-auto px-2.5 pt-3 pb-4 [scrollbar-width:thin]">
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(`/${slug}/-/docs/search?q=${encodeURIComponent(query.trim())}`);
          }}
          className="mb-2"
        >
          <label className="flex h-8 items-center gap-2 rounded-md border border-line bg-bg px-2 text-[0.8125rem] text-faint focus-within:border-accent/60">
            <Search size={14} aria-hidden="true" />
            <span className="sr-only">Search docs</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search docs" className="min-w-0 grow bg-transparent text-fg outline-none placeholder:text-faint" />
          </label>
        </form>
        <div className="space-y-px">
          <SideLink to={`/${slug}/-/docs`} end icon={<Home size={15} />}>
            Home
          </SideLink>
          <SideLink to={`/${slug}/-/docs/templates`} icon={<LayoutTemplate size={15} />}>
            Templates
          </SideLink>
          <SideLink to={`/${slug}/-/docs/trash`} icon={<Trash2 size={15} />} trailing={sidebar?.trash_count ? <span className="text-[0.6875rem] text-faint tabular-nums">{sidebar.trash_count}</span> : undefined}>
            Trash
          </SideLink>
        </div>
        {sidebar === undefined || sidebar === null ? (
          sidebar === null ? (
            <p className="mt-4 px-2 text-xs leading-relaxed text-faint">Docs didn&apos;t answer. Your spaces will show here once it does.</p>
          ) : (
            <div className="mt-5 space-y-3 px-2" aria-busy="true">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-3 w-36" />
              ))}
            </div>
          )
        ) : (
          <>
            {sidebar.favorites.length > 0 && (
              <Section title="Favorites">
                <ul className="space-y-px">
                  {sidebar.favorites.map((p) => (
                    <li key={p.id}>
                      <SideLink to={p.path} icon={<PageIcon icon={p.icon} size={14} />} trailing={<Star size={12} className="shrink-0 fill-current text-warn/80" aria-hidden="true" />}>
                        {p.title || "Untitled"}
                      </SideLink>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {sidebar.recent.length > 0 && (
              <Section title="Recent" open={false}>
                <ul className="space-y-px">
                  {sidebar.recent.slice(0, 6).map((p) => (
                    <li key={p.id}>
                      <SideLink to={p.path} icon={<Clock size={14} />}>
                        {p.title || "Untitled"}
                      </SideLink>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            <Section
              title="Spaces"
              action={
                sidebar.can_create_space ? (
                  <Hint label="New space">
                    <NavLink to={`/${slug}/-/docs/new`} aria-label="New space" className="flex size-6 items-center justify-center rounded text-faint hover:bg-raised hover:text-fg">
                      <Plus size={13} />
                    </NavLink>
                  </Hint>
                ) : undefined
              }
            >
              <ul>
                {sidebar.spaces.map((space) => (
                  <SpaceTree key={space.id} slug={slug} space={space} current={current} drag={drag} setDrag={setDrag} />
                ))}
              </ul>
            </Section>
            {pathname === `/${slug}/-/docs` && sidebar.spaces.length === 0 && <p className="mt-3 px-2 text-xs text-faint">No spaces you can read yet.</p>}
          </>
        )}
      </nav>
    </div>
  );
}

