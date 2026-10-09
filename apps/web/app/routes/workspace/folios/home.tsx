import { FOLIO_KINDS, isFolioKind, type Folio, type FolioKind, type FolioList } from "@g1t/contracts";
import { ChevronDown, LayoutGrid, LayoutTemplate, List, Search, SlidersHorizontal, Users } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Form, Link, data, useNavigation, useSearchParams } from "react-router";

import type { Route } from "./+types/home";

import { foliosQuery, useFoliosData, useViewerZone } from "../../../components/folios/actions";
import { FOLIO_KIND_UI, KindIcon } from "../../../components/folios/kinds";
import { FolioDays, FolioGrid } from "../../../components/folios/list";
import { FoliosSidebar } from "../../../components/folios/sidebar";
import { BottomSheet } from "../../../components/mobile";
import { EmptyState, ErrorText } from "../../../components/ui";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { Hint } from "../../../components/ui/hint";
import { SelectField } from "../../../components/ui/select";
import { TabStrip } from "../../../components/ui/tab-strip";
import { canDo, listQuery } from "../../../lib/folios";
import { page } from "../../../lib/meta";
import { folios, identity, repos } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Artifacts · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ list: FolioList | null; projects: string[] }> {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const search = new URL(request.url).searchParams;
  const query = listQuery(search);
  // The owner filter is a username in the address; the service keys people by id.
  const ownerName = search.get("owner");
  if (ownerName) {
    const user = await identity.userByUsername(ownerName.toLowerCase()).catch(() => null);
    query.owner = user ? `user:${user.id}` : "user:nobody";
  }
  const [list, projects] = await Promise.all([
    folios
      .list(slug, viewer, query)
      .then((r) => (r.ok ? r.value : null))
      .catch(() => null),
    repos
      .list(viewer, { namespace: slug })
      .then((found) => found.filter((r) => !r.forkOf).map((r) => `${r.namespace}/${r.name}`.toLowerCase()))
      .catch(() => [] as string[]),
  ]);
  return { list, projects };
}

const TABS = [
  { key: "all", label: "All" },
  { key: "yours", label: "Yours" },
  { key: "shared", label: "Shared with you" },
] as const;

const EMPTY: Record<string, { title: string; body: string }> = {
  all: { title: "No artifacts yet", body: "Start a doc above. Everything you and your workspace make shows up here." },
  yours: { title: "Nothing of yours yet", body: "What you make is yours, in Private until you share it or move it to a space." },
  shared: { title: "Nothing shared with you yet", body: "When someone shares an artifact with you, it shows up here." },
};

/**
 * Artifacts' home (docs/ARTIFACTS_MODE.md section 6.2): search and
 * filters, All / Yours / Shared with you, tiles to make something new,
 * and everything you can open, grouped by the day it was last edited, or
 * as cards.
 */
