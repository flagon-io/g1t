/**
 * A person's profile at `/u/<username>`, apart from workspaces at
 * `/<workspace>` (as Docker Hub keeps people under `/u/`).
 *
 * The left column is who they are; the main column is their work, as
 * tabs: an overview (their contribution calendar first), then their pull
 * requests and issues with a filter aside. Everything is filtered on the server by `work.byAuthor`, which
 * only ever returns work on repositories the viewer may read, and the
 * workspaces shown are only those the viewer could know about anyway (see
 * `profile_workspaces` in services/identity/src/profiles.rs).
 */
import {
  CalendarDays,
  CircleDot,
  GitMerge,
  GitPullRequest,
  LayoutGrid,
  Link2,
  MapPin,
  Pencil,
  Star,
} from "lucide-react";
import type { ReactNode } from "react";
import { Form, Link, redirect, useNavigate, useSearchParams } from "react-router";

import { type Authored, type AuthoredItem, type AuthoredSort, type AuthoredState, type Contributions, type Profile, type StarredRepo, shownUsername } from "@g1t/contracts";

import type { Route } from "./+types/user";
import { page } from "../lib/meta";
import { ContributionCalendar } from "../components/contribution-calendar";
import { ButtonLink, EmptyState, TimeAgo } from "../components/ui";
import { Avatar } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { RadioGroup, RadioOption } from "../components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { IssueIcon, PullIcon } from "../components/work-icons";
import { lastDay } from "../lib/contribution-calendar";
import { notFound } from "../lib/not-found.server";
import { identity, repos, work } from "../lib/services.server";
import { getViewer } from "../lib/session.server";

type Tab = "overview" | "pulls" | "issues" | "stars";

const EMPTY: Authored = {
  items: [],
  next: null,
  counts: { pullsMerged: 0, pullsOpen: 0, pulls: 0, issues: 0, issuesOpen: 0 },
  repos: [],
};

/** How many recent items the overview shows. */
const RECENT = 8;

function displayName(profile: Profile): string {
  const handle = shownUsername(profile);
  return profile.name ? `${profile.name} (@${handle})` : handle;
}

export function meta({ loaderData, params, ...args }: Route.MetaArgs) {
  const profile = loaderData?.profile;
  if (!profile) return page(args, { title: `${params.username} · g1t` });
  return page(args, {
    title: `${displayName(profile)} · g1t`,
    description: profile.bio || `${profile.name ?? shownUsername(profile)} (@${shownUsername(profile)}) on g1t: their pull requests, issues and workspaces.`,
    // What the card shows, so it is drawn again when any of it changes.
    version: [profile.name, profile.bio, profile.avatar, loaderData.publicCounts],
  });
}

function pick<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  return allowed.find((option) => option === value);
}

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const url = new URL(request.url);
  const username = params.username.toLowerCase();
  const profile = await identity.profile(username);
  if (!profile) throw notFound("person");
  // One address per person: `/u/Ada` is `/u/ada`.
  if (params.username !== profile.username) {
    throw redirect(`/u/${profile.username}${url.search}`);
  }

  const query = url.searchParams;
  const tab: Tab = pick(query.get("tab"), ["pulls", "issues", "stars"] as const) ?? "overview";
  const state = pick(query.get("state"), (tab === "pulls" ? ["open", "closed", "merged"] : ["open", "closed"]) as AuthoredState[]);
  const sort = pick(query.get("sort"), ["updated", "oldest"] as const satisfies AuthoredSort[]);
  const repo = query.get("repo")?.trim() || undefined;
  const before = query.get("before") || undefined;
  const filter =
    tab === "overview"
      ? { limit: RECENT }
      : { kind: tab === "pulls" ? ("pull" as const) : ("issue" as const), state, repo, sort, before };

  // Only real memberships, and only those the viewer could see anyway.
  const workspaces = identity
    .userByUsername(username)
    .then((person) => (person ? repos.publicNamespaces(person.id) : []))
    .catch(() => [] as string[])
    .then((publicIn) => identity.profileWorkspaces(username, viewer, publicIn));
  // The card is drawn for no one in particular, so its version uses what
  // everyone sees; for a signed-out viewer that is these counts already.
  const [authored, shown, starred, year] = await Promise.all([
    work.byAuthor(username, viewer, filter),
    workspaces,
    // What they starred that the viewer can see, on its own tab.
    tab === "stars" ? repos.starred(username, viewer).catch(() => [] as StarredRepo[]) : ([] as StarredRepo[]),
    // Their year, on the overview: counted only where the viewer can see.
    tab === "overview"
      ? work
          .contributions(username, viewer)
          .then((result) => (result.ok ? result.value : null))
          .catch(() => null as Contributions | null)
      : null,
  ]);
  const activity = authored.ok ? authored.value : EMPTY;
  // The calendar ends today, as the work service counted it (UTC).
  const today = (year && lastDay(year.from)) || new Date().toISOString().slice(0, 10);
  return {
    profile,
    tab,
    filter: { state: state ?? null, repo: repo ?? null, sort: sort ?? "created", before: before ?? null },
    activity,
    failed: !authored.ok,
    workspaces: shown,
    starred,
    contributions: year ? { ...year, today } : null,
    isSelf: viewer?.username === profile.username,
    publicCounts: viewer ? null : activity.counts,
  };
}

