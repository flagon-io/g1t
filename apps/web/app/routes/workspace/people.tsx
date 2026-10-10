import { Network, Search, UserPlus } from "lucide-react";
import { Link, data, useSearchParams, type ShouldRevalidateFunctionArgs } from "react-router";

import type { Route } from "./+types/people";
import { AgentPersonFace, AgentTag, LocalTime, PersonFace } from "../../components/people";
import { ButtonLink, notACredential } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { page } from "../../lib/meta";
import { type DirectoryEntry, type DirectoryKind, agentPath, directoryEntries, directoryKind, peopleAgent, personName, personPath } from "../../lib/people";
import { identity, workspaceAgents } from "../../lib/services.server";
import { getViewer, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `People · ${params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Who is in a workspace is its members' business.
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const [directory, agents] = await Promise.all([
    identity.peopleDirectory(viewer, params.owner).then(unwrap),
    workspaceAgents.list(params.owner, viewer!).catch(() => null),
  ]);
  return {
    slug: params.owner.toLowerCase(),
    directory,
    agents: agents?.ok ? agents.value.map(peopleAgent) : [],
  };
}

/** Searching changes only the address: everyone is already here. */
export function shouldRevalidate({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (!formMethod && currentUrl.pathname === nextUrl.pathname) return false;
  return defaultShouldRevalidate;
}

const KINDS: { value: DirectoryKind; label: string }[] = [
  { value: "everyone", label: "Everyone" },
  { value: "people", label: "People" },
  { value: "agents", label: "Agents" },
];

export default function PeopleDirectoryPage({ loaderData }: Route.ComponentProps) {
  const { slug, directory, agents } = loaderData;
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const kind = directoryKind(params.get("kind"));
  const entries = directoryEntries(directory, agents, query, kind);
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
  const counts = { everyone: directory.people.length + agents.length, people: directory.people.length, agents: agents.length };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <label className="relative block grow">
          <span className="sr-only">Search people and agents</span>
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
          <Card role="group" aria-label="Show" tone="bg" radius="lg" className="inline-flex p-0.5">
            {KINDS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={kind === option.value}
                onClick={() => change("kind", option.value === "everyone" ? "" : option.value)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  kind === option.value ? "bg-raised text-fg" : "text-muted hover:text-fg"
                }`}
              >
                {option.label} <span className="text-faint tabular-nums">{counts[option.value]}</span>
              </button>
            ))}
          </Card>
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
            <li key={entry.kind === "person" ? `p:${entry.person.username}` : `a:${entry.agent.id}`}>
              <EntryCard slug={slug} entry={entry} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One person or agent: who they are, their title, their teams and, for a person, their local time. */
function EntryCard({ slug, entry }: { slug: string; entry: DirectoryEntry }) {
  const teams = entry.teams.map((team) => team.name);
  if (entry.kind === "person") {
    const { person } = entry;
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
  const { agent } = entry;
  return (
    <Link
      to={agentPath(slug, agent.handle)}
      prefetch="intent"
      className="flex h-full items-start gap-3 rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong"
    >
      <AgentPersonFace agent={agent} size={44} ring="var(--color-surface)" />
      <span className="min-w-0 grow">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-medium">{agent.display_name}</span>
          <AgentTag />
        </span>
        <span className="block truncate text-sm text-muted">{agent.title || agent.role}</span>
        <span className="mt-1.5 block truncate text-xs text-faint">{teams.length ? teams.join(", ") : "No team"}</span>
        {agent.responsibilities.length > 0 && <span className="mt-1 block truncate text-xs text-fg-soft">{agent.responsibilities.slice(0, 2).join(" · ")}</span>}
      </span>
    </Link>
  );
}
