import { Link } from "react-router";

import type { Route } from "./+types/stargazers";
import { Avatar, ButtonLink, EmptyState, TimeAgo } from "../../components/ui";
import { requireRepo } from "../../lib/access.server";
import { page } from "../../lib/meta";
import { repos } from "../../lib/services.server";
import { unwrap } from "../../lib/session.server";
import { UserCard } from "../../components/user-card";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Stargazers · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const { viewer } = await requireRepo(context, params, "read");
  const pageNumber = Math.max(1, Number(new URL(request.url).searchParams.get("page")) || 1);
  const path = { namespace: params.owner, name: params.repo };
  const [stargazers, stars] = await Promise.all([repos.stargazers(path, viewer, pageNumber), repos.stars(path, viewer)]);
  return { stargazers: unwrap(stargazers), total: stars.ok ? stars.value.stars : null, page: pageNumber };
}

export default function Stargazers({ loaderData }: Route.ComponentProps) {
  const { stargazers, total, page: at } = loaderData;
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold tracking-tight">
        Stargazers {total != null && <span className="font-normal text-faint">{total.toLocaleString("en-US")}</span>}
      </h2>
      {stargazers.length === 0 ? (
        <EmptyState title={at > 1 ? "No more stargazers" : "No stars yet"}>
          {at > 1 ? null : "Star it from the button beside Watch, and you show here."}
        </EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {stargazers.map((person) => (
            <li key={person.username} className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3">
              <Avatar name={person.username} image={person.avatar} size={36} />
              <div className="min-w-0">
                <UserCard username={person.username}>
                  <Link to={`/u/${person.username}`} className="block truncate text-sm font-medium hover:text-accent">
                    {person.username}
                  </Link>
                </UserCard>
                <p className="text-xs text-faint">
                  Starred <TimeAgo at={person.starredAt} />
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {(at > 1 || stargazers.length === 100) && (
        <div className="flex justify-center gap-2">
          {at > 1 && (
            <ButtonLink variant="quiet" to={`?page=${at - 1}`}>
              Newer
            </ButtonLink>
          )}
          {stargazers.length === 100 && (
            <ButtonLink variant="quiet" to={`?page=${at + 1}`}>
              Older
            </ButtonLink>
          )}
        </div>
      )}
    </div>
  );
}