export default function UserProfile({ loaderData }: Route.ComponentProps) {
  const { profile, tab, activity, workspaces, isSelf } = loaderData;
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-8 md:py-10">
      <div className="grid gap-8 md:grid-cols-[minmax(0,240px)_minmax(0,1fr)] lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)] lg:gap-12">
        <PersonColumn profile={profile} workspaces={workspaces} isSelf={isSelf} />
        <section className="min-w-0">
          <ProfileTabs username={profile.username} tab={tab} counts={activity.counts} />
          <div className="mt-6">
            {tab === "overview" ? (
              <Overview {...loaderData} />
            ) : tab === "stars" ? (
              <StarredList starred={loaderData.starred} isSelf={isSelf} />
            ) : (
              <WorkList {...loaderData} />
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

// --- Who they are -------------------------------------------------------------

function joined(at: string): string {
  // In UTC, so the server and the browser agree.
  return new Date(at).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

function PersonColumn({
  profile,
  workspaces,
  isSelf,
}: {
  profile: Profile;
  workspaces: { slug: string; name: string; avatar: string | null }[];
  isSelf: boolean;
}) {
  return (
    <aside className="min-w-0">
      <div className="flex items-center gap-4 md:block">
        <span className="md:hidden">
          <Avatar name={profile.username} image={profile.avatar} size={80} />
        </span>
        <span className="hidden md:block">
          <span className="block w-fit rounded-full ring-1 ring-line">
            <Avatar name={profile.username} image={profile.avatar} size={240} />
          </span>
        </span>
        <div className="min-w-0 md:mt-5">
          {profile.name ? (
            <>
              <h1 className="text-2xl leading-tight font-semibold tracking-tight wrap-anywhere">
                {profile.name}
              </h1>
              <p className="mt-0.5 font-mono text-base text-muted">@{shownUsername(profile)}</p>
            </>
          ) : (
            <h1 className="font-mono text-2xl leading-tight font-semibold tracking-tight wrap-anywhere">
              {shownUsername(profile)}
            </h1>
          )}
          {profile.pronouns && <p className="mt-1 text-sm text-faint">{profile.pronouns}</p>}
        </div>
      </div>

      {profile.bio && <p className="mt-4 text-[0.9375rem] leading-relaxed text-fg/90">{profile.bio}</p>}

      {isSelf && (
        <div className="mt-4">
          <ButtonLink to="/settings/profile" variant="outline">
            <Pencil size={14} />
            Edit profile
          </ButtonLink>
        </div>
      )}

      <ul className="mt-4 space-y-1.5 text-sm text-muted">
        {profile.location && (
          <Detail icon={<MapPin size={15} />}>
            <span className="wrap-anywhere">{profile.location}</span>
          </Detail>
        )}
        {profile.website && (
          <Detail icon={<Link2 size={15} />}>
            <a
              href={profile.website}
              rel="nofollow ugc noopener noreferrer me"
              target="_blank"
              className="text-fg wrap-anywhere hover:underline"
            >
              {profile.website.replace(/^https:\/\//, "").replace(/\/$/, "")}
            </a>
          </Detail>
        )}
        <Detail icon={<CalendarDays size={15} />}>Joined {joined(profile.createdAt)}</Detail>
      </ul>

      {workspaces.length > 0 && (
        <div className="mt-6 border-t border-line pt-5">
          <h2 className="text-sm font-medium">Workspaces</h2>
          <ul className="mt-3 space-y-1">
            {workspaces.map((workspace) => (
              <li key={workspace.slug}>
                <Link
                  to={`/${workspace.slug}`}
                  className="-mx-2 flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-surface"
                >
                  <Avatar name={workspace.slug} image={workspace.avatar} size={22} square />
                  <span className="min-w-0 truncate">{workspace.name}</span>
                  {workspace.name !== workspace.slug && (
                    <span className="ml-auto shrink-0 truncate font-mono text-xs text-faint">{workspace.slug}</span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}

function Detail({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0 text-faint">{icon}</span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

// --- Tabs ------------------------------------------------------------------------

function ProfileTabs({
  username,
  tab,
  counts,
}: {
  username: string;
  tab: Tab;
  counts: Authored["counts"];
}) {
  const item = (value: Tab, label: string, icon: ReactNode, count?: number) => (
    <Link
      to={value === "overview" ? `/u/${username}` : `/u/${username}?tab=${value}`}
      aria-current={tab === value ? "page" : undefined}
      preventScrollReset
      className={`-mb-px flex items-center gap-2 border-b-2 px-3 pb-3 text-sm whitespace-nowrap transition-colors ${
        tab === value ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg"
      }`}
    >
      {icon}
      {label}
      {count != null && count > 0 && (
        <span className="rounded-full bg-raised px-1.5 py-px text-xs text-muted">{count}</span>
      )}
    </Link>
  );
  return (
    <nav aria-label="Profile" className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {item("overview", "Overview", <LayoutGrid size={15} />)}
      {item("pulls", "Pull requests", <GitPullRequest size={15} />, counts.pulls)}
      {item("issues", "Issues", <CircleDot size={15} />, counts.issues)}
      {item("stars", "Stars", <Star size={15} />)}
    </nav>
  );
}

// --- Stars -------------------------------------------------------------------------

function StarredList({ starred, isSelf }: { starred: StarredRepo[]; isSelf: boolean }) {
  if (starred.length === 0) {
    return (
      <EmptyState title={isSelf ? "You have not starred anything yet" : "No stars yet"}>
        {isSelf ? "Star a repository from the button beside Watch to keep it here." : null}
      </EmptyState>
    );
  }
  return (
    <Card asChild divided className="overflow-hidden">
      <ul>
        {starred.map(({ repo, starredAt, stars }) => (
          <li key={repo.id} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Link to={`/${repo.namespace}/${repo.name}`} className="min-w-0 truncate font-medium hover:text-accent">
                <span className="text-muted">{repo.namespace}/</span>
                {repo.name}
              </Link>
              <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted tabular-nums">
                <Star size={13} className="text-faint" />
                {stars.toLocaleString("en-US")}
              </span>
            </div>
            {repo.description && <p className="mt-1 text-sm text-muted">{repo.description}</p>}
            <p className="mt-1 text-xs text-faint">
              Starred <TimeAgo at={starredAt} />
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// --- Overview ----------------------------------------------------------------------

type Data = Route.ComponentProps["loaderData"];

function Overview({ profile, activity, failed, contributions }: Data) {
  const { counts, items } = activity;
  const who = profile.name ?? shownUsername(profile);
  return (
    <div className="space-y-8">
      {contributions && (
        <ContributionCalendar
          days={contributions.days}
          total={contributions.total}
          today={contributions.today}
          from={contributions.from}
        />
      )}
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat
          label="Pull requests merged"
          value={counts.pullsMerged}
          icon={<GitMerge size={15} className="text-merged" />}
          to={`/u/${profile.username}?tab=pulls&state=merged`}
        />
        <Stat
          label="Open pull requests"
          value={counts.pullsOpen}
          icon={<GitPullRequest size={15} className="text-success" />}
          to={`/u/${profile.username}?tab=pulls&state=open`}
        />
        <Stat
          label="Issues opened"
          value={counts.issues}
          icon={<CircleDot size={15} className="text-success" />}
          to={`/u/${profile.username}?tab=issues`}
        />
      </dl>

      <section>
        <h2 className="text-sm font-medium">Recent activity</h2>
        <div className="mt-3">
          {failed ? (
            <EmptyState title="Activity could not be loaded">Try again in a moment.</EmptyState>
          ) : items.length === 0 ? (
            <EmptyState title={`No activity from ${who} yet`}>
              Pull requests and issues @{profile.username} opens on repositories you can see show up here.
            </EmptyState>
          ) : (
            <>
              <ItemList items={items} />
              {(counts.pulls > 0 || counts.issues > 0) && (
                <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  {counts.pulls > 0 && (
                    <Link to={`/u/${profile.username}?tab=pulls`} className="text-muted hover:text-fg">
                      All {counts.pulls} pull {counts.pulls === 1 ? "request" : "requests"} →
                    </Link>
                  )}
                  {counts.issues > 0 && (
                    <Link to={`/u/${profile.username}?tab=issues`} className="text-muted hover:text-fg">
                      All {counts.issues} {counts.issues === 1 ? "issue" : "issues"} →
                    </Link>
                  )}
                </p>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, icon, to }: { label: string; value: number; icon: ReactNode; to: string }) {
  return (
    <Link
      to={to}
      className="block rounded-xl border border-line bg-surface/50 px-4 py-3.5 transition-colors hover:border-line-strong hover:bg-surface"
    >
      <dt className="flex items-center gap-2 text-xs text-muted">
        {icon}
        {label}
      </dt>
      <dd className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight">{value.toLocaleString("en-US")}</dd>
    </Link>
  );
}

// --- Lists ---------------------------------------------------------------------------

function itemUrl(item: AuthoredItem): string {
  const base = `/${item.repo.namespace}/${item.repo.name}`;
  return item.kind === "pull" ? `${base}/pull/${item.number}` : `${base}/issues/${item.number}`;
}

function ItemList({ items }: { items: AuthoredItem[] }) {
  return (
    <Card asChild tone="plain" divided className="overflow-hidden">
      <ul>
        {items.map((item) => (
          <li key={`${item.kind}:${item.repo.namespace}/${item.repo.name}#${item.number}`}>
            <Link
              prefetch="intent"
              to={itemUrl(item)}
              className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface"
            >
              <span className="mt-0.5">
                {item.kind === "pull" ? (
                  <PullIcon status={item.status ?? (item.state === "open" ? "open" : "closed")} />
                ) : (
                  <IssueIcon issue={{ state: item.state, reason: item.reason }} />
                )}
              </span>
              <span className="min-w-0 grow">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium">{item.title}</span>
                  {item.draft && (
                    <Badge className="px-1.5 font-normal text-faint">
                      draft
                    </Badge>
                  )}
                </span>
                <span className="mt-0.5 block truncate text-xs text-faint">
                  <span className="font-mono text-muted">
                    {item.repo.namespace}/{item.repo.name}
                  </span>{" "}
                  #{item.number} · opened <TimeAgo at={item.createdAt} />
                  {item.merged && item.mergedAt ? (
                    <>
                      {" "}
                      · merged <TimeAgo at={item.mergedAt} />
                    </>
                  ) : item.updatedAt !== item.createdAt ? (
                    <>
                      {" "}
                      · updated <TimeAgo at={item.updatedAt} />
                    </>
                  ) : null}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const SORTS: { value: AuthoredSort; label: string }[] = [
  { value: "created", label: "Newest" },
  { value: "updated", label: "Recently updated" },
  { value: "oldest", label: "Oldest" },
];

function WorkList({ profile, tab, filter, activity, failed }: Data) {
  const pulls = tab === "pulls";
  const noun = pulls ? "pull requests" : "issues";
  const filtered = filter.state != null || filter.repo != null;
  const base = `/u/${profile.username}?tab=${tab}`;
  const [params] = useSearchParams();
  const next = new URLSearchParams(params);
  if (activity.next) next.set("before", activity.next);
  const first = new URLSearchParams(params);
  first.delete("before");
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_220px]">
      <div className="min-w-0 lg:order-1">
        {failed ? (
          <EmptyState title={`${pulls ? "Pull requests" : "Issues"} could not be loaded`}>
            Try again in a moment.
          </EmptyState>
        ) : activity.items.length === 0 ? (
          filtered || filter.before ? (
            <EmptyState title={`No ${noun} match these filters`}>
              <Link to={base} className="text-fg underline underline-offset-4">
                Clear filters
              </Link>{" "}
              to see all of them.
            </EmptyState>
          ) : (
            <EmptyState title={`No ${noun} yet`}>
              {pulls
                ? `Pull requests @${profile.username} opens on repositories you can see show up here.`
                : `Issues @${profile.username} opens on repositories you can see show up here.`}
            </EmptyState>
          )
        ) : (
          <>
            <ItemList items={activity.items} />
            {(activity.next || filter.before) && (
              <nav aria-label="Pages" className="mt-4 flex items-center justify-between gap-3">
                {filter.before ? (
                  <ButtonLink to={`?${first}`} variant="outline" preventScrollReset>
                    ← {filter.sort === "oldest" ? "Oldest" : "Newest"}
                  </ButtonLink>
                ) : (
                  <span />
                )}
                {activity.next && (
                  <ButtonLink to={`?${next}`} variant="outline" preventScrollReset>
                    Next page →
                  </ButtonLink>
                )}
              </nav>
            )}
          </>
        )}
      </div>
      <FilterAside tab={tab} filter={filter} activity={activity} username={profile.username} />
    </div>
  );
}

/**
 * The filters beside a list, as on GitHub's search: each change reloads
 * the list from the server, from the first page. Without script, the
 * form's Apply button does the same.
 */
function FilterAside({
  tab,
  filter,
  activity,
  username,
}: {
  tab: Tab;
  filter: Data["filter"];
  activity: Authored;
  username: string;
}) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(key);
    else next.set(key, value);
    next.delete("before");
    void navigate(`?${next}`, { preventScrollReset: true });
  };
  const pulls = tab === "pulls";
  const { counts } = activity;
  const states: { value: string; label: string; count?: number }[] = pulls
    ? [
        { value: "all", label: "All", count: counts.pulls },
        { value: "open", label: "Open", count: counts.pullsOpen },
        { value: "merged", label: "Merged", count: counts.pullsMerged },
        { value: "closed", label: "Closed" },
      ]
    : [
        { value: "all", label: "All", count: counts.issues },
        { value: "open", label: "Open", count: counts.issuesOpen },
        { value: "closed", label: "Closed", count: counts.issues - counts.issuesOpen },
      ];
  const filtered = filter.state != null || filter.repo != null || filter.sort !== "created";
  return (
    <aside aria-label="Filters" className="min-w-0 lg:order-2">
      <Card asChild tone="plain" className="space-y-5 p-4 lg:sticky lg:top-20">
        <Form method="get">
          <input type="hidden" name="tab" value={tab} />
          <FilterGroup title="Type">
            <RadioGroup
              value={tab}
              onValueChange={(value) => void navigate(`/u/${username}?tab=${value}`, { preventScrollReset: true })}
              aria-label="Type"
            >
              <RadioOption value="pulls" label={<Counted label="Pull requests" count={counts.pulls} />} />
              <RadioOption value="issues" label={<Counted label="Issues" count={counts.issues} />} />
            </RadioGroup>
          </FilterGroup>
          <FilterGroup title="State">
            <RadioGroup
              name="state"
              value={filter.state ?? "all"}
              onValueChange={(value) => set("state", value === "all" ? null : value)}
              aria-label="State"
            >
              {states.map((state) => (
                <RadioOption
                  key={state.value}
                  value={state.value}
                  label={<Counted label={state.label} count={state.count} />}
                />
              ))}
            </RadioGroup>
          </FilterGroup>
          <FilterGroup title="Repository">
            <Select
              name="repo"
              value={filter.repo ?? "all"}
              onValueChange={(value) => set("repo", value === "all" ? null : value)}
            >
              <SelectTrigger size="sm" aria-label="Repository">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All repositories</SelectItem>
                {activity.repos.map(({ repo, count }) => {
                  const path = `${repo.namespace}/${repo.name}`;
                  return (
                    <SelectItem key={path} value={path} description={`${count} by @${username}`}>
                      {path}
                    </SelectItem>
                  );
                })}
                {filter.repo && !activity.repos.some(({ repo }) => `${repo.namespace}/${repo.name}` === filter.repo) && (
                  <SelectItem value={filter.repo}>{filter.repo}</SelectItem>
                )}
              </SelectContent>
            </Select>
          </FilterGroup>
          <FilterGroup title="Sort">
            <Select name="sort" value={filter.sort} onValueChange={(value) => set("sort", value === "created" ? null : value)}>
              <SelectTrigger size="sm" aria-label="Sort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORTS.map((sort) => (
                  <SelectItem key={sort.value} value={sort.value}>
                    {sort.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterGroup>
          <div className="flex items-center justify-between gap-2">
            <noscript>
              <Button type="submit" variant="outline">
                Apply
              </Button>
            </noscript>
            {filtered && (
              <Link to={`/u/${username}?tab=${tab}`} preventScrollReset className="text-xs text-muted hover:text-fg">
                Clear filters
              </Link>
            )}
          </div>
        </Form>
      </Card>
    </aside>
  );
}

function FilterGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-[0.6875rem] font-medium tracking-wide text-faint uppercase">{title}</legend>
      {children}
    </fieldset>
  );
}

function Counted({ label, count }: { label: string; count?: number }) {
  return (
    <>
      {label}
      {count != null && <span className="text-xs text-faint tabular-nums">{count}</span>}
    </>
  );
}
