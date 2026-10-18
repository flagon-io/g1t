import { User } from "lucide-react";
import { Link } from "react-router";

import { codingAgentById } from "@g1t/contracts/coding-agents";

import { type CommitPerson, type ShownCommit, profileHref, shownName } from "../lib/commit-people";
import { cn } from "../lib/cn";

import { AgentBadge, AgentCard, AgentMark, AuthorCard } from "./coding-agent";
import { UserCard } from "./user-card";
import { Avatar } from "./ui/avatar";

/**
 * A person on a commit, as an avatar: theirs and their card when the
 * commit is matched to an account (or is g1t's); a coding agent's mark
 * and card; else a silhouette with a card that says they're not on g1t.
 */
export function CommitAvatar({ person, size = 20 }: { person: CommitPerson; size?: number }) {
  if (person.kind === "user" || person.kind === "g1t") {
    const href = profileHref(person);
    const avatar = <Avatar name={shownName(person)} image={person.avatar} size={size} />;
    return (
      <UserCard username={person.username}>
        {href ? (
          // Its name beside it is the link a keyboard reaches; this is for the pointer.
          <Link to={href} tabIndex={-1} aria-hidden="true" className="relative z-10 inline-flex shrink-0 rounded-full">
            {avatar}
          </Link>
        ) : (
          <span className="relative z-10 inline-flex shrink-0">{avatar}</span>
        )}
      </UserCard>
    );
  }
  const agent = person.kind === "agent" ? codingAgentById(person.agent) : null;
  if (agent) {
    return (
      <AgentCard agentId={agent.id}>
        <span className="relative z-10 inline-flex shrink-0 rounded-full">
          <AgentMark agent={agent} size={size} />
        </span>
      </AgentCard>
    );
  }
  const silhouette = (
    <span aria-hidden="true" className="inline-flex shrink-0 items-center justify-center rounded-full bg-line text-faint" style={{ width: size, height: size }}>
      <User size={Math.round(size * 0.62)} strokeWidth={2.25} />
    </span>
  );
  // A deleted account: a plain silhouette, no card.
  if (person.kind === "ghost") return silhouette;
  // Nobody on g1t: the silhouette, with a card that says so.
  return (
    <AuthorCard name={person.name}>
      <span className="relative z-10 inline-flex shrink-0 rounded-full">{silhouette}</span>
    </AuthorCard>
  );
}

/**
 * A commit's author and co-authors, as overlapping avatars: the author's
 * on top, at most `max`.
 */
export function CommitAvatars({ commit, size = 20, max = 3 }: { commit: Pick<ShownCommit, "author" | "coAuthors">; size?: number; max?: number }) {
  const people = [commit.author, ...commit.coAuthors].slice(0, max);
  if (people.length === 1) return <CommitAvatar person={commit.author} size={size} />;
  return (
    <span className="inline-flex shrink-0 items-center">
      {people.map((person, index) => (
        <span
          key={`${index}:${person.username ?? person.name}`}
          className="inline-flex rounded-full ring-2 ring-bg"
          style={{ marginLeft: index === 0 ? 0 : -Math.round(size * 0.35), zIndex: people.length - index }}
        >
          <CommitAvatar person={person} size={size} />
        </span>
      ))}
    </span>
  );
}

/**
 * A person on a commit, by name: their username, linked to their profile
 * with their card, for an account; g1t with its label and card; ghost for
 * a deleted account; else the name written on the commit, as text.
 */
export function CommitName({ person, className }: { person: CommitPerson; className?: string }) {
  if (person.kind === "g1t") {
    return (
      <UserCard username="g1t">
        <span tabIndex={0} className="relative z-10 inline-flex items-baseline gap-1 rounded outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <span className={className}>g1t</span>
          <span className="rounded border border-line px-1 text-[0.625rem] leading-[1.35] font-medium text-muted">bot</span>
        </span>
      </UserCard>
    );
  }
  const agent = person.kind === "agent" ? codingAgentById(person.agent) : null;
  if (agent) {
    return (
      <AgentCard agentId={agent.id}>
        <span tabIndex={0} className="relative z-10 inline-flex items-baseline gap-1 rounded outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <span className={className}>{agent.name}</span>
          <AgentBadge agent={agent} />
        </span>
      </AgentCard>
    );
  }
  const href = profileHref(person);
  if (!href) {
    if (person.kind === "ghost") return <span className={className}>{shownName(person)}</span>;
    return (
      <AuthorCard name={person.name}>
        <span tabIndex={0} className={cn("relative z-10 rounded outline-none focus-visible:ring-2 focus-visible:ring-accent", className)}>
          {shownName(person)}
        </span>
      </AuthorCard>
    );
  }
  return (
    <UserCard username={person.username}>
      <Link to={href} className={cn("relative z-10 hover:underline", className)}>
        {shownName(person)}
      </Link>
    </UserCard>
  );
}

/**
 * Who made a commit, in words: the author, and its co-authors after them
 * ("ada and grace", "ada, grace and 2 others").
 */
export function CommitNames({
  commit,
  className,
  all,
}: {
  commit: Pick<ShownCommit, "author" | "coAuthors">;
  className?: string;
  /** Name every co-author, rather than counting past the first. */
  all?: boolean;
}) {
  const others = commit.coAuthors;
  if (others.length === 0) return <CommitName person={commit.author} className={className} />;
  if (all && others.length > 1) {
    const people = [commit.author, ...others];
    return (
      <>
        {people.map((person, index) => (
          <span key={index}>
            {index > 0 && (index === people.length - 1 ? " and " : ", ")}
            <CommitName person={person} className={className} />
          </span>
        ))}
      </>
    );
  }
  if (others.length === 1) {
    return (
      <>
        <CommitName person={commit.author} className={className} /> and <CommitName person={others[0]!} className={className} />
      </>
    );
  }
  return (
    <>
      <CommitName person={commit.author} className={className} /> and {others.length} others
    </>
  );
}
