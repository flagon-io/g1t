import { Check, Globe, Hash, Lock, Plus, Search, SquarePen, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useNavigate, useRouteLoaderData } from "react-router";

import type { ChannelVisibility, ChatSidebar, Result } from "@g1t/contracts";

import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { Hint } from "../ui/hint";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { RadioGroup, RadioOption } from "../ui/radio-group";
import { channelName, shownHandle, shownName } from "../../lib/chat";
import type { ChatLayoutData } from "../../routes/workspace/chat/layout";
import { useLiveCounts } from "../../lib/notify-client";
import { browserTimeZone } from "../../lib/time-zone";
import { overlayEntries, unlisted } from "../../lib/notify-store";

/** Chat mode's data, while a chat page is open; undefined elsewhere. */
export function useChatData(): ChatLayoutData | undefined {
  return useRouteLoaderData("routes/workspace/chat/layout") as ChatLayoutData | undefined;
}

/** The sidebar's own fetcher: every component that refreshes it shares this one. */
export const SIDEBAR_FETCHER = "chat-sidebar";

/**
 * The sidebar as last read: refreshed in place, else what the page loaded.
 * Off Chat's own pages (its sessions, `-/chat/sessions`, are not under its
 * layout), `home` names the workspace and the sidebar reads itself once.
 */
