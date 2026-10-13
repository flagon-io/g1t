import { Clock, MapPin, MessageSquare, UserRound, Users } from "lucide-react";
import { type ReactNode, createContext, useContext, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";

import { shownUsername } from "@g1t/contracts";

import { useChatSend } from "./actions";
import { BottomSheet } from "../mobile";
import { PresenceSummary, WithPresence } from "../presence";

import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Skeleton } from "../ui/skeleton";
import type { UserCard } from "../../lib/hovercard";
import { localTime } from "../../lib/time-zone";

/** A person's card as Chat reads it: the hovercard, and their teams here. */
export type PersonCard = UserCard & { teams: { slug: string; name: string }[] };

/** What a card needs from the conversation it opens in. */
export type CardContextValue = {
  slug: string;
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
        <Button type="button" disabled={message.busy} onClick={() => void message.open(`user:${username}`)} variant="accent" className="grow rounded-lg max-md:h-11">
          <MessageSquare size={15} />
          {message.busy ? "Opening…" : "Message"}
        </Button>
        <Button
          type="button"
          onClick={() => {
            close();
            ctx.onViewProfile(username);
          }}
          variant="outline" className="grow rounded-lg max-md:h-11">
          <UserRound size={15} />
          View profile
        </Button>
      </div>
    </div>
  );
}

/**
 * A name or avatar that opens the member's card: a popover beside it, or a
 * sheet from the bottom on a phone: Message and View profile (a panel
 * beside the conversation). Hovering or focusing it reads the card ahead.
 * Outside a conversation it is a plain link; an old agent's name (agents
 * no longer exist) is plain text.
 */
export function MemberCard({
  member,
  children,
  className = "",
  label,
}: {
  member: { kind: "user" | "agent" | "system"; name: string; id?: string; display_name?: string; avatar?: string | null };
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  const ctx = useContext(CardContext);
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  // An old agent, or @g1t: no profile to open.
  if (member.kind !== "user") {
    return (
      <span className={className} aria-label={label}>
        {children}
      </span>
    );
  }
  if (!ctx) {
    return (
      <Link to={`/u/${member.name}`} className={className} aria-label={label}>
        {children}
      </Link>
    );
  }
  const prefetch = () => void personCard(ctx.slug, member.name);
  const body = (close: () => void, isOpen: boolean) => (
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
