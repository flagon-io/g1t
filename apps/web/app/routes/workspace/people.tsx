import { Bot, Network, Search, UserPlus } from "lucide-react";
import { Link, data, useSearchParams, type ShouldRevalidateFunctionArgs } from "react-router";

import type { Route } from "./+types/people";
import { LocalTime, PersonFace } from "../../components/people";
import { ButtonLink, notACredential } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { page } from "../../lib/meta";
import { type DirectoryEntry, directoryEntries, personName, personPath } from "../../lib/people";
import { identity } from "../../lib/services.server";
import { getViewer, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `People · ${params.owner} · g1t` });
}

/**
 * The workspace's people. Its agents are not here: they are listed under
 * Agents, and a team's page lists the agents on it with its people.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Who is in a workspace is its members' business.
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const directory = await identity.peopleDirectory(viewer, params.owner).then(unwrap);
  return { slug: params.owner.toLowerCase(), directory };
}

/** Searching changes only the address: everyone is already here. */
export function shouldRevalidate({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (!formMethod && currentUrl.pathname === nextUrl.pathname) return false;
  return defaultShouldRevalidate;
}

export default function PeopleDirectoryPage({ loaderData }: Route.ComponentProps) {
  const { slug, directory } = loaderData;
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const entries = directoryEntries(directory, query);
  const total = directory.people.length;
  const change = (key: string, value: string) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true, preventScrollReset: true },
    );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <label className="relative block grow">
          <span className="sr-only">Search people</span>
          <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
          <input
            type="search"
            value={query}
            onChange={(event) => change("q", event.target.value)}
            placeholder="Name, title, team or what they own"
            {...notACredential()}
            className="w-full rounded-lg border border-line bg-bg py-2 pr-3 pl-9 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <span role="status" className="mr-1 text-sm text-muted tabular-nums">
            {query ? `${entries.length} of ${total}` : total} {total === 1 && !query ? "person" : "people"}
          </span>
          <ButtonLink to={`/${slug}/-/org-chart`} variant="outline">
            <Network size={15} />
            Org chart
          </ButtonLink>
          {directory.can_manage && (
            <ButtonLink to={`/${slug}/-/members`}>
              <UserPlus size={15} />
              Invite people
            </ButtonLink>
          )}
        </div>
      </div>

      {entries.length === 0 ? (
        <Card asChild tone="plain" className="border-dashed px-4 py-10 text-center text-sm text-muted">
          <p>
            {query ? (
              <>
                Nobody matches “{query}”. Try a team, like “sales”, or a job, like “refunds”.{" "}
                <Button type="button" variant="link" size="inline" onClick={() => change("q", "")}>
                  Show everyone
                </Button>
              </>
            ) : (
              "No one here yet."
            )}
          </p>
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {entries.map((entry) => (
            <li key={entry.person.username}>
              <PersonCard slug={slug} entry={entry} />
            </li>
          ))}
        </ul>
      )}

      <p className="flex items-start gap-2 text-xs text-faint">
        <Bot size={14} className="mt-px shrink-0" />
        <span>
          Agents aren&apos;t listed here. The workspace&apos;s agents are under{" "}
          <Link to={`/${slug}/-/agents`} className="text-muted hover:text-fg">
            Agents
          </Link>
          , and a <Link to={`/${slug}/-/teams`} className="text-muted hover:text-fg">team</Link> lists the agents on it with its people.
        </span>
      </p>
    </div>
  );
}

/** One person: who they are, their title, their teams and their local time. */
function PersonCard({ slug, entry }: { slug: string; entry: DirectoryEntry }) {
  const { person } = entry;
  const teams = entry.teams.map((team) => team.name);
  return (
    <Link
      to={personPath(slug, person.username)}
      prefetch="intent"
      className="flex h-full items-start gap-3 rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong"
    >
      <PersonFace person={person} size={44} ring="var(--color-surface)" />
      <span className="min-w-0 grow">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-medium">{personName(person)}</span>
          {person.role === "owner" && <Badge>Owner</Badge>}
        </span>
        <span className="block truncate text-sm text-muted">{person.title ?? `@${person.display_username ?? person.username}`}</span>
        <span className="mt-1.5 block truncate text-xs text-faint">
          {teams.length ? teams.join(", ") : "No team"}
          <LocalTime zone={person.timezone} className="before:mx-1.5 before:content-['·']" />
        </span>
        {person.owns.length > 0 && <span className="mt-1 block truncate text-xs text-fg-soft">Owns {person.owns.join(", ")}</span>}
      </span>
    </Link>
  );
}
