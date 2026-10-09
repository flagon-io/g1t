import { Building2, Clock, GitCommitHorizontal, MapPin } from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useState } from "react";
import { Link, useParams } from "react-router";

import { type Card, type UserCard as UserCardData, cardHref, committedLabel } from "../lib/hovercard";
import { G1T_MENTION_HREF } from "../lib/markdown-plugins";
import { localTime } from "../lib/time-zone";
import { Avatar } from "./ui";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card";
import { Skeleton } from "./ui/skeleton";

/**
 * Cards read this visit, by address: each is asked for once, whichever
 * name or avatar opened it. A failure is forgotten, so the next hover asks
 * again.
 */
const cards = new Map<string, Promise<Card | null>>();

function readCard(href: string): Promise<Card | null> {
  let found = cards.get(href);
  if (!found) {
    found = fetch(href, { headers: { accept: "application/json" } })
      .then((response) => (response.ok ? (response.json() as Promise<Card>) : response.status === 404 ? null : Promise.reject(new Error(String(response.status)))))
      .catch(() => {
        cards.delete(href);
        return null;
      });
    cards.set(href, found);
  }
  return found;
}

/** Whether a name can have a card: a username, and not a deleted account's. */
export function hasCard(username: string | null | undefined): username is string {
  return Boolean(username) && username !== "ghost" && /^[a-z0-9-]{1,39}$/i.test(username!);
}

/**
 * A person's card, over their name or avatar (`children`, one element that
 * takes a ref). It opens on hover and on keyboard focus after a moment,
 * and is read only then. On a touch screen it never opens: a tap does what
 * the name does. Inside a repository it says whether they committed there
 * lately. Ghost, a deleted account, has none.
 */
export function UserCard({ username, children }: { username: string | null | undefined; children: ReactElement }) {
  const params = useParams();
  const [open, setOpen] = useState(false);
  const [card, setCard] = useState<Card | null | undefined>(undefined);
  const name = username?.toLowerCase() ?? "";
  const repo = params.owner && params.repo ? `${params.owner}/${params.repo}` : null;
  const g1t = name === "g1t";
  const href = cardHref(name, repo);

  useEffect(() => {
    if (!open || g1t || !hasCard(name)) return;
    let current = true;
    void readCard(href).then((found) => {
      if (current) setCard(found);
    });
    return () => {
      current = false;
    };
  }, [open, g1t, name, href]);

  if (!hasCard(name)) return children;
  // Nobody by that name (a workspace mentioned, say): no card at all.
  const body = g1t || card?.kind === "g1t" ? <G1tCard /> : card === undefined ? <Loading /> : card ? <PersonCard card={card} /> : null;
  return (
    <HoverCard open={open} onOpenChange={setOpen}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      {body && <HoverCardContent aria-label={g1t ? "About g1t" : `About ${name}`}>{body}</HoverCardContent>}
    </HoverCard>
  );
}

function Loading() {
  return (
    <div aria-busy="true" className="flex items-center gap-3">
      <Skeleton className="size-12 rounded-full" />
      <div className="grow space-y-2">
        <Skeleton className="block h-3.5 w-28" />
        <Skeleton className="block h-3 w-20" />
      </div>
    </div>
  );
}

function PersonCard({ card }: { card: UserCardData }) {
  const profile = `/u/${card.username}`;
  // Cards are only drawn in the browser, so this is the viewer's clock.
  const time = localTime(card.timezone, Date.now());
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <Link to={profile} tabIndex={-1} className="shrink-0 rounded-full">
          <Avatar name={card.username} image={card.avatar} size={48} />
        </Link>
        <div className="min-w-0 pt-0.5">
          <Link to={profile} className="block leading-tight hover:underline">
            {card.name ? (
              <>
                <span className="font-semibold wrap-anywhere">{card.name}</span>{" "}
                <span className="font-mono text-[0.8125rem] text-muted">{card.username}</span>
              </>
            ) : (
              <span className="font-mono font-semibold">{card.username}</span>
            )}
          </Link>
          {card.pronouns && <p className="mt-0.5 text-xs text-faint">{card.pronouns}</p>}
        </div>
      </div>
      {card.bio && <p className="leading-relaxed text-fg/90 wrap-anywhere">{card.bio}</p>}
      {(card.location || time || card.workspaces.length > 0 || card.committed) && (
        <ul className="space-y-1.5 text-[0.8125rem] text-muted">
          {card.location && (
            <Line icon={<MapPin size={14} />}>
              <span className="wrap-anywhere">{card.location}</span>
            </Line>
          )}
          {time && <Line icon={<Clock size={14} />}>{time} local time</Line>}
          {card.workspaces.length > 0 && (
            <Line icon={<Building2 size={14} />}>
              Member of{" "}
              {card.workspaces.map((workspace, index) => (
                <span key={workspace.slug}>
                  {index > 0 && ", "}
                  <Link to={`/${workspace.slug}`} className="font-medium text-fg hover:underline">
                    {workspace.name}
                  </Link>
                </span>
              ))}
              {card.more_workspaces > 0 && ` and ${card.more_workspaces} more`}
            </Line>
          )}
          {card.committed && <Line icon={<GitCommitHorizontal size={14} />}>{committedLabel(card.committed)}</Line>}
        </ul>
      )}
    </div>
  );
}

function G1tCard() {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Avatar name="g1t" size={48} />
        <div className="min-w-0">
          <p className="flex items-baseline gap-1.5 leading-tight">
            <span className="font-mono font-semibold">g1t</span>
            <span className="rounded border border-line px-1 text-[0.625rem] leading-[1.35] font-medium text-muted">bot</span>
          </p>
          <p className="mt-0.5 text-xs text-muted">g1t's agent</p>
        </div>
      </div>
      <p className="leading-relaxed text-fg/90">
        Mention <span className="font-medium text-accent">@g1t</span> in a comment or assign it an issue, and it opens a
        pull request and sees it through.
      </p>
      <a href={G1T_MENTION_HREF} className="inline-block text-[0.8125rem] text-accent hover:underline">
        Working with g1t
      </a>
    </div>
  );
}

function Line({ icon, children }: { icon: ReactElement; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0 text-faint">{icon}</span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}
