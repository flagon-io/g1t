import { Clock, MapPin, MessageSquare, UserRound, Users } from "lucide-react";
import { type ReactNode, createContext, useContext, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";

import { type WorkspaceAgent, shownUsername } from "@g1t/contracts";

import { useChatSend } from "./actions";
import { AgentPill, StatusDot, statusLabel } from "./marks";
import { AgentAvatar } from "../agent-avatar";
import { placeOf } from "../agents-mode";
import { BottomSheet } from "../mobile";
import { PresenceSummary, WithPresence } from "../presence";
import { isOrchestrator } from "../orchestrator";
import { Avatar } from "../ui";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Skeleton } from "../ui/skeleton";
import { formatDollars } from "../../lib/agent-form";
import type { UserCard } from "../../lib/hovercard";
import { localTime } from "../../lib/time-zone";

/** A person's card as Chat reads it: the hovercard, and their teams here. */
export type PersonCard = UserCard & { teams: { slug: string; name: string }[] };

/** What a card needs from the conversation it opens in. */
export type CardContextValue = {
  slug: string;
  agents: WorkspaceAgent[];
  /** Opens the profile panel beside the conversation, in place of its details. */
  onViewProfile: (username: string) => void;
};

/** The conversation's card context; outside one, names are plain links. */
export const CardContext = createContext<CardContextValue | null>(null);

/** People's cards, read once per page and shared: hovering prefetches, opening uses it. */
const cards = new Map<string, Promise<PersonCard | null>>();

export function personCard(slug: string, username: string): Promise<PersonCard | null> {
  const key = `${slug}:${username.toLowerCase()}`;
  let found = cards.get(key);
  if (!found) {
    found = fetch(`/${slug}/-/chat/person/${encodeURIComponent(username)}`)
      .then((response) => (response.ok ? (response.json() as Promise<PersonCard>) : null))
      .catch(() => null);
    cards.set(key, found);
  }
  return found;
}

function usePersonCard(slug: string, username: string, open: boolean): PersonCard | null | undefined {
  const [card, setCard] = useState<PersonCard | null | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void personCard(slug, username).then((value) => {
      if (live) setCard(value);
    });
    return () => {
      live = false;
    };
  }, [slug, username, open]);
  return card;
}

/** Opens (or makes) the direct message with someone, then goes there. */
function useMessage(slug: string) {
  const send = useChatSend(slug);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  return {
    busy,
    open: async (member: string) => {
      setBusy(true);
      const opened = await send<{ to: string }>({ intent: "dm", members: [member] });
      setBusy(false);
      if (opened.ok) navigate(opened.value.to);
    },
  };
}

const PRIMARY = "inline-flex h-9 grow items-center justify-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-medium text-bg transition-colors hover:bg-accent-hover disabled:opacity-60 max-md:h-11";
const QUIET = "inline-flex h-9 grow items-center justify-center gap-1.5 rounded-lg border border-line px-3 text-sm font-medium text-fg/90 transition-colors hover:border-line-strong hover:bg-raised max-md:h-11";

function PersonBody({ username, display, avatar, ctx, open, close }: { username: string; display: string; avatar: string | null; ctx: CardContextValue; open: boolean; close: () => void }) {
  const card = usePersonCard(ctx.slug, username, open);
  const message = useMessage(ctx.slug);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setNow(Date.now()), [open]);
  const time = card ? localTime(card.timezone, now) : null;
  return (
    <div className="w-full">
      <div className="flex items-start gap-3.5">
        <WithPresence person={{ username }} size={56} ring="var(--color-raised)">
          <Avatar name={username} image={card?.avatar ?? avatar} size={56} />
        </WithPresence>
        <div className="min-w-0 pt-1">
          <p className="truncate text-base font-semibold">{card?.name?.trim() || display}</p>
          <p className="truncate font-mono text-xs text-muted">
            @{card ? shownUsername(card) : username}
            {card?.pronouns ? <span className="font-sans"> · {card.pronouns}</span> : null}
          </p>
        </div>
      </div>
      {/* Live: their status and whether they are here (components/presence.tsx). */}
      <PresenceSummary person={{ username }} className="mt-3 text-[0.8125rem] text-muted" />
      <div className="mt-3 space-y-1.5 text-[0.8125rem] text-muted">
        {card === undefined ? (
          <>
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-28" />
          </>
        ) : (
          <>
            {card?.bio && <p className="line-clamp-2 text-fg-soft">{card.bio}</p>}
            {card && card.teams.length > 0 && (
              <p className="flex items-center gap-2">
                <Users size={13} className="shrink-0 text-faint" />
                <span className="truncate">{card.teams.map((team) => team.name).join(", ")}</span>
              </p>
            )}
            {time && (
              <p className="flex items-center gap-2" suppressHydrationWarning>
                <Clock size={13} className="shrink-0 text-faint" />
                {time} local time
              </p>
            )}
            {card?.location && (
              <p className="flex items-center gap-2">
                <MapPin size={13} className="shrink-0 text-faint" />
                <span className="truncate">{card.location}</span>
              </p>
            )}
          </>
        )}
      </div>
      <div className="mt-4 flex gap-2">
        <button type="button" disabled={message.busy} onClick={() => void message.open(`user:${username}`)} className={PRIMARY}>
          <MessageSquare size={15} />
          {message.busy ? "Opening…" : "Message"}
        </button>
        <button
          type="button"
          onClick={() => {
            close();
            ctx.onViewProfile(username);
          }}
          className={QUIET}
        >
          <UserRound size={15} />
          View profile
        </button>
      </div>
    </div>
  );
}

