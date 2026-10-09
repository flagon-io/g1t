import { Check, Hash, Lock, Plus, Search, SquarePen, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useNavigate, useRouteLoaderData } from "react-router";

import type { ChatSidebar, Result } from "@g1t/contracts";

import { AgentMark, AgentPill } from "./marks";
import { Avatar } from "../ui";
import { Hint } from "../ui/hint";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Switch } from "../ui/switch";
import { channelName } from "../../lib/chat";
import type { ChatLayoutData } from "../../routes/workspace/chat/layout";

/** Chat mode's data, while a chat page is open; undefined elsewhere. */
export function useChatData(): ChatLayoutData | undefined {
  return useRouteLoaderData("routes/workspace/chat/layout") as ChatLayoutData | undefined;
}

/** The sidebar's own fetcher: every component that refreshes it shares this one. */
export const SIDEBAR_FETCHER = "chat-sidebar";

/** The sidebar as last read: refreshed in place, else what the page loaded. */
export function useChatSidebar(): { sidebar: ChatSidebar | null; refresh: () => void } {
  const data = useChatData();
  const fetcher = useFetcher<Result<ChatSidebar>>({ key: SIDEBAR_FETCHER });
  const slug = data?.slug;
  const refresh = useCallback(() => {
    if (slug) fetcher.load(`/${slug}/-/chat/api`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);
  const fresh = fetcher.data?.ok ? fetcher.data.value : null;
  const sidebar = fresh ?? data?.sidebar ?? null;
  // A conversation read on its page reads as read everywhere at once, until
  // the service's next answer says so itself.
  const [read, setRead] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const onRead = (event: Event) => setRead((now) => new Set(now).add(String((event as CustomEvent).detail)));
    window.addEventListener("g1t:chat-read", onRead);
    return () => window.removeEventListener("g1t:chat-read", onRead);
  }, []);
  useEffect(() => setRead(new Set()), [sidebar]);
  const shown = useMemo(
    () =>
      sidebar && read.size > 0
        ? { ...sidebar, entries: sidebar.entries.map((e) => (read.has(e.channel.id) ? { ...e, unread: 0, mentions: 0 } : e)) }
        : sidebar,
    [sidebar, read],
  );
  return { sidebar: shown, refresh };
}

/**
 * Sends one request to the chat's JSON route and answers with the
 * service's result; a network failure is a failure like any other. Doing
 * something that changes the sidebar refreshes it.
 */
