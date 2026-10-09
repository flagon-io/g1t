import { DOC_AGENT_MODE_LABELS, DOC_ROLE_LABELS, type DocPage, type DocPageDetail, type DocSuggestion, type DocsLiveEvent, type MemberProfile } from "@g1t/contracts";
import {
  ArrowRightLeft,
  Check,
  ClipboardCopy,
  Copy,
  Download,
  Ellipsis,
  History,
  ImagePlus,
  LayoutTemplate,
  Link2,
  MessageSquare,
  Share2,
  SmilePlus,
  Sparkles,
  Star,
  Trash2,
  WifiOff,
} from "lucide-react";
import { type ComponentType, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, data, redirect, useNavigate, useRevalidator, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/page";
import { docsRequest, useDocsAction, useDocsData } from "../../../components/docs/actions";
import type { DocEditorProps, Presence } from "../../../components/docs/editor";
import { EditorSkeleton } from "../../../components/docs/editor-skeleton";
import { CoverPicker, Discussion, HistoryDialog, IconPicker, MoveDialog, SuggestionCard, TemplateDialog, type PageThread } from "../../../components/docs/page-parts";
import { Crumbs, Face, Faces } from "../../../components/docs/parts";
import type { LiveStatus } from "../../../components/docs/provider";
import { PageIcon } from "../../../components/docs/sidebar";
import { type Who, whoAre } from "../../../components/docs/who";
import { Markdown } from "../../../components/markdown";
import { ErrorText, TimeAgo } from "../../../components/ui";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { Hint } from "../../../components/ui/hint";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import { usercontentFrom } from "../../../lib/addresses";
import { canDo, coverStyle, pageIdOf, pagePath, readingTime } from "../../../lib/docs";
import { page as pageMeta } from "../../../lib/meta";
import { docs } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

/**
 * The editor and everything it brings, loaded only in the browser, after
 * the page shows. The server's bundle never includes it: the server
 * renders the page's Markdown instead.
 */
const DocEditor = lazy(
  (): Promise<{ default: ComponentType<DocEditorProps> }> => (import.meta.env.SSR ? Promise.resolve({ default: () => null }) : import("../../../components/docs/editor")),
);

export function meta({ loaderData: loaded, params, ...args }: Route.MetaArgs) {
  const p = loaded?.detail.page;
  return pageMeta(args, { title: `${p ? `${p.icon ? `${p.icon} ` : ""}${p.title || "Untitled"}` : "Page"} · ${params.owner} · g1t`, description: p?.excerpt, type: "article" });
}

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ detail: DocPageDetail }> {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const id = pageIdOf(params.page);
  if (!id) throw data(null, { status: 404 });
  const found = await docs.page(params.owner.toLowerCase(), id, viewer);
  if (!found.ok) throw data(null, { status: found.error.code === "not_found" ? 404 : 403 });
  const detail = found.value;
  // An old address (renamed page, moved space) goes to the current one.
  const url = new URL(request.url);
  if (url.pathname !== detail.page.path) throw redirect(`${detail.page.path}${url.search}`);
  return { detail };
}

function useHydrated() {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}

