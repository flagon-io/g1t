import { Link } from "react-router";

import type { Member } from "@g1t/contracts";

import { Unavailable } from "./boundary";
import { Avatar } from "./ui/avatar";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";
import { type Failed, isFailed } from "../lib/partial";
import { settingsPath } from "../lib/workspace-nav";

/** Most members listed before "and N more". */
const MAX_FACES = 10;

/**
 * Who is in the workspace, for every member: the first faces and how many
 * more, owners marked. An owner's link manages them in the settings;
 * everyone else's opens the People directory.
 */
export function MembersCard({ slug, owner, members }: { slug: string; owner: boolean; members: Member[] | Failed | null }) {
  return (
    <Card asChild className="self-start p-5">
      <section>
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Members{members && !isFailed(members) ? ` · ${members.length}` : ""}</h2>
          <Link to={owner ? settingsPath(slug, "members") : `/${slug}/-/people`} className="text-xs text-muted hover:text-fg">
            {owner ? "Manage" : "See all"}
          </Link>
        </div>
        {isFailed(members) ? (
          <div className="mt-3">
            <Unavailable what={members.what} compact />
          </div>
        ) : members ? (
          <>
            <ul className="mt-3 space-y-2">
              {members.slice(0, MAX_FACES).map((member) => (
                <li key={member.username} className="flex items-center gap-2.5 text-sm">
                  <Avatar name={member.username} image={member.avatar} size={24} />
                  <Link to={`/u/${member.username}`} className="min-w-0 grow truncate hover:text-accent">
                    {member.name?.trim() || member.username}
                    {member.name?.trim() && <span className="ml-1.5 font-mono text-xs text-faint">{member.username}</span>}
                  </Link>
                  {member.role === "owner" && <Badge size="md">owner</Badge>}
                </li>
              ))}
            </ul>
            {members.length > MAX_FACES && <p className="mt-2 text-xs text-faint">and {members.length - MAX_FACES} more</p>}
          </>
        ) : (
          <p className="mt-3 text-sm text-muted">The member list isn&apos;t available right now.</p>
        )}
      </section>
    </Card>
  );
}
