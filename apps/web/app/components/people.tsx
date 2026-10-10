/**
 * Pieces of People's pages: a person's face with their presence, an
 * agent's with its status, someone's local time, what a team is made of,
 * and a label for what is coming.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router";

import { type DirectoryPerson, type TeamKind, teamKind } from "@g1t/contracts";

import { AgentFace } from "./agents-mode";
import { StatusDot } from "./chat/marks";
import { WithPresence } from "./presence";

import { Avatar } from "./ui/avatar";
import { Badge } from "./ui/badge";
import { Hint } from "./ui/hint";
import { cn } from "../lib/cn";
import { type PeopleAgent, agentPath, personName, personPath } from "../lib/people";
import { localTime } from "../lib/time-zone";

/** A person's avatar, with their presence in its corner. */
export function PersonFace({ person, size = 28, ring }: { person: Pick<DirectoryPerson, "user_id" | "username" | "avatar">; size?: number; ring?: string }) {
  return (
    <WithPresence person={{ id: person.user_id, username: person.username }} size={size} ring={ring}>
      <Avatar name={person.username} image={person.avatar} size={size} />
    </WithPresence>
  );
}

/** An agent's face, with its status in its corner. */
export function AgentPersonFace({ agent, size = 28, ring = "var(--color-bg)" }: { agent: PeopleAgent; size?: number; ring?: string }) {
  return (
    <span className="relative inline-flex shrink-0">
      <AgentFace agent={agent} size={size} ring={ring} />
      {agent.status !== "idle" && (
        <span className="absolute -top-0.5 -right-0.5 inline-flex rounded-full" style={{ boxShadow: `0 0 0 2px ${ring}` }}>
          <StatusDot status={agent.status} className="block" />
        </span>
      )}
    </span>
  );
}

/**
 * Someone's local time, worked out in the browser (the server's clock is
 * not theirs), and kept current. Nothing when they gave no time zone.
 */
export function LocalTime({ zone, className, suffix = "local" }: { zone: string | null; className?: string; suffix?: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  if (!zone || now == null) return null;
  const time = localTime(zone, now);
  if (!time) return null;
  return (
    <span className={className}>
      {time} {suffix}
    </span>
  );
}

const KIND_MARK: Record<TeamKind, string> = {
  mixed: "bg-[linear-gradient(135deg,var(--color-success)_50%,var(--color-accent)_50%)]",
  people: "bg-success",
  agents: "bg-accent",
  empty: "bg-line-strong",
};

const KIND_WORDS: Record<TeamKind, string> = {
  mixed: "People and agents",
  people: "People only",
  agents: "Agents only",
  empty: "No one yet",
};

/** A small square that says what a team is made of: people, agents, or both. */
export function TeamKindMark({ people, agents, className }: { people: number; agents: number; className?: string }) {
  const kind = teamKind(people, agents);
  return (
    <Hint label={KIND_WORDS[kind]}>
      <span tabIndex={0} className={cn("inline-block size-2.5 shrink-0 rounded-[3px]", KIND_MARK[kind], className)}>
        <span className="sr-only">{KIND_WORDS[kind]}</span>
      </span>
    </Hint>
  );
}

/** Something that is planned and not here yet. */
export function Coming({ children = "Coming" }: { children?: string }) {
  return <Badge className="border-dashed">{children}</Badge>;
}

/** A person's name, linked to their profile. */
export function PersonLink({ workspace, person, className }: { workspace: string; person: Pick<DirectoryPerson, "username" | "name" | "display_username">; className?: string }) {
  return (
    <Link to={personPath(workspace, person.username)} prefetch="intent" className={cn("hover:text-accent", className)}>
      {personName(person)}
    </Link>
  );
}

/** An agent's name, linked to its People profile. */
export function AgentLink({ workspace, agent, className }: { workspace: string; agent: Pick<PeopleAgent, "handle" | "display_name">; className?: string }) {
  return (
    <Link to={agentPath(workspace, agent.handle)} prefetch="intent" className={cn("hover:text-accent", className)}>
      {agent.display_name}
    </Link>
  );
}

/** The small "agent" label after an agent's name. */
export function AgentTag() {
  return <Badge tone="accent">Agent</Badge>;
}

/** What the agent is told, as it reads: headings, lines and lists. */
export function ToldText({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="space-y-1.5 text-sm text-fg-soft">
      {lines.map((line, index) => {
        if (line.startsWith("## ")) return null;
        if (line.startsWith("### ")) {
          return (
            <h3 key={index} className="pt-2 font-medium text-fg first:pt-0">
              {line.slice(4)}
            </h3>
          );
        }
        if (line.startsWith("- ")) {
          return (
            <p key={index} className="relative pl-4 before:absolute before:left-1 before:text-faint before:content-['•']">
              {line.slice(2)}
            </p>
          );
        }
        if (!line.trim()) return null;
        return <p key={index}>{line}</p>;
      })}
    </div>
  );
}
