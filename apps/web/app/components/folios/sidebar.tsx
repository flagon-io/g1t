/**
 * Artifacts mode's sidebar (beside the rail; docs.g1t.sh/guides/artifacts/,
 * "The sidebar"): search, Home, New and Templates; Favorites; the spaces
 * shown (joined open spaces, team spaces, members-only spaces) each with
 * its tree; Private, everything of yours in no space; Shared, the tops of
 * what others shared with you; then what's possibly out of date,
 * projects' docs folders (read-only) and the trash. Rows are dragged to
 * reorder them or to put one inside a doc.
 */
import { FOLIO_KINDS, folioIdFrom, folioSlug, type DocRepoSpace, type FolioKind, type FolioRef, type FolioTreeNode, type FoliosSidebarSpace } from "@g1t/contracts";
import { AlertTriangle, ChevronDown, ChevronRight, Compass, FileText, Folder, FolderGit2, Home, LayoutTemplate, Lock, Plus, Search, Settings, Star, Trash2, X } from "lucide-react";
import { type DragEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { NavLink, useLocation, useNavigate, useParams, useRevalidator } from "react-router";

import { buildTree, canDo, pathTo, repoFilePath, repoFolders, spacePath, type RepoFolder, type TreeItem } from "../../lib/folios";
import { Button } from "../ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { Hint } from "../ui/hint";
import { Skeleton } from "../ui/skeleton";
import { foliosRequest, useFoliosAction, useFoliosData } from "./actions";
import { RepoDocsDialog } from "./doc/code";
import { FOLIO_KIND_UI, FolioGlyph, KindIcon } from "./kinds";
import { SpaceIcon } from "./parts";

const ROW = "group flex h-8 items-center gap-1.5 rounded-md pr-1 text-[0.8125rem] transition-colors";
const ROW_BUTTON = "flex size-6 shrink-0 items-center justify-center rounded text-faint opacity-0 group-hover:opacity-100 hover:bg-line hover:text-fg focus-visible:opacity-100 pointer-coarse:size-9 pointer-coarse:opacity-100";

function SideLink({ to, end, icon, children, trailing }: { to: string; end?: boolean; icon: ReactNode; children: ReactNode; trailing?: ReactNode }) {
  return (
    <NavLink to={to} end={end} prefetch="intent" className={({ isActive }) => `${ROW} pl-2 ${isActive ? "bg-raised font-medium text-fg" : "text-muted hover:bg-raised/60 hover:text-fg"}`}>
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

/** "New ▾": the four kinds, the ones not here yet shown as coming. */
export function NewMenu({ onMake, children, align = "end" }: { onMake: (kind: FolioKind) => void; children: ReactNode; align?: "start" | "end" }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-52">
        {FOLIO_KINDS.map((kind) => {
          const ui = FOLIO_KIND_UI[kind];
          return (
            <DropdownMenuItem key={kind} disabled={!ui.ready} onSelect={() => onMake(kind)}>
              <KindIcon kind={kind} size={13} box={22} />
              <span className="grow">{ui.label}</span>
              {!ui.ready && <span className="text-[0.625rem] text-faint">Coming soon</span>}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type Drag = { id: string; place: string } | null;

/** Where a tree lives: a space (by id) or the viewer's Private (null). */
type Place = { space_id: string | null; key: string; editable: boolean };

function TreeRow({ slug, place, item, current, open, toggle, drag, setDrag, onDrop, onAdd }: { slug: string; place: Place; item: TreeItem; current: string | null; open: Set<string>; toggle: (id: string) => void; drag: Drag; setDrag: (d: Drag) => void; onDrop: (target: TreeItem, where: "before" | "inside") => void; onAdd: (parent: string) => void }) {
  const [over, setOver] = useState<"before" | "inside" | null>(null);
  const expanded = open.has(item.id);
  const active = current === item.id;
  const holds = item.kind === "doc";
  const zone = (e: DragEvent<HTMLElement>): "before" | "inside" => {
    if (!holds) return "before";
    const box = e.currentTarget.getBoundingClientRect();
    return e.clientY - box.top < box.height * 0.35 ? "before" : "inside";
  };
  return (
    <li>
      <div
        draggable={place.editable}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", item.id);
          setDrag({ id: item.id, place: place.key });
        }}
        onDragEnd={() => setDrag(null)}
        onDragOver={(e) => {
          if (!drag || drag.id === item.id || !place.editable) return;
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
        <NavLink to={`/${slug}/-/artifacts/${folioSlug(item.title, item.id)}`} prefetch="intent" className="flex min-w-0 grow items-center gap-1.5">
          <span className="flex w-4 shrink-0 justify-center">
            <FolioGlyph folio={item} size={14} />
          </span>
          <span className="min-w-0 truncate">{item.title || "Untitled"}</span>
          {item.restricted && (
            <Hint label="Only people invited">
              <Lock size={11} className="shrink-0 text-faint" aria-label="Only people invited" />
            </Hint>
          )}
          {item.stale && (
            <Hint label="Possibly out of date: code it cites changed">
              <span className="ml-auto size-1.5 shrink-0 rounded-full bg-warn" aria-label="Possibly out of date" />
            </Hint>
          )}
        </NavLink>
        {place.editable && holds && (
          <Hint label="Add a doc inside">
            <button type="button" onClick={() => onAdd(item.id)} aria-label={`Add a doc inside ${item.title || "Untitled"}`} className={ROW_BUTTON}>
              <Plus size={13} />
            </button>
          </Hint>
        )}
      </div>
      {expanded && item.children.length > 0 && (
        <ul>
          {item.children.map((child) => (
            <TreeRow key={child.id} slug={slug} place={place} item={child} current={current} open={open} toggle={toggle} drag={drag} setDrag={setDrag} onDrop={onDrop} onAdd={onAdd} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** A tree of folios in one place, opened to the one being read; drag to reorder or nest. */
function Tree({ slug, place, nodes, current, drag, setDrag, empty }: { slug: string; place: Place; nodes: FolioTreeNode[]; current: string | null; drag: Drag; setDrag: (d: Drag) => void; empty: string }) {
  const navigate = useNavigate();
  const { send } = useFoliosAction(slug);
  const tree = useMemo(() => buildTree(nodes), [nodes]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(pathTo(nodes, current)));
  // Opening an artifact opens the way to it.
  useEffect(() => {
    if (!current) return;
    const path = pathTo(nodes, current);
    if (path.length) setOpen((was) => new Set([...was, ...path]));
  }, [current, nodes]);
  const toggle = (id: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const add = async (parent: string) => {
    const made = await send<{ path: string }>("create", { folio: { kind: "doc", parent_id: parent } });
    if (made.ok) {
      setOpen((was) => new Set([...was, parent]));
      navigate(made.value.path);
    }
  };
  const drop = async (target: TreeItem, where: "before" | "inside") => {
    if (!drag) return;
    const move = where === "inside" ? { space_id: place.space_id, parent_id: target.id, before_id: null } : { space_id: place.space_id, parent_id: target.parent_id, before_id: target.id };
    setDrag(null);
    await send("move", { folio_id: drag.id, move });
    if (where === "inside") setOpen((was) => new Set([...was, target.id]));
  };
  return (
    <ul>
      {tree.map((item) => (
        <TreeRow key={item.id} slug={slug} place={place} item={item} current={current} open={open} toggle={toggle} drag={drag} setDrag={setDrag} onDrop={drop} onAdd={add} />
      ))}
      {tree.length === 0 && <li className="py-1 pr-2 pl-9 text-xs text-faint">{empty}</li>}
    </ul>
  );
}

function SpaceTree({ slug, space, current, drag, setDrag }: { slug: string; space: FoliosSidebarSpace; current: string | null; drag: Drag; setDrag: (d: Drag) => void }) {
  const navigate = useNavigate();
  const { send } = useFoliosAction(slug);
  const [collapsed, setCollapsed] = useState(false);
  const editable = canDo(space.viewer_role, "edit");
  const place: Place = { space_id: space.id, key: space.id, editable };
  return (
    <li className="mt-1">
      <div
        className={`${ROW} text-fg-soft`}
        onDragOver={(e) => {
          if (drag && editable) e.preventDefault();
        }}
        onDrop={async (e) => {
          // Dropped on the space itself: to its top, at the end.
          e.preventDefault();
          if (!drag) return;
          const id = drag.id;
          setDrag(null);
          await send("move", { folio_id: id, move: { space_id: space.id, parent_id: null, before_id: null } });
        }}
      >
        <Button type="button" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} aria-label={collapsed ? `Show ${space.name}` : `Hide ${space.name}`} variant="ghost" size="icon" className="size-5 rounded text-faint hover:bg-line">
          <ChevronRight size={13} className={`transition-transform ${collapsed ? "" : "rotate-90"}`} />
        </Button>
        <NavLink to={spacePath(slug, space.slug)} end prefetch="intent" className={({ isActive }) => `flex min-w-0 grow items-center gap-1.5 font-medium ${isActive ? "text-fg" : ""}`}>
          <span className="flex w-4 shrink-0 justify-center">
            <SpaceIcon space={space} size={14} />
          </span>
          <span className="min-w-0 truncate">{space.name}</span>
        </NavLink>
        {canDo(space.viewer_role, "manage") && (
          <Hint label="Space settings">
            <NavLink to={`${spacePath(slug, space.slug)}/settings`} aria-label={`${space.name} settings`} className={ROW_BUTTON}>
              <Settings size={13} />
            </NavLink>
          </Hint>
        )}
        {editable && (
          <Hint label={`New doc in ${space.name}`}>
            <button
              type="button"
              onClick={async () => {
                const made = await send<{ path: string }>("create", { folio: { kind: "doc", space_id: space.id } });
                if (made.ok) navigate(made.value.path);
              }}
              aria-label={`New doc in ${space.name}`}
              className={ROW_BUTTON}
            >
              <Plus size={13} />
            </button>
          </Hint>
        )}
      </div>
      {!collapsed && <Tree slug={slug} place={place} nodes={space.tree} current={current} drag={drag} setDrag={setDrag} empty="Nothing here yet." />}
    </li>
  );
}

function RepoFolderRows({ slug, repo, folder, depth, current }: { slug: string; repo: string; folder: RepoFolder; depth: number; current: string }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(folder.folders.filter((f) => current.includes(`/${f.path}/`)).map((f) => f.path)));
  return (
    <>
      {folder.files.map((f) => (
        <li key={f.path}>
          <NavLink to={repoFilePath(slug, repo, f.path)} prefetch="intent" className={({ isActive }) => `${ROW} ${isActive ? "bg-raised font-medium text-fg" : "text-muted hover:bg-raised/60 hover:text-fg"}`} style={{ paddingLeft: 26 + depth * 14 }}>
            <FileText size={14} className="shrink-0 text-faint" aria-hidden="true" />
            <span className="min-w-0 truncate">{f.title}</span>
          </NavLink>
        </li>
      ))}
      {folder.folders.map((sub) => {
        const expanded = open.has(sub.path);
        return (
          <li key={sub.path}>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() =>
                setOpen((was) => {
                  const next = new Set(was);
                  if (next.has(sub.path)) next.delete(sub.path);
                  else next.add(sub.path);
                  return next;
                })
              }
              className={`${ROW} w-full text-muted hover:bg-raised/60 hover:text-fg`}
              style={{ paddingLeft: 4 + (depth + 1) * 14 }}
            >
              <ChevronRight size={13} className={`shrink-0 text-faint transition-transform ${expanded ? "rotate-90" : ""}`} />
              <Folder size={14} className="shrink-0 text-faint" aria-hidden="true" />
              <span className="min-w-0 truncate">{sub.name}</span>
            </button>
            {expanded && (
              <ul>
                <RepoFolderRows slug={slug} repo={repo} folder={sub} depth={depth + 1} current={current} />
              </ul>
            )}
          </li>
        );
      })}
    </>
  );
}

/** A project's docs folder: read-only, its files as folders, from the repository's default branch. */
function RepoTree({ slug, space }: { slug: string; space: DocRepoSpace }) {
  const { pathname } = useLocation();
  const base = `/${slug}/-/artifacts/repo/${space.repo}/`;
  const here = decodeURIComponent(pathname).startsWith(base);
  const [collapsed, setCollapsed] = useState(!here);
  const root = useMemo(() => repoFolders(space.files), [space.files]);
  return (
    <li className="mt-1">
      <div className={`${ROW} text-fg-soft`}>
        <Button type="button" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} aria-label={collapsed ? `Show ${space.repo}'s docs` : `Hide ${space.repo}'s docs`} variant="ghost" size="icon" className="size-5 rounded text-faint hover:bg-line">
          <ChevronRight size={13} className={`transition-transform ${collapsed ? "" : "rotate-90"}`} />
        </Button>
        <span className="flex w-4 shrink-0 justify-center">
          <FolderGit2 size={14} className="text-faint" aria-hidden="true" />
        </span>
        <span className="min-w-0 grow truncate font-medium">{space.repo}</span>
      </div>
      {!collapsed && (
        <ul>
          <RepoFolderRows slug={slug} repo={space.repo} folder={root} depth={0} current={decodeURIComponent(pathname)} />
          {space.files.length === 0 && <li className="py-1 pr-2 pl-9 text-xs text-faint">{space.indexed_at ? "No docs folder or README." : "Reading its docs…"}</li>}
        </ul>
      )}
    </li>
  );
}

function RefRow({ folio, trailing }: { folio: FolioRef; trailing?: ReactNode }) {
  return (
    <li>
      <SideLink to={folio.path} icon={<FolioGlyph folio={folio} size={14} />} trailing={trailing}>
        {folio.title || "Untitled"}
      </SideLink>
    </li>
  );
}

export function FoliosSidebar({ slug, onClose }: { slug: string; onClose?: () => void }) {
  const data = useFoliosData();
  const navigate = useNavigate();
  const params = useParams();
  const current = folioIdFrom(params.folio);
  const [drag, setDrag] = useState<Drag>(null);
  const [query, setQuery] = useState("");
  const [addingRepo, setAddingRepo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { revalidate } = useRevalidator();
  const sidebar = data?.sidebar;
  const make = async (kind: FolioKind) => {
    setError(null);
    const made = await foliosRequest<{ path: string }>(slug, "create", { folio: { kind } });
    if (made.ok) {
      void revalidate();
      navigate(made.value.path);
    } else setError(made.error.message);
  };
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 pr-1 pl-3">
        <h2 className="min-w-0 grow truncate text-xs font-medium text-faint">Artifacts</h2>
        <NewMenu onMake={make}>
          <Button type="button" aria-label="New" variant="ghost" className="h-8 gap-0.5 px-1.5 text-faint">
            <Plus size={16} />
            <ChevronDown size={12} />
          </Button>
        </NewMenu>
        {onClose && (
          <Button type="button" aria-label="Close menu" onClick={onClose} variant="ghost" size="icon-sm" className="text-faint">
            <X size={16} />
          </Button>
        )}
      </div>
      <nav aria-label="Artifacts" className="min-h-0 grow overflow-y-auto px-2.5 pt-3 pb-4 [scrollbar-width:thin]">
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(`/${slug}/-/artifacts?q=${encodeURIComponent(query.trim())}`);
          }}
          className="mb-2"
        >
          <label className="flex h-8 items-center gap-2 rounded-md border border-line bg-bg px-2 text-[0.8125rem] text-faint focus-within:border-accent/60">
            <Search size={14} aria-hidden="true" />
            <span className="sr-only">Search artifacts</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search artifacts" className="min-w-0 grow bg-transparent text-fg outline-none placeholder:text-faint" />
          </label>
        </form>
        {error && <p className="mb-2 px-2 text-xs text-danger">{error}</p>}
        <div className="space-y-px">
          <SideLink to={`/${slug}/-/artifacts`} end icon={<Home size={15} />}>
            Home
          </SideLink>
          <SideLink to={`/${slug}/-/artifacts/templates`} icon={<LayoutTemplate size={15} />}>
            Templates
          </SideLink>
        </div>
        {sidebar === undefined || sidebar === null ? (
          sidebar === null ? (
            <p className="mt-4 px-2 text-xs leading-relaxed text-faint">Artifacts didn&apos;t answer. Your spaces will show here once it does.</p>
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
                  {sidebar.favorites.map((f) => (
                    <RefRow key={f.id} folio={f} trailing={<Star size={12} className="shrink-0 fill-current text-warn/80" aria-hidden="true" />} />
                  ))}
                </ul>
              </Section>
            )}
            <Section
              title="Spaces"
              action={
                <DropdownMenu>
                  <Hint label="Browse or make spaces">
                    <DropdownMenuTrigger asChild>
                      <Button type="button" aria-label="Browse or make spaces" variant="ghost" size="icon" className="size-6 rounded text-faint">
                        <Plus size={13} />
                      </Button>
                    </DropdownMenuTrigger>
                  </Hint>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem onSelect={() => navigate(`/${slug}/-/artifacts/spaces`)}>
                      <Compass size={14} /> Browse spaces
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => navigate(`/${slug}/-/artifacts/spaces/new`)}>
                      <Plus size={14} /> New space
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              }
            >
              <ul>
                {sidebar.spaces.map((space) => (
                  <SpaceTree key={space.id} slug={slug} space={space} current={current} drag={drag} setDrag={setDrag} />
                ))}
                {sidebar.spaces.length === 0 && <li className="px-2 py-1 text-xs text-faint">No spaces yet.</li>}
              </ul>
            </Section>
            <Section
              title="Private"
              action={
                <Hint label="New private doc">
                  <Button type="button" onClick={() => make("doc")} aria-label="New private doc" variant="ghost" size="icon" className="size-6 rounded text-faint">
                    <Plus size={13} />
                  </Button>
                </Hint>
              }
            >
              <div
                onDragOver={(e) => {
                  if (drag) e.preventDefault();
                }}
                onDrop={async (e) => {
                  // Dropped on Private's empty space: to its top, at the end.
                  if (e.target !== e.currentTarget || !drag) return;
                  e.preventDefault();
                  const id = drag.id;
                  setDrag(null);
                  const moved = await foliosRequest(slug, "move", { folio_id: id, move: { space_id: null, parent_id: null, before_id: null } });
                  if (moved.ok) void revalidate();
                  else setError(moved.error.message);
                }}
              >
                <Tree slug={slug} place={{ space_id: null, key: "private", editable: true }} nodes={sidebar.private_tree} current={current} drag={drag} setDrag={setDrag} empty="Only you can see what's here." />
              </div>
            </Section>
            {sidebar.shared.length > 0 && (
              <Section title="Shared">
                <ul className="space-y-px">
                  {sidebar.shared.map((f) => (
                    <RefRow key={f.id} folio={f} />
                  ))}
                </ul>
              </Section>
            )}
            <div className="mt-4 space-y-px">
              {!!sidebar.stale_count && (
                <SideLink to={`/${slug}/-/artifacts/stale`} icon={<AlertTriangle size={15} className="text-warn" />} trailing={<span className="text-[0.6875rem] text-warn tabular-nums">{sidebar.stale_count}</span>}>
                  Possibly out of date
                </SideLink>
              )}
            </div>
            <Section
              title="Projects' docs"
              open={(sidebar.repos ?? []).length > 0}
              action={
                <Hint label="Show a project's docs">
                  <Button type="button" onClick={() => setAddingRepo(true)} aria-label="Show a project's docs" variant="ghost" size="icon" className="size-6 rounded text-faint">
                    <Plus size={13} />
                  </Button>
                </Hint>
              }
            >
              <ul>
                {(sidebar.repos ?? []).map((space) => (
                  <RepoTree key={space.id} slug={slug} space={space} />
                ))}
                {(sidebar.repos ?? []).length === 0 && (
                  <li>
                    <button type="button" onClick={() => setAddingRepo(true)} className="px-2 py-1 text-left text-xs text-faint hover:text-fg">
                      Show a repository&apos;s docs folder here, read-only.
                    </button>
                  </li>
                )}
              </ul>
            </Section>
            <div className="mt-4 space-y-px">
              <SideLink to={`/${slug}/-/artifacts/trash`} icon={<Trash2 size={15} />} trailing={sidebar.trash_count ? <span className="text-[0.6875rem] text-faint tabular-nums">{sidebar.trash_count}</span> : undefined}>
                Trash
              </SideLink>
            </div>
            <RepoDocsDialog slug={slug} open={addingRepo} onOpenChange={setAddingRepo} shown={(sidebar.repos ?? []).map((r) => r.repo.toLowerCase())} onAdded={() => void revalidate()} />
          </>
        )}
      </nav>
    </div>
  );
}