export function useChatSidebar(home?: string): { sidebar: ChatSidebar | null; refresh: () => void } {
  const data = useChatData();
  const fetcher = useFetcher<Result<ChatSidebar>>({ key: SIDEBAR_FETCHER });
  const slug = data?.slug ?? home;
  const refresh = useCallback(() => {
    if (slug) fetcher.load(`/${slug}/-/chat/api`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);
  useEffect(() => {
    if (!data && home && fetcher.state === "idle" && fetcher.data === undefined) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, home]);
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
  // Notify: the feed socket's counts (lib/notify-client.ts) over the sidebar as read, live.
  const live = useLiveCounts(slug);
  useEffect(() => setRead(new Set()), [sidebar, live]);
  const shown = useMemo(() => {
    const counted = sidebar && live ? { ...sidebar, entries: overlayEntries(sidebar.entries, live) } : sidebar;
    return counted && read.size > 0
      ? { ...counted, entries: counted.entries.map((e) => (read.has(e.channel.id) ? { ...e, unread: 0, mentions: 0 } : e)) }
      : counted;
  }, [sidebar, read, live]);
  // A conversation the feed counts that the sidebar does not list (a new DM): read the sidebar again.
  const missing = sidebar ? unlisted(sidebar.entries, live).join(",") : "";
  useEffect(() => {
    if (missing) refresh();
  }, [missing, refresh]);
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

/** Why someone may not make a channel: the workspace keeps it to its owners. */
export const OWNERS_ONLY_CHANNELS = "Only workspace owners can create channels here.";

/**
 * What the viewer may make, from the workspace's chat settings (Settings,
 * Chat). Until the sidebar arrives, everything: the chat service checks.
 */
export function useChannelCreation(): { public: boolean; private: boolean; any: boolean; open: boolean } {
  const { sidebar } = useChatSidebar();
  // `create_public_channels` is the setting's old name for channels anyone in the workspace can join.
  const shared = sidebar?.can?.create_public_channels ?? true;
  const closed = sidebar?.can?.create_private_channels ?? true;
  // Open to anyone on g1t: the workspace's owners only.
  const open = shared && sidebar?.can?.make_public === true;
  return { public: shared, private: closed, any: shared || closed, open };
}

/**
 * Making a channel: its name, what it is for, and who can open it:
 * private, the workspace, or anyone on g1t (owners only). Someone the
 * workspace's settings do not let make one sees the button turned off,
 * with why; a kind they may not make is shown off, with why.
 */
export function CreateChannelButton({ slug, variant = "icon" }: { slug: string; variant?: "icon" | "button" }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [chosen, setChosen] = useState<ChannelVisibility>("workspace");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = useChatSend(slug);
  const navigate = useNavigate();
  const may = useChannelCreation();
  // A kind they may not make falls back to one they may.
  const visibility: ChannelVisibility =
    chosen === "private" && !may.private
      ? "workspace"
      : chosen !== "private" && !may.public
        ? "private"
        : chosen === "public" && !may.open
          ? "workspace"
          : chosen;
  const isPrivate = visibility === "private";
  const clean = channelName(name);
  const submit = async () => {
    if (!clean) return setError("Give the channel a name.");
    setBusy(true);
    setError(null);
    const made = await send<{ to: string }>({ intent: "create_channel", name: clean, topic, private: isPrivate, visibility });
    setBusy(false);
    if (!made.ok) return setError(made.error.message);
    setOpen(false);
    setName("");
    setTopic("");
    navigate(made.value.to);
  };
  if (!may.any) {
    // Shown off, not hidden, so nobody wonders where it went.
    return (
      <Hint label={OWNERS_ONLY_CHANNELS} disabled>
        {variant === "icon" ? (
          <Button type="button" aria-label="Create a channel" disabled variant="ghost" size="icon-xs" className="text-faint opacity-40">
            <Plus size={14} />
          </Button>
        ) : (
          <Button type="button" disabled variant="outline" className="opacity-50">
            <Lock size={14} />
            Create a channel
          </Button>
        )}
      </Hint>
    );
  }
  return (
    <>
      {variant === "icon" ? (
        <Hint label="Create a channel">
          <Button type="button" aria-label="Create a channel" onClick={() => setOpen(true)} variant="ghost" size="icon-xs" className="text-faint">
            <Plus size={14} />
          </Button>
        </Hint>
      ) : (
        <Button type="button" onClick={() => setOpen(true)} variant="outline">
          <Hash size={15} />
          Create a channel
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a channel</DialogTitle>
            <DialogDescription>A place for one topic: a project, a team, a launch. Invite people once it's made.</DialogDescription>
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
                {isPrivate ? (
                  <Lock size={14} className="text-faint" />
                ) : visibility === "public" ? (
                  <Globe size={14} className="text-faint" />
                ) : (
                  <Hash size={14} className="text-faint" />
                )}
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
            <fieldset className="grid gap-2">
              <legend className="mb-1.5 text-sm font-medium text-muted">Who can open it</legend>
              <RadioGroup value={visibility} onValueChange={(value) => setChosen(value as ChannelVisibility)} className="grid gap-3">
                <RadioOption
                  value="workspace"
                  icon={<Hash />}
                  label="Workspace"
                  description={may.public ? "Anyone in the workspace can find, read and join it." : "Only workspace owners can create these here."}
                  disabled={!may.public}
                />
                <RadioOption
                  value="private"
                  icon={<Lock />}
                  label="Private"
                  description={
                    may.private ? "Only the people you invite can find and read it. Others can ask to join." : "Only workspace owners can create these here."
                  }
                  disabled={!may.private}
                />
                <RadioOption
                  value="public"
                  icon={<Globe />}
                  label="Public"
                  description={
                    may.open
                      ? "Anyone signed in to g1t can read, join and talk in it, marked Guest. A community or support channel."
                      : "Open to anyone on g1t. Only workspace owners can make one."
                  }
                  disabled={!may.open}
                />
              </RadioGroup>
            </fieldset>
            {error && <p className="text-sm text-danger">{error}</p>}
            <DialogFooter>
              <Button type="button" onClick={() => setOpen(false)} variant="outline">
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !clean} variant="accent">
                {busy ? "Creating…" : "Create channel"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Someone a new message can go to. */
type Pickable = { key: string; name: string; handle: string; display: string; avatar: string | null };

/**
 * A new direct message: choose one person or a few, then open the
 * conversation between you (the same one each time for the same people).
 */
export function NewMessageButton({ slug, variant = "icon", children }: { slug: string; variant?: "icon" | "button" | "fab"; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {variant === "fab" ? (
        // A phone's list: the round button above the tab bar.
        <Button
          type="button"
          aria-label="New"
          onClick={() => setOpen(true)}
          variant="accent"
          size="icon"
          className="size-14 rounded-2xl shadow-lg shadow-black/50 transition-transform active:scale-95"
        >
          <SquarePen size={22} />
        </Button>
      ) : variant === "icon" ? (
        <Hint label="New: ask g1t, or message someone">
          <Button type="button" aria-label="New" onClick={() => setOpen(true)} variant="ghost" size="icon-sm" className="text-faint">
            <SquarePen size={15} />
          </Button>
        </Hint>
      ) : (
        <Button type="button" onClick={() => setOpen(true)} variant="outline">
          <SquarePen size={15} />
          {children ?? "New message"}
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md gap-0 p-0 max-sm:pb-[env(safe-area-inset-bottom)]" showClose={false}>
          {open && <NewDialog slug={slug} onDone={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * New, as claude.ai has it: what you want done, to g1t, first; or a
 * message to one person or a few. Starting with g1t opens your direct
 * message with g1t on a new conversation (it reads only what comes next)
 * and sends what you wrote there, so you never type its name.
 */
function NewDialog({ slug, onDone }: { slug: string; onDone: () => void }) {
  const [mode, setMode] = useState<"g1t" | "people">("g1t");
  const tab = (key: "g1t" | "people", label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === key}
      onClick={() => setMode(key)}
      className={`h-7 rounded-[5px] px-3 text-[0.8125rem] font-medium transition-colors ${mode === key ? "bg-raised text-fg shadow-sm ring-1 ring-line-strong" : "text-muted hover:text-fg"}`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex max-h-[min(36rem,calc(100dvh-2rem))] flex-col">
      <div className="flex items-center justify-between gap-3 px-5 pt-5">
        <DialogTitle>New</DialogTitle>
        <div role="tablist" aria-label="Start" className="flex rounded-md bg-surface p-0.5 ring-1 ring-line">
          {tab("g1t", "Ask g1t")}
          {tab("people", "Message people")}
        </div>
      </div>
      {mode === "g1t" ? <NewWithG1t slug={slug} onDone={onDone} /> : <NewMessage slug={slug} onDone={onDone} />}
    </div>
  );
}

/** What you want done, to g1t: a new conversation in your direct message with it, opened with what you wrote. */
function NewWithG1t({ slug, onDone }: { slug: string; onDone: () => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = useChatSend(slug);
  const navigate = useNavigate();
  const start = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    const opened = await send<{ channel: { id: string }; to: string }>({ intent: "g1t_dm" });
    if (!opened.ok) {
      setBusy(false);
      return setError(opened.error.message);
    }
    const channel_id = opened.value.channel.id;
    // A new conversation: g1t reads only what comes after this, as New means.
    await send({ intent: "g1t_reset", channel_id });
    const posted = await send({ intent: "post", channel_id, body, page: { time_zone: browserTimeZone() } });
    setBusy(false);
    if (!posted.ok) return setError(posted.error.message);
    onDone();
    navigate(opened.value.to);
  };
  return (
    <>
      <DialogDescription className="px-5 pt-1.5">
        What do you want done? g1t starts on it in a new conversation, in your direct message with it.
      </DialogDescription>
      <div className="px-5 pt-4 pb-4">
        <textarea
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void start();
            }
          }}
          rows={4}
          placeholder="Ask g1t what changed, what's blocked, or what to do next"
          aria-label="What do you want done"
          className="w-full resize-none rounded-md border border-line bg-bg px-3 py-2.5 text-sm outline-none placeholder:text-faint focus:border-accent-dim"
        />
        <p className="mt-1.5 text-xs text-faint">Enter starts it, Shift Enter makes a new line.</p>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
        <span className="min-w-0 truncate text-sm text-danger">{error}</span>
        <div className="flex shrink-0 gap-2">
          <Button type="button" onClick={onDone} variant="outline">
            Cancel
          </Button>
          <Button type="button" disabled={busy || !text.trim()} onClick={() => void start()} variant="accent">
            {busy ? "Starting…" : "Start"}
          </Button>
        </div>
      </div>
    </>
  );
}

/** A message to one person or a few: who, then on to the conversation with them. */
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
    return (data?.people ?? [])
      .filter((person) => person.name.toLowerCase() !== me)
      .map((person) => ({ key: `user:${person.name}`, name: person.name, handle: shownHandle(person), display: shownName(person), avatar: person.avatar }));
  }, [data]);
  const q = query.trim().toLowerCase().replace(/^@/, "");
  const picked = new Set(chosen.map((p) => p.key));
  const options = everyone.filter((p) => !picked.has(p.key) && (!q || p.name.toLowerCase().includes(q) || p.display.toLowerCase().includes(q)));
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
    <>
      <div className="border-b border-line px-5 pt-1.5 pb-4">
        <DialogDescription>To one person or a few.</DialogDescription>
        <div className="mt-4 flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border border-line bg-bg px-2 py-1.5 focus-within:border-accent-dim">
          <span className="pl-1 text-sm text-faint">To:</span>
          {chosen.map((person) => (
            <span key={person.key} className="flex h-6 items-center gap-1.5 rounded-md bg-raised pr-1 pl-1 text-[0.8125rem]">
              <Avatar name={person.name} image={person.avatar} size={16} />
              {person.display}
              <Button
                type="button"
                aria-label={`Remove ${person.display}`}
                onClick={() => setChosen((now) => now.filter((p) => p.key !== person.key))}
                variant="ghost"
                size="inline"
                className="rounded p-0.5 text-faint hover:bg-line"
              >
                <X size={12} />
              </Button>
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
      <ul role="listbox" aria-label="People" className="min-h-0 grow overflow-y-auto p-1.5">
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
            <Avatar name={person.name} image={person.avatar} size={28} />
            <span className="min-w-0 grow">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <span className="truncate">{person.display}</span>
              </span>
              <span className="block truncate text-xs text-faint">@{person.handle}</span>
            </span>
            {index === active && <Check size={14} className="text-faint" />}
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
        <span className="min-w-0 truncate text-sm text-danger">{error}</span>
        <div className="flex shrink-0 gap-2">
          <Button type="button" onClick={onDone} variant="outline">
            Cancel
          </Button>
          <Button type="button" disabled={busy || chosen.length === 0} onClick={() => void go()} variant="accent">
            {busy ? "Opening…" : "Open conversation"}
          </Button>
        </div>
      </div>
    </>
  );
}