export default function FoliosHome({ loaderData, params }: Route.ComponentProps) {
  const slug = params.owner.toLowerCase();
  const { list, projects } = loaderData;
  const layout = useFoliosData();
  const zone = useViewerZone();
  const [search, setSearch] = useSearchParams();
  const tab = search.get("tab") === "yours" || search.get("tab") === "shared" ? search.get("tab")! : "all";
  const view = search.get("view") === "grid" ? "grid" : "list";
  const q = search.get("q") ?? "";
  const filtered = ["kind", "space", "owner", "project"].some((k) => search.get(k));
  const [items, setItems] = useState<Folio[]>(list?.items ?? []);
  const [cursor, setCursor] = useState<string | null>(list?.next_cursor ?? null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const searchBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setItems(list?.items ?? []);
    setCursor(list?.next_cursor ?? null);
  }, [list]);
  // `/` goes to the search box, as everywhere a page has one.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || target?.closest("input, textarea, [contenteditable=true]")) return;
      e.preventDefault();
      searchBox.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const href = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(search);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    next.delete("cursor");
    const s = next.toString();
    return s ? `?${s}` : ".";
  };
  const set = (changes: Record<string, string | null>) =>
    setSearch(
      (was) => {
        const next = new URLSearchParams(was);
        for (const [k, v] of Object.entries(changes)) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        next.delete("cursor");
        return next;
      },
      { preventScrollReset: true },
    );
  const showMore = async () => {
    if (!cursor) return;
    setMore(true);
    const next = new URLSearchParams(search);
    next.set("list", "1");
    next.set("cursor", cursor);
    const page = await foliosQuery<FolioList>(slug, Object.fromEntries(next));
    setMore(false);
    if (!page.ok) return setError(page.error.message);
    setItems((was) => [...was, ...page.value.items.filter((f) => !was.some((w) => w.id === f.id))]);
    setCursor(page.value.next_cursor);
  };
  const spaces = layout?.sidebar?.spaces ?? [];
  const filters = (
    <>
      <SelectField
        aria-label="Kind"
        value={search.get("kind") ?? "any"}
        onValueChange={(v) => set({ kind: v === "any" ? null : v })}
        options={[{ value: "any", label: "Any kind" }, ...FOLIO_KINDS.map((k) => ({ value: k, label: FOLIO_KIND_UI[k].label }))]}
        className="h-9 min-w-32"
      />
      <SelectField
        aria-label="Space"
        value={search.get("space") ?? "any"}
        onValueChange={(v) => set({ space: v === "any" ? null : v })}
        options={[{ value: "any", label: "Any space" }, { value: "private", label: "Private" }, ...spaces.map((s) => ({ value: s.id, label: s.name }))]}
        className="h-9 min-w-32"
      />
      <SelectField
        aria-label="Owner"
        value={search.get("owner") ?? "any"}
        onValueChange={(v) => set({ owner: v === "any" ? null : v })}
        options={[{ value: "any", label: "Anyone" }, ...(layout?.mentionables ?? []).filter((m) => m.kind === "user").map((m) => ({ value: m.name, label: m.name === layout?.me.name ? "You" : m.display_name }))]}
        className="h-9 min-w-32"
      />
      {projects.length > 0 && (
        <SelectField
          aria-label="Project"
          value={search.get("project") ?? "any"}
          onValueChange={(v) => set({ project: v === "any" ? null : v })}
          options={[{ value: "any", label: "Any project" }, ...projects.map((p) => ({ value: p, label: p }))]}
          className="h-9 min-w-40"
        />
      )}
    </>
  );
  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="grow text-2xl font-semibold tracking-tight">Artifacts</h1>
        <Hint label="Templates">
          <Link to={`/${slug}/-/artifacts/templates`} aria-label="Templates" className="flex size-9 items-center justify-center rounded-md border border-line text-muted transition-colors hover:border-line-strong hover:bg-surface hover:text-fg">
            <LayoutTemplate size={16} />
          </Link>
        </Hint>
      </div>

      <MakeTiles slug={slug} spaces={spaces.filter((s) => canDo(s.viewer_role, "edit")).map((s) => ({ id: s.id, name: s.name }))} />

      <div className="mt-8 flex flex-wrap items-center gap-2">
        <Form method="get" className="flex h-9 min-w-0 grow items-center gap-2 rounded-md border border-line bg-surface px-3 focus-within:border-accent/60 sm:max-w-sm" onSubmit={(e) => (e.preventDefault(), set({ q: (new FormData(e.currentTarget).get("q") as string).trim() || null }))}>
          <Search size={15} className="text-faint" aria-hidden="true" />
          <input ref={searchBox} key={q} name="q" defaultValue={q} placeholder="Search artifacts" aria-label="Search artifacts" className="min-w-0 grow bg-transparent text-sm outline-none placeholder:text-faint" />
          <kbd className="hidden rounded border border-line px-1.5 font-mono text-[0.625rem] text-faint sm:inline">/</kbd>
        </Form>
        <div className="hidden flex-wrap items-center gap-2 md:flex">{filters}</div>
        <button type="button" onClick={() => setFiltersOpen(true)} className={`inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm md:hidden ${filtered ? "border-accent/50 text-accent" : "border-line text-muted"}`}>
          <SlidersHorizontal size={14} /> Filters
        </button>
        <div className="ml-auto hidden items-center rounded-md border border-line p-0.5 md:flex" role="group" aria-label="Show as">
          <ViewButton active={view === "list"} label="List" to={href({ view: null })}>
            <List size={15} />
          </ViewButton>
          <ViewButton active={view === "grid"} label="Grid" to={href({ view: "grid" })}>
            <LayoutGrid size={15} />
          </ViewButton>
        </div>
      </div>
      <BottomSheet open={filtersOpen} onOpenChange={setFiltersOpen} title="Filters">
        <div className="flex flex-col gap-2 px-3 pb-4 [&>*]:w-full">{filters}</div>
      </BottomSheet>

      <TabStrip label="Which artifacts" className="mt-5 gap-1 border-b border-line">
        {TABS.map((t) => (
          <Link
            key={t.key}
            to={href({ tab: t.key === "all" ? null : t.key })}
            preventScrollReset
            data-active={tab === t.key}
            aria-current={tab === t.key ? "page" : undefined}
            className={`-mb-px flex items-center gap-2 border-b-2 px-3 pb-3 text-sm whitespace-nowrap transition-colors ${tab === t.key ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg"}`}
          >
            {t.key === "shared" && <Users size={14} />}
            {t.label}
          </Link>
        ))}
      </TabStrip>

      {error && (
        <div className="mt-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}

      <div className="mt-5 mb-8">
        {!list ? (
          <EmptyState title="Artifacts didn't answer">Try again in a moment.</EmptyState>
        ) : items.length === 0 ? (
          q || filtered ? (
            <EmptyState title="Nothing matches">
              <Link to={href({ q: null, kind: null, space: null, owner: null, project: null })} className="text-accent hover:underline">
                Clear the search and filters
              </Link>
            </EmptyState>
          ) : (
            <EmptyState title={EMPTY[tab]!.title}>{EMPTY[tab]!.body}</EmptyState>
          )
        ) : view === "grid" ? (
          <>
            <div className="hidden md:block">
              <FolioGrid slug={slug} items={items} onError={setError} />
            </div>
            <div className="md:hidden">
              <FolioDays slug={slug} items={items} zone={zone} onError={setError} />
            </div>
          </>
        ) : (
          <FolioDays slug={slug} items={items} zone={zone} onError={setError} />
        )}
        {cursor && (
          <div className="mt-4 flex justify-center">
            <button type="button" onClick={showMore} disabled={more} className="inline-flex h-9 items-center rounded-md border border-line px-4 text-sm text-muted hover:border-line-strong hover:text-fg disabled:opacity-60">
              {more ? "Loading…" : "Show more"}
            </button>
          </div>
        )}
      </div>

      {/* On a phone, the sidebar's places below the list: the mode's sheet has them too. */}
      <div className="-mx-4 border-t border-line md:hidden">
        <div className="h-[60dvh]">
          <FoliosSidebar slug={slug} />
        </div>
      </div>
    </div>
  );
}

