/**
 * A doc's editor: BlockNote on the folio's live Yjs document, with g1t's
 * own blocks (./blocks.tsx), live cursors and presence, comments anchored
 * to text, and agents' suggestions marked in place. Loaded lazily and
 * only in the browser (./body.tsx), so the page's server render stays
 * light: until it loads, the reader sees the doc's Markdown.
 */
import "@blocknote/shadcn/style.css";

import { filterSuggestionItems, insertOrUpdateBlockForSlashMenu } from "@blocknote/core";
import { CommentsExtension, DefaultThreadStoreAuth, ThreadStoreAuth, type CommentData, type ThreadData } from "@blocknote/core/comments";
import { RESTYjsThreadStore, withCollaboration } from "@blocknote/core/yjs";
import { syntaxHighlighter } from "@blocknote/code-block";
import { BlockNoteViewEditor, SuggestionMenuController, ThreadsSidebar, getDefaultReactSlashMenuItems, useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import type { DocFile, DocRole, FolioSearchHit, FolioSuggestion, FoliosLiveEvent, Result } from "@g1t/contracts";
import { AlertTriangle, AtSign, Calendar, CheckCircle2, FileCode2, FileText, GitPullRequest, Info, Link2, Sigma, Workflow } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { canDo, cursorColour } from "../../../lib/folios";
import { useDrawnTheme } from "../../../lib/theme";
import { schema, type DocEditorInstance } from "./blocks";
import { CiteDialog } from "./code";
import { EditorSkeleton } from "./editor-skeleton";
import type { PageThread } from "./page-parts";
import { FolioProvider, type LiveStatus } from "../provider";
import type { Presence } from "../shell";
import { whoAre } from "../who";

/** Someone who can be mentioned: a person (by username) or an agent (by id). */
export type DocMentionable = { kind: "user" | "agent"; id: string; name: string; display_name: string; avatar: string | null; avatar_seed?: string | null };

export type DocEditorProps = {
  slug: string;
  folioId: string;
  role: DocRole;
  me: { key: string; name: string; display_name: string; avatar: string | null };
  mentionables: DocMentionable[];
  usercontent: string;
  suggestions: FolioSuggestion[];
  showComments: boolean;
  onPresence?: (people: Presence[]) => void;
  onStatus?: (status: LiveStatus) => void;
  onEvent?: (event: FoliosLiveEvent) => void;
  /** The suggestion cards' own UI, drawn by the page beside the blocks each one changes. */
  renderSuggestion?: (suggestion: FolioSuggestion) => ReactNode;
  /** Comments on the whole doc (not on a passage), live from the document. */
  onPageThreads?: (threads: PageThread[]) => void;
  /** The projects the doc is about: Cite code offers them first. */
  projects?: string[];
};

/** Nobody can do anything with threads: a reader's view. */
class ReadOnlyAuth extends ThreadStoreAuth {
  canCreateThread() {
    return false;
  }
  canAddComment(_t: ThreadData) {
    return false;
  }
  canUpdateComment(_c: CommentData) {
    return false;
  }
  canDeleteComment(_c: CommentData) {
    return false;
  }
  canDeleteThread(_t: ThreadData) {
    return false;
  }
  canResolveThread(_t: ThreadData) {
    return false;
  }
  canUnresolveThread(_t: ThreadData) {
    return false;
  }
  canAddReaction(_c: CommentData) {
    return false;
  }
  canDeleteReaction(_c: CommentData) {
    return false;
  }
}

export default function DocEditor(props: DocEditorProps) {
  const { slug, folioId } = props;
  const [provider, setProvider] = useState<FolioProvider | null>(null);
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const live = new FolioProvider(`${scheme}://${window.location.host}/${slug}/-/artifacts/live?folio=${encodeURIComponent(folioId)}`);
    setProvider(live);
    setSynced(false);
    // Mount the editor once the document is here, so it never starts from
    // an empty doc of its own; offline, after a moment, from what we have.
    const fallback = setTimeout(() => setSynced(true), 4000);
    const off = live.onStatus((status) => {
      props.onStatus?.(status);
      if (status === "synced") setSynced(true);
    });
    const offEvent = live.onEvent((event) => props.onEvent?.(event));
    return () => {
      clearTimeout(fallback);
      off();
      offEvent();
      live.destroy();
    };
    // The callbacks are read through props each time; reconnect only for a new folio.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, folioId]);

  if (!provider || !synced) return <EditorSkeleton />;
  return <LiveEditor {...props} provider={provider} />;
}

function LiveEditor({ slug, folioId, role, me, mentionables, usercontent, suggestions, showComments, onPresence, renderSuggestion, onPageThreads, projects, provider }: DocEditorProps & { provider: FolioProvider }) {
  const editable = canDo(role, "edit");
  // BlockNote's own parts follow the page's Appearance (lib/theme.ts).
  const theme = useDrawnTheme();
  const [citing, setCiting] = useState(false);
  const colour = cursorColour(me.name);
  // Below 1280px the comments sit under the page: opening them goes there.
  const comments = useRef<HTMLElement>(null);
  useEffect(() => {
    if (showComments && window.matchMedia("(max-width: 1279px)").matches) comments.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [showComments]);

  const threadStore = useMemo(() => {
    const auth = canDo(role, "comment") ? new DefaultThreadStoreAuth(me.key, editable ? "editor" : "comment") : new ReadOnlyAuth();
    return new RESTYjsThreadStore(`/${slug}/-/artifacts/threads/${folioId}`, {}, provider.doc.getMap("threads"), auth);
  }, [slug, folioId, role, me.key, editable, provider]);

  const editor = useCreateBlockNote(
    withCollaboration({
      schema,
      collaboration: {
        fragment: provider.doc.getXmlFragment("document-store"),
        user: { name: me.display_name, color: colour, key: me.key, kind: "user", avatar: me.avatar ?? "" },
        provider,
        showCursorLabels: "activity",
      },
      extensions: [
        CommentsExtension({
          threadStore,
          resolveUsers: async (ids: string[]) => {
            const found = await whoAre(slug, ids);
            return ids.map((id) => {
              const p = found.get(id);
              const avatar = id === me.key ? me.avatar : (p?.avatar ?? null);
              return { id, username: id === me.key ? me.display_name : (p?.display_name ?? "Someone"), avatarUrl: avatar ? `${usercontent}/avatars/${avatar}` : "" };
            });
          },
        }),
        syntaxHighlighter,
      ],
      uploadFile: async (file: File) => {
        const response = await fetch(`/${slug}/-/artifacts/upload?folio=${encodeURIComponent(folioId)}&name=${encodeURIComponent(file.name)}`, {
          method: "POST",
          headers: { "content-type": file.type || "application/octet-stream" },
          body: file,
        });
        const result = (await response.json()) as Result<DocFile>;
        if (!result.ok) throw new Error(result.error.message);
        return `${usercontent}${result.value.url}`;
      },
    }),
    [provider, threadStore],
  ) as unknown as DocEditorInstance;

  // Who is here: everyone's awareness state, people and agents.
  useEffect(() => {
    const read = () => {
      const out: Presence[] = [];
      provider.awareness.getStates().forEach((state, client) => {
        const user = (state as { user?: { name?: string; color?: string; key?: string; kind?: string; avatar?: string } }).user;
        if (!user?.name) return;
        out.push({
          client,
          key: user.key ?? String(client),
          name: user.name,
          kind: user.kind === "agent" ? "agent" : "user",
          color: user.color ?? "#b8a6ff",
          avatar: user.avatar || null,
          me: client === provider.doc.clientID,
        });
      });
      // One face per person, however many tabs they have open.
      const seen = new Set<string>();
      onPresence?.(out.filter((p) => !seen.has(p.key) && seen.add(p.key)));
    };
    read();
    provider.awareness.on("change", read);
    return () => provider.awareness.off("change", read);
  }, [provider, onPresence]);

  // Comments on the whole doc, as the document holds them.
  useEffect(() => {
    if (!onPageThreads) return;
    const map = provider.doc.getMap("threads");
    const read = () => {
      const out: PageThread[] = [];
      map.forEach((value) => {
        const t = value as { get(key: string): unknown };
        if (typeof t?.get !== "function" || t.get("deletedAt")) return;
        const meta = (t.get("metadata") as { page_level?: boolean } | null) ?? {};
        if (!meta.page_level) return;
        const comments = (t.get("comments") as { toArray(): { get(key: string): unknown }[] } | undefined)?.toArray() ?? [];
        out.push({
          id: String(t.get("id")),
          resolved: !!t.get("resolved"),
          comments: comments
            .filter((c) => !c.get("deletedAt"))
            .map((c) => ({ id: String(c.get("id")), author: String(c.get("userId")), text: commentText(c.get("body")), created_at: Number(c.get("createdAt")) || 0 })),
        });
      });
      onPageThreads(out.sort((a, b) => (a.comments[0]?.created_at ?? 0) - (b.comments[0]?.created_at ?? 0)));
    };
    read();
    map.observeDeep(read);
    return () => map.unobserveDeep(read);
  }, [provider, onPageThreads]);

  // `[[` links an artifact, as `@` mentions someone.
  const searchPages = async (query: string) => {
    try {
      const r = await fetch(`/${slug}/-/artifacts/api?search=${encodeURIComponent(query)}`, { headers: { accept: "application/json" } });
      const result = (await r.json()) as Result<FolioSearchHit[]>;
      return result.ok ? result.value : [];
    } catch {
      return [];
    }
  };

  const slashItems = (query: string) => {
    const insert = (block: { type: string; props?: Record<string, unknown> }) => () => insertOrUpdateBlockForSlashMenu(editor as never, block as never);
    const custom = [
      { title: "Info callout", subtext: "A note set apart from the text", aliases: ["callout", "note", "info"], group: "Callouts", icon: <Info size={18} />, onItemClick: insert({ type: "callout", props: { kind: "info" } }) },
      { title: "Warning callout", subtext: "Something to be careful about", aliases: ["callout", "warning", "caution"], group: "Callouts", icon: <AlertTriangle size={18} />, onItemClick: insert({ type: "callout", props: { kind: "warning" } }) },
      { title: "Success callout", subtext: "A tip, or what good looks like", aliases: ["callout", "success", "tip"], group: "Callouts", icon: <CheckCircle2 size={18} />, onItemClick: insert({ type: "callout", props: { kind: "success" } }) },
      { title: "Diagram", subtext: "A Mermaid diagram, drawn as you type", aliases: ["mermaid", "flowchart", "sequence", "chart"], group: "Advanced", icon: <Workflow size={18} />, onItemClick: insert({ type: "mermaid" }) },
      { title: "Math", subtext: "A formula, typeset with KaTeX", aliases: ["math", "latex", "katex", "equation", "formula"], group: "Advanced", icon: <Sigma size={18} />, onItemClick: insert({ type: "math" }) },
      { title: "Embed from g1t", subtext: "An issue, pull request, channel, project or artifact, live", aliases: ["embed", "issue", "pull", "pr", "channel", "project"], group: "g1t", icon: <GitPullRequest size={18} />, onItemClick: insert({ type: "embed" }) },
      {
        title: "Mention",
        subtext: "A person or an agent",
        aliases: ["mention", "person", "agent", "@"],
        group: "g1t",
        icon: <AtSign size={18} />,
        onItemClick: () => editor.insertInlineContent("@" as never),
      },
      {
        title: "Link to an artifact",
        subtext: "A doc or another artifact",
        aliases: ["link", "page", "artifact", "doc", "[["],
        group: "g1t",
        icon: <Link2 size={18} />,
        onItemClick: () => editor.insertInlineContent("[[" as never),
      },
      {
        title: "Cite code",
        subtext: "A file, folder, symbol, endpoint or variable this doc describes",
        aliases: ["cite", "code", "citation", "path", "file", "symbol", "endpoint", "env", "variable"],
        group: "g1t",
        icon: <FileCode2 size={18} />,
        onItemClick: () => setCiting(true),
      },
      {
        title: "Date",
        subtext: "Today's date, which you can change",
        aliases: ["date", "today", "when"],
        group: "g1t",
        icon: <Calendar size={18} />,
        onItemClick: () => editor.insertInlineContent([{ type: "date", props: { date: new Date().toISOString().slice(0, 10) } }, " "] as never),
      },
    ];
    return filterSuggestionItems([...getDefaultReactSlashMenuItems(editor as never), ...custom], query);
  };

  const mentionItems = (query: string) => {
    const q = query.toLowerCase();
    return mentionables
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.display_name.toLowerCase().includes(q))
      .slice(0, 8)
      .map((p) => ({
        title: p.display_name,
        subtext: p.kind === "agent" ? `@${p.name} · agent` : `@${p.name}`,
        icon: <AtSign size={16} />,
        onItemClick: () => editor.insertInlineContent([{ type: "mention", props: { kind: p.kind, id: p.id, name: p.name, href: "" } }, " "] as never),
      }));
  };

  const pageItems = async (query: string) => {
    const pages = await searchPages(query);
    return pages.slice(0, 8).map((p) => ({
      title: p.title || "Untitled",
      subtext: p.space_name ?? "Private",
      icon: p.icon ? <span className="text-base leading-none">{p.icon}</span> : <FileText size={16} />,
      onItemClick: () => editor.insertInlineContent([{ type: "mention", props: { kind: "page", id: p.id, name: p.title || "Untitled", href: p.path } }, " "] as never),
    }));
  };

  // Suggestions: the blocks each one changes are struck through in place.
  const struck = suggestions
    .flatMap((s) => s.block_ids)
    .filter((id) => /^[0-9a-zA-Z-]+$/.test(id))
    .map((id) => `.g1t-editor .bn-block-outer[data-id="${id}"] > .bn-block > .bn-block-content`)
    .join(",\n");

  return (
    <div className="g1t-editor relative">
      {struck && (
        <style>{`${struck} { text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--g1t-danger) 70%, transparent); background: color-mix(in srgb, var(--g1t-danger) 8%, transparent); border-radius: 4px; }`}</style>
      )}
      <BlockNoteView editor={editor as never} editable={editable} theme={theme} renderEditor={false} slashMenu={false} comments={canDo(role, "view")} className="g1t-bn">
        <div className={`grid gap-8 ${showComments ? "xl:grid-cols-[minmax(0,1fr)_18rem]" : ""}`}>
          <div className="relative min-w-0">
            <BlockNoteViewEditor />
            {renderSuggestion && <SuggestionRail editor={editor} suggestions={suggestions} render={renderSuggestion} hidden={showComments} />}
          </div>
          {showComments && (
            <aside ref={comments} aria-label="Comments" className="scroll-mt-20 max-xl:border-t max-xl:border-line max-xl:pt-6">
              <div className="xl:sticky xl:top-[calc(var(--topbar-h)+1.5rem)] xl:max-h-[calc(100dvh-var(--topbar-h)-2.5rem)] xl:overflow-y-auto xl:[scrollbar-width:thin]">
                <ThreadsSidebar filter="all" sort="position" />
              </div>
            </aside>
          )}
        </div>
        <SuggestionMenuController triggerCharacter="/" getItems={async (query) => slashItems(query)} />
        <SuggestionMenuController triggerCharacter="@" getItems={async (query) => mentionItems(query)} />
        <SuggestionMenuController triggerCharacter="[[" getItems={pageItems} />
      </BlockNoteView>
      {editable && (
        <CiteDialog
          slug={slug}
          open={citing}
          onOpenChange={setCiting}
          projects={projects}
          onCite={(c) => {
            editor.focus();
            editor.insertInlineContent([{ type: "citation", props: c }, " "] as never);
          }}
        />
      )}
    </div>
  );
}

/**
 * Each suggestion beside the blocks it changes, in the margin on a wide
 * screen (the doc lists them above the editor on a narrow one).
 */
function SuggestionRail({ editor, suggestions, render, hidden }: { editor: DocEditorInstance; suggestions: FolioSuggestion[]; render: (s: FolioSuggestion) => ReactNode; hidden: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [tops, setTops] = useState<Record<string, number>>({});
  useLayoutEffect(() => {
    const place = () => {
      const root = box.current?.parentElement;
      if (!root) return;
      const base = root.getBoundingClientRect().top;
      const next: Record<string, number> = {};
      let floor = 0;
      for (const s of suggestions) {
        const first = s.block_ids[0];
        const el = first ? root.querySelector(`.bn-block-outer[data-id="${CSS.escape(first)}"]`) : null;
        const want = el ? el.getBoundingClientRect().top - base : root.getBoundingClientRect().height - 40;
        // Cards never overlap: each starts below the one before.
        const top = Math.max(want, floor);
        next[s.id] = top;
        floor = top + 190;
      }
      setTops(next);
    };
    place();
    const off = editor.onChange(() => requestAnimationFrame(place));
    const observer = new ResizeObserver(place);
    if (box.current?.parentElement) observer.observe(box.current.parentElement);
    return () => {
      off?.();
      observer.disconnect();
    };
  }, [editor, suggestions]);
  if (hidden || !suggestions.length) return null;
  return (
    <div ref={box} className="pointer-events-none absolute inset-y-0 left-full ml-8 hidden w-72 2xl:block" aria-label="Suggestions">
      {suggestions.map((s) => (
        <div key={s.id} className="pointer-events-auto absolute inset-x-0" style={{ top: tops[s.id] ?? 0 }}>
          {render(s)}
        </div>
      ))}
    </div>
  );
}

/** A comment's text: its blocks' inline text, mentions as @name. */
function commentText(body: unknown): string {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.type === "text" && typeof o.text === "string") out.push(o.text);
      else if (o.type === "mention") out.push(`@${(o.props as { name?: string } | undefined)?.name ?? ""}`);
      else {
        walk(o.content);
        walk(o.children);
      }
    }
  };
  walk(body);
  return out.join("");
}
