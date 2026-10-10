/**
 * A doc's surroundings: agents' suggestions with Accept and Reject, the
 * emoji and cover pickers, and comments on the whole doc.
 */
import type { FolioSuggestion as DocSuggestion, MemberProfile } from "@g1t/contracts";
import { Check, MessageSquare, Sparkles, X } from "lucide-react";
import { type ReactNode, useState } from "react";

import { TimeAgo } from "../../ui";
import { Button } from "../../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { Face } from "../parts";

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
      return "Rewrites the doc";
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
          <Button type="button" onClick={() => setOpen(true)} variant="link" size="inline" className="text-xs font-normal">
            Show the change
          </Button>
        )}
      </div>
      {canDecide && (
        <footer className="flex gap-2 border-t border-line px-3 py-2">
          <Button type="button" onClick={() => onDecide(s.id, "accept")} size="xs" className="bg-success/15 px-2.5 text-success hover:bg-success/25">
            <Check size={13} /> Accept
          </Button>
          <Button type="button" onClick={() => onDecide(s.id, "reject")} variant="ghost" size="xs" className="px-2.5 font-normal">
            <X size={13} /> Reject
          </Button>
        </footer>
      )}
    </article>
  );
}

// ── Icon ──────────────────────────────────────────────────────────────────

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
          <Button type="submit" variant="secondary" size="xs" className="h-8 font-normal">
            Use
          </Button>
        </form>
        {value && (
          <Button
            type="button"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            variant="link"
            size="inline"
            className="mt-2 text-xs text-faint hover:text-fg font-normal"
          >
            Remove icon
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ── Comments on the whole doc ──────────────────────────────────────────────

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
  people: (key: string) => Pick<MemberProfile, "kind" | "id" | "name" | "display_name" | "avatar" | "avatar_seed" | "look">;
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
          <Button type="button" onClick={() => onResolve(t.id, !t.resolved)} variant="link" size="inline" className="text-xs text-faint hover:text-fg font-normal">
            {t.resolved ? "Reopen" : "Resolve"}
          </Button>
        </form>
      )}
    </li>
  );
  return (
    <section aria-labelledby="discussion" className="mt-14 border-t border-line pt-8">
      <h2 id="discussion" className="flex items-center gap-2 text-sm font-semibold">
        <MessageSquare size={15} /> Discussion
      </h2>
      <p className="mt-1 text-xs text-faint">Comments on the whole doc. To comment on a passage, select it and choose Comment.</p>
      <ul className="mt-4 space-y-3">{open.map(thread)}</ul>
      {resolved.length > 0 && (
        <>
          <Button type="button" onClick={() => setShowResolved(!showResolved)} variant="link" size="inline" className="mt-3 text-xs text-faint hover:text-fg font-normal">
            {showResolved ? "Hide" : "Show"} {resolved.length} resolved
          </Button>
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
          <Button type="submit" variant="outline" disabled={!draft.trim()}>
            Comment
          </Button>
        </form>
      )}
    </section>
  );
}