function ViewButton({ active, label, to, children }: { active: boolean; label: string; to: string; children: ReactNode }) {
  return (
    <Hint label={label}>
      <Link to={to} preventScrollReset aria-label={label} aria-pressed={active} className={`flex size-7 items-center justify-center rounded ${active ? "bg-raised text-fg" : "text-faint hover:text-fg"}`}>
        {children}
      </Link>
    </Hint>
  );
}

/**
 * "Make something new": a tile per kind. Docs makes one at once (a form
 * post, so it can't go twice), its chevron starts from a template or in a
 * space; the kinds still to come say so.
 */
function MakeTiles({ slug, spaces }: { slug: string; spaces: { id: string; name: string }[] }) {
  const navigation = useNavigation();
  const starting = navigation.state !== "idle" && navigation.formMethod?.toUpperCase() === "POST" && navigation.formAction?.includes("/-/artifacts/new/");
  const [choosing, setChoosing] = useState(false);
  return (
    <div className="-mx-4 mt-5 flex snap-x gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:grid sm:grid-cols-4 sm:overflow-visible sm:px-0">
      {FOLIO_KINDS.map((kind) => {
        const ui = FOLIO_KIND_UI[kind];
        const body = (
          <>
            <KindIcon kind={kind} size={18} box={36} />
            <span className="mt-3 flex items-center gap-1.5 text-sm font-medium text-fg">
              {ui.label}
              {ui.beta && <span className="rounded-full px-1.5 py-px text-[0.625rem] font-medium tracking-wide text-muted uppercase ring-1 ring-line">Beta</span>}
            </span>
            <span className="mt-0.5 text-xs text-faint">{ui.ready ? (starting ? "Starting…" : tileLine(kind)) : "Coming soon"}</span>
          </>
        );
        if (!ui.ready) {
          return (
            <Hint key={kind} label={`${COMING[kind]} are coming soon.`}>
              <div tabIndex={0} aria-disabled="true" className="flex w-40 shrink-0 snap-start flex-col rounded-xl border border-dashed border-line bg-surface/40 p-4 opacity-60 sm:w-auto">
                {body}
              </div>
            </Hint>
          );
        }
        return (
          <div key={kind} className="relative flex w-40 shrink-0 snap-start sm:w-auto">
            <Form method="post" action={`/${slug}/-/artifacts/new/${kind}`} className="flex grow">
              <button type="submit" disabled={starting} aria-busy={starting} className="flex grow flex-col rounded-xl border border-line bg-surface p-4 text-left transition-colors hover:border-accent/50 hover:bg-raised/40 disabled:opacity-70">
                {body}
              </button>
            </Form>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label={`More ways to make ${ui.label.toLowerCase()}`} className="absolute top-2 right-2 flex size-7 items-center justify-center rounded-md text-faint hover:bg-raised hover:text-fg">
                  <ChevronDown size={14} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem asChild>
                  <Link to={`/${slug}/-/artifacts/templates?kind=${kind}`}>From a template…</Link>
                </DropdownMenuItem>
                <DropdownMenuItem disabled={spaces.length === 0} onSelect={() => setChoosing(true)}>
                  In a space…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <SpaceChooser slug={slug} kind={kind} spaces={spaces} open={choosing} onOpenChange={setChoosing} />
          </div>
        );
      })}
    </div>
  );
}

