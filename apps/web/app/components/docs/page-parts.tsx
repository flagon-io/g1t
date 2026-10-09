/**
 * A page's surroundings: agents' suggestions with Accept and Reject, the
 * history dialog, moving a page, saving it as a template, the emoji and
 * cover pickers, and comments on the whole page.
 */
import type { DocDiffLine, DocSuggestion, DocVersion, DocVersionDetail, DocsSidebarSpace, MemberProfile, Result } from "@g1t/contracts";
import { Check, History, MessageSquare, RotateCcw, Sparkles, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { COVER_GRADIENTS, buildTree, canDo, flatten } from "../../lib/docs";
import { Button, ErrorText, TimeAgo } from "../ui";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { SelectField } from "../ui/select";
import { docsQuery } from "./actions";
import { Face } from "./parts";

// ── Suggestions ─────────────────────────────────────────────────────────────

function DiffBlock({ text, tone }: { text: string; tone: "del" | "add" }) {
  if (!text.trim()) return <p className="text-xs text-faint italic">{tone === "del" ? "Nothing removed" : "Nothing added"}</p>;
  return (
    <pre
      className={`max-h-56 overflow-auto rounded-md px-2.5 py-2 font-sans text-[0.8125rem] leading-relaxed whitespace-pre-wrap [scrollbar-width:thin] ${
        tone === "del" ? "bg-danger/8 text-fg-soft line-through decoration-danger/60" : "bg-success/10 text-fg"
      }`}
    >
      {text}
    </pre>
  );
}

function targetLabel(s: DocSuggestion): string {
  switch (s.target.kind) {
    case "append":
      return "Adds to the end";
    case "document":
      return "Rewrites the page";
    case "section":
      return `Changes “${s.target.heading}”`;
    default:
      return s.block_ids.length === 1 ? "Changes one block" : `Changes ${s.block_ids.length} blocks`;
  }
}

export function SuggestionCard({ suggestion, canDecide, onDecide, compact = false }: { suggestion: DocSuggestion; canDecide: boolean; onDecide: (id: string, decision: "accept" | "reject") => void; compact?: boolean }) {
  const [open, setOpen] = useState(!compact);
  const s = suggestion;
  return (
    <article className="rounded-xl border border-accent/30 bg-surface shadow-lg shadow-black/20">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Face who={s.author} size={20} />
        <span className="min-w-0 grow">
          <span className="block truncate text-xs font-medium text-fg">{s.author.display_name} suggests</span>
          <span className="block truncate text-[0.6875rem] text-faint">
            {targetLabel(s)}
            {s.asked_by ? ` · for ${s.asked_by.display_name}` : ""} · <TimeAgo at={s.created_at} />
          </span>
        </span>
        <Sparkles size={14} className="shrink-0 text-accent" aria-hidden="true" />
      </header>
      <div className="space-y-2 px-3 py-2.5">
        {s.note && <p className="text-xs leading-relaxed text-muted">{s.note}</p>}
        {open ? (
          <>
            {s.target.kind !== "append" && <DiffBlock text={s.before_markdown} tone="del" />}
            <DiffBlock text={s.after_markdown} tone="add" />
          </>
        ) : (
          <button type="button" onClick={() => setOpen(true)} className="text-xs text-accent hover:underline">
            Show the change
          </button>
        )}
      </div>
      {canDecide && (
        <footer className="flex gap-2 border-t border-line px-3 py-2">
          <button type="button" onClick={() => onDecide(s.id, "accept")} className="inline-flex h-7 items-center gap-1 rounded-md bg-success/15 px-2.5 text-xs font-medium text-success hover:bg-success/25">
            <Check size={13} /> Accept
          </button>
          <button type="button" onClick={() => onDecide(s.id, "reject")} className="inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-xs text-muted hover:bg-raised hover:text-fg">
            <X size={13} /> Reject
          </button>
        </footer>
      )}
    </article>
  );
}

// ── History ─────────────────────────────────────────────────────────────────

const KIND_LABELS: Record<DocVersion["kind"], string> = { created: "Created", edit: "Edited", agent: "Edited by an agent", suggestion: "Suggestion accepted", restore: "Restored" };

function DiffView({ lines }: { lines: DocDiffLine[] }) {
  return (
    <div className="font-mono text-[0.75rem] leading-relaxed">
      {lines.map((l, i) => (
        <div key={i} className={`flex gap-2 px-2 whitespace-pre-wrap ${l.op === "add" ? "bg-success/10 text-fg" : l.op === "del" ? "bg-danger/10 text-fg-soft line-through decoration-danger/50" : "text-muted"}`}>
          <span className="w-3 shrink-0 text-faint select-none">{l.op === "add" ? "+" : l.op === "del" ? "−" : " "}</span>
          <span className="min-w-0">{l.text || " "}</span>
        </div>
      ))}
    </div>
  );
}

export function HistoryDialog({ slug, pageId, open, onOpenChange, canRestore, onRestore }: { slug: string; pageId: string; open: boolean; onOpenChange: (o: boolean) => void; canRestore: boolean; onRestore: (versionId: string) => Promise<Result<unknown>> }) {
  const [versions, setVersions] = useState<DocVersion[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [detail, setDetail] = useState<DocVersionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  useEffect(() => {
    if (!open) return;
    setVersions(null);
    setError(null);
    void docsQuery<DocVersion[]>(slug, { versions: pageId }).then((r) => {
      if (r.ok) {
        setVersions(r.value);
        setChosen(r.value[0]?.id ?? null);
      } else setError(r.error.message);
    });
  }, [open, slug, pageId]);
  useEffect(() => {
    if (!chosen) return setDetail(null);
    setDetail(null);
    void docsQuery<DocVersionDetail>(slug, { version: chosen, page: pageId }).then((r) => r.ok && setDetail(r.value));
  }, [chosen, slug, pageId]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History size={16} /> History
          </DialogTitle>
          <DialogDescription>Every version, who made it, and what changed. Restoring makes a new version; nothing is lost.</DialogDescription>
        </DialogHeader>
        {error && <ErrorText>{error}</ErrorText>}
        <div className="grid min-h-[24rem] gap-4 md:grid-cols-[16rem_minmax(0,1fr)]">
          <ul className="max-h-[60vh] space-y-px overflow-y-auto [scrollbar-width:thin]">
            {versions === null && !error && <li className="px-2 py-1 text-xs text-faint">Loading…</li>}
            {versions?.map((v) => (
              <li key={v.id}>
                <button type="button" onClick={() => setChosen(v.id)} className={`w-full rounded-md px-2.5 py-2 text-left transition-colors ${chosen === v.id ? "bg-raised" : "hover:bg-raised/60"}`}>
                  <span className="block text-xs font-medium text-fg">{new Date(v.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                  <span className="mt-0.5 block text-[0.6875rem] text-faint">{v.note ?? KIND_LABELS[v.kind]}</span>
                  <span className="mt-1 flex items-center gap-1">
                    {v.authors.slice(0, 4).map((a) => (
                      <Face key={`${a.kind}:${a.id}`} who={a} size={14} />
                    ))}
                    <span className="ml-1 truncate text-[0.6875rem] text-muted">{v.authors.map((a) => a.display_name).join(", ")}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="min-w-0 overflow-hidden rounded-lg border border-line">
            {detail ? (
              <div className="max-h-[60vh] overflow-auto py-2 [scrollbar-width:thin]">
                <DiffView lines={detail.diff} />
              </div>
            ) : (
              <p className="p-4 text-xs text-faint">{chosen ? "Loading…" : "Choose a version."}</p>
            )}
          </div>
        </div>
        <DialogFooter>
          {canRestore && chosen && versions?.[0]?.id !== chosen && (
            <Button
              type="button"
              variant="accent"
              disabled={restoring}
              onClick={async () => {
                setRestoring(true);
                const done = await onRestore(chosen);
                setRestoring(false);
                if (done.ok) onOpenChange(false);
                else setError(done.error.message);
              }}
            >
              <RotateCcw size={14} /> {restoring ? "Restoring…" : "Restore this version"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Move ────────────────────────────────────────────────────────────────────

export function MoveDialog({ spaces, pageId, current, open, onOpenChange, onMove }: { spaces: DocsSidebarSpace[]; pageId: string; current: { space_id: string; parent_id: string | null }; open: boolean; onOpenChange: (o: boolean) => void; onMove: (spaceId: string, parentId: string | null) => void }) {
  const writable = spaces.filter((s) => canDo(s.viewer_role, "edit"));
  const [space, setSpace] = useState(current.space_id);
  const [parent, setParent] = useState(current.parent_id ?? "");
  const pages = useMemo(() => {
    const s = writable.find((x) => x.id === space);
    if (!s) return [];
    const tree = flatten(buildTree(s.pages));
    // Not under itself or anything under it.
    const hidden = new Set<string>([pageId]);
    for (const item of tree) if (item.parent_id && hidden.has(item.parent_id)) hidden.add(item.id);
    return tree.filter((i) => !hidden.has(i.id));
  }, [writable, space, pageId]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move page</DialogTitle>
          <DialogDescription>Pages under it move with it.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <SelectField aria-label="Space" value={space} onValueChange={(v) => { setSpace(v); setParent(""); }} options={writable.map((s) => ({ value: s.id, label: s.name }))} className="h-9 w-full" />
          <SelectField
            aria-label="Inside"
            value={parent}
            onValueChange={setParent}
            options={[{ value: "", label: "At the top of the space" }, ...pages.map((p) => ({ value: p.id, label: `${"  ".repeat(p.depth)}${p.icon ?? ""} ${p.title || "Untitled"}`.trim() }))]}
            className="h-9 w-full"
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="accent" onClick={() => onMove(space, parent || null)}>
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Save as template ───────────────────────────────────────────────────────

export function TemplateDialog({ open, onOpenChange, title, onSave }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; onSave: (name: string, description: string) => Promise<Result<unknown>> }) {
  const [name, setName] = useState(title);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setName(title), [title]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save as a template</DialogTitle>
          <DialogDescription>Everyone in the workspace can start a page from it.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} className="h-9 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent/60" />
          <input aria-label="What it's for" placeholder="What it's for" value={description} onChange={(e) => setDescription(e.target.value)} className="h-9 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent/60" />
          {error && <ErrorText>{error}</ErrorText>}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="accent"
            onClick={async () => {
              const done = await onSave(name, description);
              if (done.ok) onOpenChange(false);
              else setError(done.error.message);
            }}
          >
            Save template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Icon and cover ─────────────────────────────────────────────────────────

const EMOJI = ["📄", "📘", "📚", "📝", "📐", "🧭", "🗺️", "🚀", "🛠️", "🧰", "🧪", "🐛", "🔒", "🔑", "⚙️", "📦", "🧩", "🎯", "📈", "📊", "🗓️", "⏱️", "✅", "⚠️", "🔥", "🩹", "💡", "🧠", "🤖", "👋", "🤝", "💬", "📣", "🏁", "🌱", "⭐"];

export function IconPicker({ value, onChange, children }: { value: string | null; onChange: (icon: string | null) => void; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3">
        <div className="grid grid-cols-9 gap-0.5">
          {EMOJI.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => {
                onChange(e);
                setOpen(false);
              }}
              className={`flex size-7 items-center justify-center rounded text-base hover:bg-raised ${value === e ? "bg-raised" : ""}`}
              aria-label={`Use ${e}`}
            >
              {e}
            </button>
          ))}
        </div>
        <form
          className="mt-2 flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (custom.trim()) onChange(custom.trim());
            setOpen(false);
          }}
        >
          <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Any emoji" aria-label="Any emoji" className="h-8 min-w-0 grow rounded-md border border-line bg-bg px-2 text-sm outline-none focus:border-accent/60" />
          <button type="submit" className="h-8 rounded-md bg-raised px-2 text-xs hover:bg-line">
            Use
          </button>
        </form>
        {value && (
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className="mt-2 text-xs text-faint hover:text-fg"
          >
            Remove icon
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function CoverPicker({ onChange, children }: { onChange: (cover: string | null) => void; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3">
        <div className="grid grid-cols-3 gap-2">
          {COVER_GRADIENTS.map((g, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Cover ${i + 1}`}
              onClick={() => {
                onChange(`gradient:${i}`);
                setOpen(false);
              }}
              className="h-12 rounded-md ring-1 ring-line hover:ring-accent"
              style={{ background: g }}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => {
            onChange(null);
            setOpen(false);
          }}
          className="mt-3 text-xs text-faint hover:text-fg"
        >
          Remove cover
        </button>
      </PopoverContent>
    </Popover>
  );
}

// ── Comments on the whole page ─────────────────────────────────────────────

export type PageThread = { id: string; resolved: boolean; comments: { id: string; author: string; text: string; created_at: number }[] };

export function Discussion({
  threads,
  people,
  canComment,
  onPost,
  onReply,
  onResolve,
}: {
  threads: PageThread[];
  people: (key: string) => Pick<MemberProfile, "kind" | "id" | "name" | "display_name" | "avatar" | "avatar_seed">;
  canComment: boolean;
  onPost: (text: string) => Promise<boolean>;
  onReply: (thread: string, text: string) => Promise<boolean>;
  onResolve: (thread: string, resolved: boolean) => void;
}) {
  const [draft, setDraft] = useState("");
  const [replies, setReplies] = useState<Record<string, string>>({});
  const open = threads.filter((t) => !t.resolved);
  const resolved = threads.filter((t) => t.resolved);
  const [showResolved, setShowResolved] = useState(false);
  const thread = (t: PageThread) => (
    <li key={t.id} className={`rounded-xl border border-line bg-surface ${t.resolved ? "opacity-70" : ""}`}>
      <ul className="divide-y divide-line">
        {t.comments.map((c) => {
          const who = people(c.author);
          return (
            <li key={c.id} className="flex gap-2.5 px-3.5 py-3">
              <Face who={who} size={22} />
              <div className="min-w-0 grow">
                <p className="text-xs">
                  <span className="font-medium text-fg">{who.display_name}</span> <span className="text-faint">{c.created_at ? <TimeAgo at={c.created_at} /> : null}</span>
                </p>
                <p className="mt-0.5 text-sm leading-relaxed whitespace-pre-wrap text-fg-soft">{c.text}</p>
              </div>
            </li>
          );
        })}
      </ul>
      {canComment && (
        <form
          className="flex items-center gap-2 border-t border-line px-3 py-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const text = (replies[t.id] ?? "").trim();
            if (text && (await onReply(t.id, text))) setReplies((r) => ({ ...r, [t.id]: "" }));
          }}
        >
          <input value={replies[t.id] ?? ""} onChange={(e) => setReplies((r) => ({ ...r, [t.id]: e.target.value }))} placeholder="Reply" aria-label="Reply" className="h-8 min-w-0 grow bg-transparent text-sm outline-none placeholder:text-faint" />
          <button type="button" onClick={() => onResolve(t.id, !t.resolved)} className="shrink-0 text-xs text-faint hover:text-fg">
            {t.resolved ? "Reopen" : "Resolve"}
          </button>
        </form>
      )}
    </li>
  );
  return (
    <section aria-labelledby="discussion" className="mt-14 border-t border-line pt-8">
      <h2 id="discussion" className="flex items-center gap-2 text-sm font-semibold">
        <MessageSquare size={15} /> Discussion
      </h2>
      <p className="mt-1 text-xs text-faint">Comments on the whole page. To comment on a passage, select it and choose Comment.</p>
      <ul className="mt-4 space-y-3">{open.map(thread)}</ul>
      {resolved.length > 0 && (
        <>
          <button type="button" onClick={() => setShowResolved(!showResolved)} className="mt-3 text-xs text-faint hover:text-fg">
            {showResolved ? "Hide" : "Show"} {resolved.length} resolved
          </button>
          {showResolved && <ul className="mt-3 space-y-3">{resolved.map(thread)}</ul>}
        </>
      )}
      {canComment && (
        <form
          className="mt-4 flex items-start gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (draft.trim() && (await onPost(draft.trim()))) setDraft("");
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            placeholder="Add a comment. @mention someone to tell them."
            aria-label="Add a comment"
            className="min-h-16 min-w-0 grow resize-y rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-accent/60"
          />
          <Button type="submit" variant="quiet" disabled={!draft.trim()}>
            Comment
          </Button>
        </form>
      )}
    </section>
  );
}