function AgentBody({ agent, ctx }: { agent: WorkspaceAgent; ctx: CardContextValue }) {
  const message = useMessage(ctx.slug);
  const g1t = isOrchestrator(agent);
  const cap = agent.budget.monthly_micros;
  const share = cap ? Math.min(1, agent.spent_month_micros / cap) : null;
  return (
    <div className="w-full">
      <div className="flex items-start gap-3.5">
        <AgentAvatar agent={agent} size={56} />
        <div className="min-w-0 pt-1">
          <p className="flex items-center gap-2 text-base font-semibold">
            <span className="truncate">{agent.display_name}</span>
            <AgentPill />
          </p>
          <p className="truncate text-xs text-muted">{g1t ? "Orchestrator" : `${agent.title || agent.role} · ${placeOf(agent)}`}</p>
        </div>
      </div>
      <div className="mt-3 space-y-2 text-[0.8125rem] text-muted">
        <p className="flex items-center gap-2">
          <StatusDot status={agent.status} />
          {statusLabel(agent.status)}
          {agent.status === "working" ? <span className="text-faint">· on a task now</span> : null}
        </p>
        {!g1t && agent.responsibilities.length > 0 && <p className="line-clamp-2 text-fg-soft">{agent.responsibilities.slice(0, 2).join(" · ")}</p>}
        {cap != null && share != null && (
          <div>
            <p className="flex justify-between text-xs">
              <span>This month</span>
              <span className="tabular-nums">
                {formatDollars(agent.spent_month_micros)} of {formatDollars(cap)}
              </span>
            </p>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line">
              <div className={`h-full rounded-full ${share >= 1 ? "bg-danger" : share >= 0.8 ? "bg-warn" : "bg-accent"}`} style={{ width: `${Math.max(2, share * 100)}%` }} />
            </div>
          </div>
        )}
      </div>
      <div className="mt-4 flex gap-2">
        <button type="button" disabled={message.busy} onClick={() => void message.open(`agent:${agent.id}`)} className={PRIMARY}>
          <MessageSquare size={15} />
          {message.busy ? "Opening…" : "Message"}
        </button>
        <Link to={`/${ctx.slug}/-/agents/${agent.handle}`} className={QUIET}>
          Profile
        </Link>
      </div>
    </div>
  );
}

/**
 * A name or avatar that opens the member's card: a popover beside it, or a
 * sheet from the bottom on a phone. People get Message and View profile
 * (a panel beside the conversation); agents get Message and Profile.
 * Hovering or focusing it reads the card ahead. Outside a conversation it
 * is a plain link.
 */
export function MemberCard({
  member,
  children,
  className = "",
  label,
}: {
  member: { kind: "user" | "agent"; name: string; id?: string; display_name?: string; avatar?: string | null };
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  const ctx = useContext(CardContext);
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const agent =
    member.kind === "agent" ? (ctx?.agents.find((a) => a.id === member.id || a.handle === member.name.toLowerCase()) ?? null) : null;
  const href = member.kind === "agent" ? `/${ctx?.slug ?? ""}/-/agents/${member.name}` : `/u/${member.name}`;
  if (!ctx || (member.kind === "agent" && !agent)) {
    return (
      <Link to={href} className={className} aria-label={label}>
        {children}
      </Link>
    );
  }
  const prefetch = () => {
    if (member.kind === "user") void personCard(ctx.slug, member.name);
  };
  const body = (close: () => void, isOpen: boolean) =>
    agent ? (
      <AgentBody agent={agent} ctx={ctx} />
    ) : (
      <PersonBody username={member.name} display={member.display_name ?? member.name} avatar={member.avatar ?? null} ctx={ctx} open={isOpen} close={close} />
    );
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={label ?? `${member.display_name ?? member.name}'s card`}
            onPointerEnter={prefetch}
            onFocus={prefetch}
            onTouchStart={prefetch}
            onClick={(event) => {
              // A phone: the card is a sheet from the bottom instead.
              if (window.matchMedia("(max-width: 767px)").matches) {
                event.preventDefault();
                setSheet(true);
              }
            }}
            className={`cursor-pointer text-left ${className}`}
          >
            {children}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-4">
          {body(() => setOpen(false), open)}
        </PopoverContent>
      </Popover>
      <BottomSheet open={sheet} onOpenChange={setSheet} title={`${member.display_name ?? member.name}`}>
        <div className="px-2 pt-1 pb-2">{body(() => setSheet(false), sheet)}</div>
      </BottomSheet>
    </>
  );
}