/** One page: its header, the live editor (or its Markdown until the editor loads), suggestions, comments, links. */
export default function DocPageView({ loaderData, params }: Route.ComponentProps) {
  const slug = params.owner.toLowerCase();
  const { detail } = loaderData;
  const { page, space } = detail;
  const layout = useDocsData();
  const root = useRouteLoaderData("root");
  const usercontent = usercontentFrom(root);
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const hydrated = useHydrated();
  const { send, error, setError } = useDocsAction(slug);

  const [role, setRole] = useState(detail.role);
  useEffect(() => setRole(detail.role), [detail.role, page.id]);
  const editable = canDo(role, "edit");

  // The header follows the page, and anyone renaming it live.
  const [live, setLive] = useState<DocPage>(page);
  useEffect(() => setLive(page), [page]);
  const [title, setTitle] = useState(page.title);
  const titleFocused = useRef(false);
  useEffect(() => {
    if (!titleFocused.current) setTitle(live.title);
  }, [live.title]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTitle = (next: string) => {
    setTitle(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void send("update_page", { page_id: page.id, change: { title: next } }), 700);
  };

  const [suggestions, setSuggestions] = useState<DocSuggestion[]>(detail.suggestions);
  useEffect(() => setSuggestions(detail.suggestions), [detail.suggestions]);
  const [presence, setPresence] = useState<Presence[]>([]);
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [archived, setArchived] = useState(!!page.archived_at);
  useEffect(() => setArchived(!!page.archived_at), [page.archived_at]);
  const [showComments, setShowComments] = useState(false);
  const [history, setHistory] = useState(false);
  const [moving, setMoving] = useState(false);
  const [templating, setTemplating] = useState(false);
  const [favorite, setFavorite] = useState(detail.favorite);
  useEffect(() => setFavorite(detail.favorite), [detail.favorite]);
  const [copied, setCopied] = useState<string | null>(null);
  const [threads, setThreads] = useState<PageThread[]>([]);
  const [names, setNames] = useState<Map<string, Who>>(new Map());
  useEffect(() => {
    const keys = threads.flatMap((t) => t.comments.map((c) => c.author));
    if (keys.some((k) => !names.has(k))) void whoAre(slug, keys).then((found) => setNames((was) => new Map([...was, ...found])));
  }, [threads, slug, names]);

  const onEvent = useCallback(
    (event: DocsLiveEvent) => {
      if (event.type === "page.updated") setLive(event.page);
      else if (event.type === "page.archived") setArchived(true);
      else if (event.type === "access") {
        if (event.role) setRole(event.role);
        else navigate(`/${slug}/-/docs`);
      } else if (event.type === "suggestion.created") setSuggestions((was) => [...was.filter((s) => s.id !== event.suggestion.id), event.suggestion]);
      else if (event.type === "suggestion.updated") setSuggestions((was) => (event.suggestion.status === "open" ? was.map((s) => (s.id === event.suggestion.id ? event.suggestion : s)) : was.filter((s) => s.id !== event.suggestion.id)));
      else if (event.type === "version.created") void revalidator.revalidate();
    },
    [navigate, slug, revalidator],
  );

  const decide = async (id: string, decision: "accept" | "reject") => {
    setSuggestions((was) => was.filter((s) => s.id !== id));
    const done = await send("decide", { suggestion_id: id, decision }, { reload: false });
    if (!done.ok) void revalidator.revalidate();
  };

  const people = useCallback(
    (key: string): Pick<MemberProfile, "kind" | "id" | "name" | "display_name" | "avatar" | "avatar_seed"> => {
      const at = key.indexOf(":");
      const kind = key.slice(0, at) === "agent" ? "agent" : "user";
      const id = key.slice(at + 1);
      if (layout?.me.key === key) return { kind: "user", id, name: layout.me.name, display_name: layout.me.display_name, avatar: layout.me.avatar, avatar_seed: null };
      const found = names.get(key);
      return { kind, id, name: found?.name ?? "someone", display_name: found?.display_name ?? (kind === "agent" ? "An agent" : "Someone"), avatar: found?.avatar ?? null, avatar_seed: found?.avatar_seed ?? null };
    },
    [layout, names],
  );

  const threadRequest = async (path: string, method: string, body: unknown) => {
    try {
      const r = await fetch(`/${slug}/-/docs/threads/${page.id}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) {
        const result = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(result?.error?.message ?? "That comment didn't go through.");
        return false;
      }
      return true;
    } catch {
      setError("That comment didn't go through.");
      return false;
    }
  };
  /** A comment's text as the editor's comments hold it: blocks, with @mentions as mentions. */
  const commentBody = (text: string) => {
    const parts: unknown[] = [];
    for (const piece of text.split(/(@[a-z0-9][a-z0-9-]*)/i)) {
      const who = piece.startsWith("@") ? layout?.mentionables.find((m) => m.name.toLowerCase() === piece.slice(1).toLowerCase()) : null;
      if (who) parts.push({ type: "mention", props: { kind: who.kind, id: who.id, name: who.name, href: "" } });
      else if (piece) parts.push({ type: "text", text: piece, styles: {} });
    }
    return [{ type: "paragraph", content: parts, children: [] }];
  };

  const copy = async (what: "link" | "markdown") => {
    try {
      if (what === "link") await navigator.clipboard.writeText(`${window.location.origin}${pagePath(slug, space.slug, live.title, page.id)}`);
      else {
        const r = await fetch(`/${slug}/-/docs/export?page=${encodeURIComponent(page.id)}`);
        await navigator.clipboard.writeText(await r.text());
      }
      setCopied(what);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      setError("Your browser didn't allow copying.");
    }
  };

  const cover = coverStyle(live.cover);
  const reading = useMemo(() => readingTime(detail.markdown), [detail.markdown]);
  const others = presence.filter((p) => !p.me);
  const crumbs = [
    { label: "Docs", to: `/${slug}/-/docs` },
    { label: space.name, to: `/${slug}/-/docs/${space.slug}` },
    ...detail.breadcrumbs.map((b) => ({ label: `${b.icon ? `${b.icon} ` : ""}${b.title || "Untitled"}`, to: b.path })),
  ];

  return (
    <div className="-mt-6">
      {cover && (
        <div className="group relative -mx-4 h-44 sm:-mx-6 lg:-mx-8" style={{ background: cover }}>
          {editable && (
            <CoverPicker onChange={(c) => send("update_page", { page_id: page.id, change: { cover: c } })}>
              <button type="button" className="absolute right-4 bottom-3 rounded-md bg-bg/70 px-2.5 py-1 text-xs text-fg opacity-0 backdrop-blur group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100">
                Change cover
              </button>
            </CoverPicker>
          )}
        </div>
      )}
      {/* The bar above the page: where it is, who is here, and what can be done. */}
      <div className="sticky top-(--topbar-h) z-20 -mx-4 flex h-12 items-center gap-3 border-b border-line bg-bg/85 px-4 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="min-w-0 grow">
          <Crumbs items={crumbs} />
        </div>
        {status === "offline" && (
          <Hint label="Your changes are kept and sync when the connection is back.">
            <span className="flex items-center gap-1 text-xs text-warn">
              <WifiOff size={13} /> Offline
            </span>
          </Hint>
        )}
        {others.length > 0 && (
          <span className="flex items-center -space-x-1.5" aria-label={`${others.length} others here`}>
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
        <Hint label={showComments ? "Hide comments" : "Comments"}>
          <button type="button" onClick={() => setShowComments(!showComments)} aria-pressed={showComments} aria-label="Comments" className={`flex size-8 items-center justify-center rounded-md max-md:size-10 ${showComments ? "bg-raised text-fg" : "text-faint hover:bg-raised hover:text-fg"}`}>
            <MessageSquare size={16} />
          </button>
        </Hint>
        <Hint label={favorite ? "Remove from favorites" : "Add to favorites"}>
          <button
            type="button"
            aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
            aria-pressed={favorite}
            onClick={async () => {
              setFavorite(!favorite);
              await send("favorite", { page_id: page.id, on: !favorite });
            }}
            className="flex size-8 items-center justify-center rounded-md text-faint hover:bg-raised hover:text-fg"
          >
            <Star size={16} className={favorite ? "fill-current text-warn" : ""} />
          </button>
        </Hint>
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" className="hidden h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-xs text-fg/85 hover:bg-raised sm:inline-flex">
              <Share2 size={13} /> Share
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-4 text-sm">
            <p className="font-medium">Who can see this page</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Everyone with access to <span className="text-fg">{space.name}</span>:{" "}
              {space.kind === "workspace" ? `the whole workspace (${space.default_role ? DOC_ROLE_LABELS[space.default_role].toLowerCase() : "listed members only"})` : space.kind === "team" ? `the ${space.team} team, and members added to the space` : "only the space's members"}. Agents here: {DOC_AGENT_MODE_LABELS[space.agent_mode].toLowerCase()}.
            </p>
            <p className="mt-2 text-xs text-muted">Your access: {DOC_ROLE_LABELS[role].toLowerCase()}.</p>
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => copy("link")} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-raised px-2.5 text-xs hover:bg-line">
                {copied === "link" ? <Check size={13} /> : <Link2 size={13} />} {copied === "link" ? "Copied" : "Copy link"}
              </button>
              {canDo(space.viewer_role, "manage") && (
                <Link to={`/${slug}/-/docs/${space.slug}/settings`} className="inline-flex h-8 items-center rounded-md px-2.5 text-xs text-muted hover:bg-raised hover:text-fg">
                  Space access
                </Link>
              )}
            </div>
          </PopoverContent>
        </Popover>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="More" className="flex size-8 items-center justify-center rounded-md text-faint hover:bg-raised hover:text-fg">
              <Ellipsis size={16} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onSelect={() => setHistory(true)}>
              <History size={14} /> History
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => copy("markdown")}>
              <ClipboardCopy size={14} /> Copy as Markdown
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href={`/${slug}/-/docs/export?page=${encodeURIComponent(page.id)}`}>
                <Download size={14} /> Export Markdown
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => copy("link")}>
              <Link2 size={14} /> Copy link
            </DropdownMenuItem>
            {editable && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setMoving(true)}>
                  <ArrowRightLeft size={14} /> Move
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={async () => {
                    const made = await docsRequest<DocPage>(slug, "duplicate_page", { page_id: page.id });
                    if (made.ok) navigate(made.value.path);
                    else setError(made.error.message);
                  }}
                >
                  <Copy size={14} /> Duplicate
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuItem onSelect={() => setTemplating(true)}>
              <LayoutTemplate size={14} /> Save as template
            </DropdownMenuItem>
            {editable && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={async () => {
                    const done = await send("archive_page", { page_id: page.id });
                    if (done.ok) navigate(`/${slug}/-/docs/${space.slug}`);
                  }}
                  className="text-danger focus:text-danger"
                >
                  <Trash2 size={14} /> Move to trash
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <article className={`mx-auto pt-10 ${showComments ? "max-w-6xl" : "max-w-3xl"}`}>
        <div className={showComments ? "xl:max-w-3xl" : ""}>
          {archived && (
            <p className="mb-6 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
              This page was moved to the trash.{" "}
              <Link to={`/${slug}/-/docs/trash`} className="underline">
                Open the trash
              </Link>
            </p>
          )}
          {/* Icon, cover, title. */}
          <div className="group">
            {live.icon && (
              <IconPicker value={live.icon} onChange={(icon) => editable && send("update_page", { page_id: page.id, change: { icon } })}>
                <button type="button" disabled={!editable} aria-label="Change the icon" className="-ml-1 mb-2 rounded-lg p-1 text-5xl leading-none hover:bg-raised disabled:hover:bg-transparent">
                  {live.icon}
                </button>
              </IconPicker>
            )}
            {editable && (
              <div className="mb-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                {!live.icon && (
                  <IconPicker value={null} onChange={(icon) => send("update_page", { page_id: page.id, change: { icon } })}>
                    <button type="button" className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-faint hover:bg-raised hover:text-fg">
                      <SmilePlus size={13} /> Add icon
                    </button>
                  </IconPicker>
                )}
                {!cover && (
                  <CoverPicker onChange={(c) => send("update_page", { page_id: page.id, change: { cover: c } })}>
                    <button type="button" className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-faint hover:bg-raised hover:text-fg">
                      <ImagePlus size={13} /> Add cover
                    </button>
                  </CoverPicker>
                )}
              </div>
            )}
            {editable ? (
              <textarea
                value={title}
                rows={1}
                placeholder="Untitled"
                aria-label="Title"
                onFocus={() => (titleFocused.current = true)}
                onBlur={() => (titleFocused.current = false)}
                onChange={(e) => saveTitle(e.target.value.replace(/\n/g, " "))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    (document.querySelector(".g1t-editor .bn-editor") as HTMLElement | null)?.focus();
                  }
                }}
                className="field-sizing-content w-full resize-none bg-transparent font-display text-4xl leading-tight font-semibold tracking-tight text-fg outline-none placeholder:text-faint/60"
              />
            ) : (
              <h1 className="font-display text-4xl leading-tight font-semibold tracking-tight">{live.title || "Untitled"}</h1>
            )}
          </div>
          {/* Who wrote it, who owns it, what it's about. */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-faint">
            {live.updated_by && (
              <span className="flex items-center gap-1.5">
                <Face who={live.updated_by} size={16} />
                Last edited by <span className="text-muted">{live.updated_by.display_name}</span> · <TimeAgo at={live.updated_at} />
              </span>
            )}
            {live.owners.length > 0 && (
              <span className="flex items-center gap-1.5">
                Owners <Faces people={live.owners} size={18} />
              </span>
            )}
            {[...new Set([...live.projects, ...space.projects])].map((p) => (
              <Link key={p} to={`/${p}`} className="rounded-full border border-line px-2 py-0.5 font-mono text-[0.6875rem] text-muted hover:border-line-strong hover:text-fg">
                {p}
              </Link>
            ))}
            <span>
              {reading.words.toLocaleString()} words · {reading.minutes} min read
            </span>
            {!editable && <span className="rounded-full bg-raised px-2 py-0.5">{DOC_ROLE_LABELS[role]}</span>}
          </div>
          {error && (
            <div className="mt-3">
              <ErrorText>{error}</ErrorText>
            </div>
          )}

          {/* Agents' suggestions, all together on a narrower screen (beside their blocks on a wide one). */}
          {suggestions.length > 0 && (
            <div className="mt-6 rounded-xl border border-accent/30 bg-accent/5 p-3 2xl:hidden">
              <div className="mb-2 flex items-center gap-2">
                <Sparkles size={14} className="text-accent" />
                <span className="grow text-sm font-medium">
                  {suggestions.length} {suggestions.length === 1 ? "suggestion" : "suggestions"} waiting
                </span>
                {editable && suggestions.length > 1 && (
                  <button type="button" onClick={async () => { setSuggestions([]); await send("accept_all", { page_id: page.id }); }} className="text-xs font-medium text-accent hover:underline">
                    Accept all
                  </button>
                )}
              </div>
              <div className="space-y-2">
                {suggestions.map((s) => (
                  <SuggestionCard key={s.id} suggestion={s} canDecide={editable} onDecide={decide} compact />
                ))}
              </div>
            </div>
          )}
          {suggestions.length > 1 && editable && (
            <div className="mt-4 hidden justify-end 2xl:flex">
              <button type="button" onClick={async () => { setSuggestions([]); await send("accept_all", { page_id: page.id }); }} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent/15 px-3 text-xs font-medium text-accent hover:bg-accent/25">
                <Check size={13} /> Accept all {suggestions.length} suggestions
              </button>
            </div>
          )}
        </div>

        {/* The page itself: live once the editor loads; its saved Markdown until then. */}
        <div className="mt-6">
          {hydrated && !archived ? (
            <Suspense fallback={<ReadView markdown={detail.markdown} />}>
              <DocEditor
                key={page.id}
                slug={slug}
                pageId={page.id}
                role={role}
                me={layout?.me ?? { key: "", name: "", display_name: "", avatar: null }}
                mentionables={layout?.mentionables ?? []}
                usercontent={usercontent}
                suggestions={suggestions}
                showComments={showComments}
                onPresence={setPresence}
                onStatus={setStatus}
                onEvent={onEvent}
                onPageThreads={setThreads}
                renderSuggestion={(s) => <SuggestionCard suggestion={s} canDecide={editable} onDecide={decide} />}
              />
            </Suspense>
          ) : (
            <ReadView markdown={detail.markdown} />
          )}
        </div>

        <div className={showComments ? "xl:max-w-3xl" : ""}>
          {(detail.children.length > 0 || detail.backlinks.length > 0) && (
            <div className="mt-14 grid gap-6 border-t border-line pt-8 sm:grid-cols-2">
              {detail.children.length > 0 && (
                <section>
                  <h2 className="mb-2 text-xs font-medium tracking-wide text-faint uppercase">Pages inside</h2>
                  <ul className="space-y-1">
                    {detail.children.map((c) => (
                      <li key={c.id}>
                        <Link to={c.path} className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-raised">
                          <PageIcon icon={c.icon} /> {c.title || "Untitled"}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {detail.backlinks.length > 0 && (
                <section>
                  <h2 className="mb-2 text-xs font-medium tracking-wide text-faint uppercase">Linked from</h2>
                  <ul className="space-y-1">
                    {detail.backlinks.map((c) => (
                      <li key={c.id}>
                        <Link to={c.path} className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-raised">
                          <PageIcon icon={c.icon} /> {c.title || "Untitled"}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
          {hydrated && (
            <Discussion
              threads={threads}
              people={people}
              canComment={canDo(role, "comment")}
              onPost={(text) => threadRequest("", "POST", { initialComment: { body: commentBody(text) }, page_level: true })}
              onReply={(thread, text) => threadRequest(`/${encodeURIComponent(thread)}/comments`, "POST", { comment: { body: commentBody(text) } })}
              onResolve={(thread, resolved) => void threadRequest(`/${encodeURIComponent(thread)}/${resolved ? "resolve" : "unresolve"}`, "POST", {})}
            />
          )}
        </div>
      </article>

      <HistoryDialog slug={slug} pageId={page.id} open={history} onOpenChange={setHistory} canRestore={editable} onRestore={(versionId) => send("restore_version", { page_id: page.id, version_id: versionId })} />
      {layout?.sidebar && (
        <MoveDialog
          spaces={layout.sidebar.spaces}
          pageId={page.id}
          current={{ space_id: page.space_id, parent_id: page.parent_id }}
          open={moving}
          onOpenChange={setMoving}
          onMove={async (spaceId, parentId) => {
            const moved = await send<DocPage>("move_page", { page_id: page.id, move: { space_id: spaceId, parent_id: parentId, before_id: null } });
            setMoving(false);
            if (moved.ok) navigate(moved.value.path);
          }}
        />
      )}
      <TemplateDialog open={templating} onOpenChange={setTemplating} title={live.title || "Untitled"} onSave={(name, description) => send("save_template", { page_id: page.id, name, description })} />
    </div>
  );
}

/** The page as Markdown: what shows before the editor loads, and what a reader without script sees. */
function ReadView({ markdown }: { markdown: string }) {
  if (!markdown.trim()) return <EditorSkeleton />;
  return (
    <div className="docs-read">
      <Markdown source={markdown} />
    </div>
  );
}
