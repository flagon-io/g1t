/**
 * A doc's page under the shared header: its icon and title, who
 * edited it and where it came from, agents' suggestions, the live editor
 * (or its saved Markdown until the editor loads, and for a reader without
 * script), what is inside it and what links to it, and comments on the
 * whole doc. The editor and everything it brings load only in the
 * browser, after the page shows.
 */
import type { FolioSuggestion, FoliosLiveEvent, MemberProfile } from "@g1t/contracts";
import { AlertTriangle, Check, MessageSquareQuote, SmilePlus, Sparkles } from "lucide-react";
import { type ComponentType, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useRevalidator, useRouteLoaderData } from "react-router";

import { usercontentFrom } from "../../../lib/addresses";
import { canDo, readingTime } from "../../../lib/folios";
import { Markdown } from "../../markdown";
import { TimeAgo } from "../../ui";
import { Button } from "../../ui/button";
import { foliosRequest, useFoliosData } from "../actions";
import { FolioGlyph, type FolioBodyProps } from "../kinds";
import { Face } from "../parts";
import { type Who, whoAre } from "../who";
import type { DocEditorProps } from "./editor";
import { EditorSkeleton } from "./editor-skeleton";
import { Discussion, IconPicker, SuggestionCard, type PageThread } from "./page-parts";

/** The BlockNote editor, loaded only in the browser: the server renders the doc's Markdown instead. */
const DocEditor = lazy((): Promise<{ default: ComponentType<DocEditorProps> }> => (import.meta.env.SSR ? Promise.resolve({ default: () => null }) : import("./editor")));

function useHydrated() {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}