/** What each kind is for, under its tile. */
const TILE_LINES: Record<FolioKind, string> = { doc: "Notes, specs, decisions", slides: "Decks to present", design: "Screens and layouts", dashboard: "Numbers to track" };

/** The kinds still to come, as the Hint names them. */
const COMING: Record<FolioKind, string> = { doc: "Docs", slides: "Slides", design: "Designs", dashboard: "Dashboards" };

function tileLine(kind: FolioKind): string {
  return TILE_LINES[kind];
}

function SpaceChooser({ slug, kind, spaces, open, onOpenChange }: { slug: string; kind: FolioKind; spaces: { id: string; name: string }[]; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [space, setSpace] = useState(spaces[0]?.id ?? "");
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  if (!isFolioKind(kind)) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New {FOLIO_KIND_UI[kind].label.toLowerCase().replace(/s$/, "")} in a space</DialogTitle>
          <DialogDescription>It follows the space&apos;s access: everyone in the space can open it.</DialogDescription>
        </DialogHeader>
        <Form method="post" action={`/${slug}/-/artifacts/new/${kind}`} className="space-y-4">
          <SelectField name="space" aria-label="Space" value={space} onValueChange={setSpace} options={spaces.map((s) => ({ value: s.id, label: s.name }))} className="h-9 w-full" />
          <div className="flex justify-end">
            <button type="submit" disabled={busy || !space} className="inline-flex h-9 items-center rounded-md bg-accent px-3.5 text-sm font-medium text-bg hover:bg-accent-hover disabled:opacity-60">
              {busy ? "Starting…" : "Make it"}
            </button>
          </div>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
