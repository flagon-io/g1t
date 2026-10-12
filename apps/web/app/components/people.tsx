/**
 * Pieces of People's pages: a person's face with their presence,
 * someone's local time, and a label for what is coming.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router";

import type { DirectoryPerson } from "@g1t/contracts";

import { WithPresence } from "./presence";

import { Avatar } from "./ui/avatar";
import { Badge } from "./ui/badge";
import { cn } from "../lib/cn";
import { personName, personPath } from "../lib/people";
import { localTime } from "../lib/time-zone";

/** A person's avatar, with their presence in its corner. */
export function PersonFace({ person, size = 28, ring }: { person: Pick<DirectoryPerson, "user_id" | "username" | "avatar">; size?: number; ring?: string }) {
  return (
    <WithPresence person={{ id: person.user_id, username: person.username }} size={size} ring={ring}>
      <Avatar name={person.username} image={person.avatar} size={size} />
    </WithPresence>
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