export function useChatSend(slug: string) {
  const fetcher = useFetcher<Result<ChatSidebar>>({ key: SIDEBAR_FETCHER });
  return useCallback(
    async <T = unknown,>(body: Record<string, unknown>): Promise<Result<T>> => {
      try {
        const response = await fetch(`/${slug}/-/chat/api`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const result = (await response.json()) as Result<T>;
        if (result.ok && body.intent !== "post" && body.intent !== "read") fetcher.load(`/${slug}/-/chat/api`);
        return result;
      } catch {
        return { ok: false, error: { code: "conflict", message: "Couldn't reach g1t. Check your connection and try again." } };
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slug],
  );
}

const QUIET_BUTTON =
  "inline-flex h-9 items-center gap-2 rounded-md border border-line px-3 text-sm font-medium text-fg/90 transition-colors hover:border-line-strong hover:bg-surface hover:text-fg";
const ICON_BUTTON =
  "flex size-7 items-center justify-center rounded-md text-faint transition-colors hover:bg-raised hover:text-fg focus-visible:ring-2 focus-visible:ring-accent";

/** Making a channel: its name, what it is for, and whether it is private. */
export function CreateChannelButton({ slug, variant = "icon" }: { slug: string; variant?: "icon" | "button" }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [secret, setSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = useChatSend(slug);
  const navigate = useNavigate();
  const clean = channelName(name);
  const submit = async () => {
    if (!clean) return setError("Give the channel a name.");
    setBusy(true);
    setError(null);
    const made = await send<{ to: string }>({ intent: "create_channel", name: clean, topic, private: secret });
    setBusy(false);
    if (!made.ok) return setError(made.error.message);
    setOpen(false);
    setName("");
    setTopic("");
    navigate(made.value.to);
  };
  return (
    <>
      {variant === "icon" ? (
        <Hint label="Create a channel">
          <button type="button" aria-label="Create a channel" onClick={() => setOpen(true)} className={ICON_BUTTON}>
            <Plus size={14} />
          </button>
        </Hint>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className={QUIET_BUTTON}>
          <Hash size={15} />
          Create a channel
        </button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a channel</DialogTitle>
            <DialogDescription>A place for one topic: a project, a team, a launch. Invite people and agents once it's made.</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label className="grid gap-1.5">
              <span className="text-sm font-medium text-muted">Name</span>
              <span className="flex h-10 items-center gap-1.5 rounded-md border border-line bg-bg px-3 focus-within:border-accent-dim">
                {secret ? <Lock size={14} className="text-faint" /> : <Hash size={14} className="text-faint" />}
                <input
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="release-train"
                  maxLength={80}
                  autoComplete="off"
                  data-1p-ignore
                  className="min-w-0 grow bg-transparent text-sm outline-none placeholder:text-faint"
                />
              </span>
              {name && clean !== name && <span className="text-xs text-faint">It will be #{clean || "…"}</span>}
            </label>
            <label className="grid gap-1.5">
              <span className="text-sm font-medium text-muted">
                Topic <span className="font-normal text-faint">(optional)</span>
              </span>
              <input
                value={topic}
                onChange={(event) => setTopic(event.target.value)}
                placeholder="What this channel is for"
                maxLength={250}
                autoComplete="off"
                data-1p-ignore
                className="h-10 rounded-md border border-line bg-bg px-3 text-sm outline-none placeholder:text-faint focus:border-accent-dim"
              />
            </label>
            <label className="flex items-start justify-between gap-4 rounded-lg border border-line bg-bg/60 p-3">
              <span>
                <span className="block text-sm font-medium">Private</span>
                <span className="mt-0.5 block text-xs text-muted">Only people and agents you invite can find and read it.</span>
              </span>
              <Switch checked={secret} onCheckedChange={setSecret} aria-label="Private" />
            </label>
            {error && <p className="text-sm text-danger">{error}</p>}
            <DialogFooter>
              <button type="button" onClick={() => setOpen(false)} className={QUIET_BUTTON}>
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || !clean}
                className="inline-flex h-9 items-center justify-center rounded-md bg-accent px-3.5 text-sm font-medium text-bg transition-colors hover:bg-accent-hover disabled:opacity-50"
              >
                {busy ? "Creating…" : "Create channel"}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Someone a new message can go to. */
type Pickable = { key: string; kind: "user" | "agent"; name: string; display: string; avatar: string | null; role?: string | null };

/**
 * A new direct message: choose people, agents or both, then open the
 * conversation between you (the same one each time for the same people).
 */
export function NewMessageButton({ slug, variant = "icon", children }: { slug: string; variant?: "icon" | "button"; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {variant === "icon" ? (
        <Hint label="New message">
          <button type="button" aria-label="New message" onClick={() => setOpen(true)} className={ICON_BUTTON.replace("size-7", "size-8")}>
            <SquarePen size={15} />
          </button>
        </Hint>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className={QUIET_BUTTON}>
          <SquarePen size={15} />
          {children ?? "New message"}
        </button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md gap-0 p-0" showClose={false}>
          {open && <NewMessage slug={slug} onDone={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function NewMessage({ slug, onDone }: { slug: string; onDone: () => void }) {
  const data = useChatData();
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<Pickable[]>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const send = useChatSend(slug);
  const navigate = useNavigate();
  const everyone = useMemo<Pickable[]>(() => {
    const me = data?.me.username.toLowerCase();
    return [
      ...(data?.agents ?? []).map((agent) => ({
        key: `agent:${agent.id}`,
        kind: "agent" as const,
        name: agent.handle,
        display: agent.display_name,
        avatar: agent.avatar,
        role: agent.role,
      })),
      ...(data?.people ?? [])
        .filter((person) => person.name.toLowerCase() !== me)
        .map((person) => ({ key: `user:${person.name}`, kind: "user" as const, name: person.name, display: person.display_name, avatar: person.avatar })),
    ];
  }, [data]);
  const q = query.trim().toLowerCase().replace(/^@/, "");
  const picked = new Set(chosen.map((p) => p.key));
  const options = everyone.filter(
    (p) => !picked.has(p.key) && (!q || p.name.toLowerCase().includes(q) || p.display.toLowerCase().includes(q)),
  );
  const take = (person: Pickable) => {
    setChosen((now) => [...now, person]);
    setQuery("");
    setActive(0);
    input.current?.focus();
  };
  const go = async () => {
    if (chosen.length === 0) return;
    setBusy(true);
    setError(null);
    const opened = await send<{ to: string }>({ intent: "dm", members: chosen.map((p) => p.key) });
    setBusy(false);
    if (!opened.ok) return setError(opened.error.message);
    onDone();
    navigate(opened.value.to);
  };
  return (
    <div className="flex max-h-[min(36rem,calc(100dvh-2rem))] flex-col">
      <div className="border-b border-line px-5 pt-5 pb-4">
        <DialogTitle>New message</DialogTitle>
        <DialogDescription className="mt-1">To one person, a few, or an agent. Agents answer in the conversation.</DialogDescription>
        <div className="mt-4 flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border border-line bg-bg px-2 py-1.5 focus-within:border-accent-dim">
          <span className="pl-1 text-sm text-faint">To:</span>
          {chosen.map((person) => (
            <span key={person.key} className="flex h-6 items-center gap-1.5 rounded-md bg-raised pr-1 pl-1 text-[0.8125rem]">
              {person.kind === "agent" ? <AgentMark size={16} /> : <Avatar name={person.name} image={person.avatar} size={16} />}
              {person.display}
              <button
                type="button"
                aria-label={`Remove ${person.display}`}
                onClick={() => setChosen((now) => now.filter((p) => p.key !== person.key))}
                className="rounded p-0.5 text-faint hover:bg-line hover:text-fg"
              >
                <X size={12} />
              </button>
            </span>
          ))}
          <input
            ref={input}
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const count = Math.max(1, options.length);
                setActive((index) => (index + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
              } else if (event.key === "Enter") {
                event.preventDefault();
                const person = options[active];
                if (person && q) take(person);
                else void go();
              } else if (event.key === "Backspace" && !query && chosen.length) {
                setChosen((now) => now.slice(0, -1));
              }
            }}
            placeholder={chosen.length ? "" : "Name or @handle"}
            aria-label="Who to message"
            autoComplete="off"
            data-1p-ignore
            className="h-7 min-w-24 grow bg-transparent px-1 text-sm outline-none placeholder:text-faint"
          />
        </div>
      </div>
      <ul role="listbox" aria-label="People and agents" className="min-h-0 grow overflow-y-auto p-1.5">
        {options.length === 0 && (
          <li className="flex items-center gap-2 px-3 py-6 text-sm text-muted">
            <Search size={14} />
            {everyone.length === 0 ? "No one else is in this workspace yet." : "No one matches."}
          </li>
        )}
        {options.map((person, index) => (
          <li
            key={person.key}
            role="option"
            aria-selected={index === active}
            onMouseEnter={() => setActive(index)}
            onClick={() => take(person)}
            className={`flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 ${index === active ? "bg-raised" : ""}`}
          >
            {person.kind === "agent" ? <AgentMark size={28} /> : <Avatar name={person.name} image={person.avatar} size={28} />}
            <span className="min-w-0 grow">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <span className="truncate">{person.display}</span>
                {person.kind === "agent" && <AgentPill />}
              </span>
              <span className="block truncate text-xs text-faint">
                @{person.name}
                {person.role ? ` · ${person.role}` : ""}
              </span>
            </span>
            {index === active && <Check size={14} className="text-faint" />}
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
        <span className="min-w-0 truncate text-sm text-danger">{error}</span>
        <div className="flex shrink-0 gap-2">
          <button type="button" onClick={onDone} className={QUIET_BUTTON}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || chosen.length === 0}
            onClick={() => void go()}
            className="inline-flex h-9 items-center justify-center rounded-md bg-accent px-3.5 text-sm font-medium text-bg transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? "Opening…" : "Open conversation"}
          </button>
        </div>
      </div>
    </div>
  );
}