export default function DocBody({ slug, page, folio, live, role, showComments, onPresence, onFolio, onRole, onError }: FolioBodyProps) {
  const layout = useFoliosData();
  const root = useRouteLoaderData("root");
  const usercontent = usercontentFrom(root);
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const hydrated = useHydrated();
  const editable = canDo(role, "edit");
  const send = useCallback(
    async (intent: string, body: Record<string, unknown>, reload = true) => {
      const done = await foliosRequest(slug, intent, { folio_id: folio.id, ...body });
      if (!done.ok) onError(done.error.message);
      else if (reload) void revalidator.revalidate();
      return done;
    },
    [slug, folio.id, onError, revalidator],
  );

  // The title follows the folio, and anyone renaming it live.
  const [title, setTitle] = useState(folio.title);
  const titleFocused = useRef(false);
  useEffect(() => {
    if (!titleFocused.current) setTitle(folio.title);
  }, [folio.title]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTitle = (next: string) => {
    setTitle(next);
    onFolio({ ...folio, title: next });
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void send("update", { change: { title: next } }, false), 700);
  };

  const [suggestions, setSuggestions] = useState<FolioSuggestion[]>(page.suggestions);
  useEffect(() => setSuggestions(page.suggestions), [page.suggestions]);
  const [threads, setThreads] = useState<PageThread[]>([]);
  const [names, setNames] = useState<Map<string, Who>>(new Map());
  useEffect(() => {
    const keys = threads.flatMap((t) => t.comments.map((c) => c.author));
    if (keys.some((k) => !names.has(k))) void whoAre(slug, keys).then((found) => setNames((was) => new Map([...was, ...found])));
  }, [threads, slug, names]);

  const onEvent = useCallback(
    (event: FoliosLiveEvent) => {
      if (event.type === "folio.updated") onFolio(event.folio);
      else if (event.type === "folio.trashed") void revalidator.revalidate();
      else if (event.type === "access") {
        onRole(event.role);
        if (!event.role) navigate(`/${slug}/-/artifacts`);
      } else if (event.type === "suggestion.created") setSuggestions((was) => [...was.filter((s) => s.id !== event.suggestion.id), event.suggestion]);
      else if (event.type === "suggestion.updated") setSuggestions((was) => (event.suggestion.status === "open" ? was.map((s) => (s.id === event.suggestion.id ? event.suggestion : s)) : was.filter((s) => s.id !== event.suggestion.id)));
      else if (event.type === "version.created" || event.type === "folio.staleness" || event.type === "folio.access") void revalidator.revalidate();
    },
    [navigate, slug, revalidator, onFolio, onRole],
  );
  // The room's notices (a rename, a suggestion, a change of access), from the page's connection.
  useEffect(() => live?.onEvent(onEvent), [live, onEvent]);

  const decide = async (id: string, decision: "accept" | "reject") => {
    setSuggestions((was) => was.filter((s) => s.id !== id));
    const done = await send("decide", { suggestion_id: id, decision }, false);
    if (!done.ok) void revalidator.revalidate();
  };
  const acceptAll = async () => {
    const all = suggestions;
    setSuggestions([]);
    for (const s of all) await send("decide", { suggestion_id: s.id, decision: "accept" }, false);
    void revalidator.revalidate();
  };

  const people = useCallback(
    (key: string): Pick<MemberProfile, "kind" | "id" | "name" | "display_name" | "avatar" | "avatar_seed" | "look"> => {
      const at = key.indexOf(":");
      const kind = key.slice(0, at) === "agent" ? "agent" : "user";
      const id = key.slice(at + 1);
      if (layout?.me.key === key) return { kind: "user", id, name: layout.me.name, display_name: layout.me.display_name, avatar: layout.me.avatar, avatar_seed: null };
      const found = names.get(key);
      return { kind, id, name: found?.name ?? "someone", display_name: found?.display_name ?? (kind === "agent" ? "An agent" : "Someone"), avatar: found?.avatar ?? null, avatar_seed: found?.avatar_seed ?? null, look: found?.look ?? null };
    },
    [layout, names],
  );

  const threadRequest = async (path: string, method: string, body: unknown) => {
    try {
      const r = await fetch(`/${slug}/-/artifacts/threads/${folio.id}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) {
        const result = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
        onError(result?.error?.message ?? "That comment didn't go through.");
        return false;
      }
      return true;
    } catch {
      onError("That comment didn't go through.");
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

  const reading = useMemo(() => readingTime(page.text), [page.text]);
  const trashed = !!folio.trashed_at;

  return (
    <div className="-mt-6">
      <article className={`mx-auto pt-10 ${showComments ? "max-w-6xl" : "max-w-3xl"}`}>
        <div className={showComments ? "xl:max-w-3xl" : ""}>
          {trashed && (
            <p className="mb-6 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
              This is in the trash.{" "}
              <Link to={`/${slug}/-/artifacts/trash`} className="underline">
                Open the trash
              </Link>{" "}
              to restore it.
            </p>
          )}
          {/* Icon and title. */}
          <div className="group">
            {folio.icon && (
              <IconPicker value={folio.icon} onChange={(icon) => editable && send("update", { change: { icon } })}>
                <Button type="button" disabled={!editable} aria-label="Change the icon" variant="ghost" size="inline" className="-ml-1 mb-2 rounded-lg p-1 text-5xl leading-none disabled:hover:bg-transparent">
                  {folio.icon}
                </Button>
              </IconPicker>
            )}
            {editable && !trashed && (
              <div className="mb-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
                {!folio.icon && (
                  <IconPicker value={null} onChange={(icon) => send("update", { change: { icon } })}>
                    <Button type="button" variant="ghost" size="xs" className="text-faint font-normal">
                      <SmilePlus size={13} /> Add icon
                    </Button>
                  </IconPicker>
                )}
              </div>
            )}
            {editable && !trashed ? (
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
              <h1 className="font-display text-4xl leading-tight font-semibold tracking-tight">{folio.title || "Untitled"}</h1>
            )}
          </div>
          {/* Who wrote it, who owns it, where it came from. */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-faint">
            {folio.edited_by && (
              <span className="flex items-center gap-1.5">
                <Face who={folio.edited_by} size={16} />
                Edited by <span className="text-muted">{folio.edited_by.display_name}</span> · <TimeAgo at={folio.edited_at} />
              </span>
            )}
            <span className="flex items-center gap-1.5">
              Owner <Face who={folio.owner} size={16} /> <span className="text-muted">{folio.owner.display_name}</span>
            </span>
            {folio.source && (
              <Link to={folio.source.href} className="inline-flex items-center gap-1 hover:text-fg">
                <MessageSquareQuote size={13} /> From a conversation
              </Link>
            )}
            <span>
              {reading.words.toLocaleString()} words · {reading.minutes} min read
            </span>
            {!editable && <span className="rounded-full bg-raised px-2 py-0.5">{role === "comment" ? "Can comment" : "Can view"}</span>}
          </div>
          {folio.stale && (
            <div className="mt-5 flex flex-wrap items-center gap-3 rounded-lg border border-warn/30 bg-warn/8 px-3 py-2.5 text-sm">
              <AlertTriangle size={15} className="shrink-0 text-warn" />
              <span className="min-w-0 grow text-fg-soft">Possibly out of date: code this doc cites changed since it was last brought up to date.</span>
              {editable && (
                <Button type="button" onClick={() => send("mark_current", {})} variant="link" size="inline" className="text-xs text-warn">
                  It&apos;s current
                </Button>
              )}
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
                  <Button type="button" onClick={acceptAll} variant="link" size="inline" className="text-xs">
                    Accept all
                  </Button>
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
              <Button type="button" onClick={acceptAll} variant="link" size="sm" className="bg-accent/15 px-3 text-xs hover:bg-accent/25">
                <Check size={13} /> Accept all {suggestions.length} suggestions
              </Button>
            </div>
          )}
        </div>

        {/* The doc itself: live once the editor loads; its saved Markdown until then. */}
        <div className="mt-6">
          {hydrated && live && !trashed ? (
            <Suspense fallback={<ReadView markdown={page.text} />}>
              <DocEditor
                key={folio.id}
                slug={slug}
                folioId={folio.id}
                provider={live}
                role={role}
                me={layout?.me ?? { key: "", name: "", display_name: "", avatar: null }}
                mentionables={layout?.mentionables ?? []}
                usercontent={usercontent}
                suggestions={suggestions}
                showComments={showComments}
                onPresence={onPresence}
                onPageThreads={setThreads}
                renderSuggestion={(s) => <SuggestionCard suggestion={s} canDecide={editable} onDecide={decide} />}
                projects={[]}
              />
            </Suspense>
          ) : (
            <ReadView markdown={page.text} />
          )}
        </div>

        <div className={showComments ? "xl:max-w-3xl" : ""}>
          {(page.children.length > 0 || page.backlinks.length > 0) && (
            <div className="mt-14 grid gap-6 border-t border-line pt-8 sm:grid-cols-2">
              {page.children.length > 0 && (
                <section>
                  <h2 className="mb-2 text-xs font-medium tracking-wide text-faint uppercase">Inside</h2>
                  <ul className="space-y-1">
                    {page.children.map((c) => (
                      <li key={c.id}>
                        <Link to={c.path} className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-raised">
                          <FolioGlyph folio={c} /> {c.title || "Untitled"}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {page.backlinks.length > 0 && (
                <section>
                  <h2 className="mb-2 text-xs font-medium tracking-wide text-faint uppercase">Linked from</h2>
                  <ul className="space-y-1">
                    {page.backlinks.map((c) => (
                      <li key={c.id}>
                        <Link to={c.path} className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-raised">
                          <FolioGlyph folio={c} /> {c.title || "Untitled"}
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
    </div>
  );
}

/** The doc as Markdown: what shows before the editor loads, and what a reader without script sees. */
function ReadView({ markdown }: { markdown: string }) {
  if (!markdown.trim()) return <EditorSkeleton />;
  return (
    <div className="docs-read">
      <Markdown source={markdown} />
    </div>
  );
}
