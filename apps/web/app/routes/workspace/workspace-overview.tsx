import { ArrowRight, Bot, Box, ShieldCheck, Users } from "lucide-react";
import { type ReactNode, Suspense } from "react";
import { Await, Link, data } from "react-router";

import { type User, hasCodeAccess } from "@g1t/contracts";

import type { Route } from "./+types/workspace-overview";

import { UsageCard } from "../../components/usage-card";
import { identity } from "../../lib/services.server";
import { loadOnboarding } from "../../lib/onboarding.server";
import { OnboardingOnPage } from "../../components/onboarding";
import { getViewer, roleIn } from "../../lib/session.server";
import { usageFor } from "../../lib/workspace-usage.server";
import { workspaceProjects } from "../../lib/workspace-projects.server";
import { page } from "../../lib/meta";
import { Avatar } from "../../components/ui/avatar";
import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { Skeleton } from "../../components/ui/skeleton";
import { Boundary, Unavailable } from "../../components/boundary";
import { Rhythm } from "../../components/rhythm";
import { PulseSkeleton, PulseStrip } from "../../components/signals";
import { SpendFlow } from "../../components/spend-flow";
import { isFailed, part } from "../../lib/partial";
import { loadRepos } from "../../lib/home.server";
import { dailySignal, dayList, dollars, newGround, newHabits, rhythm, silos, spendFlow, spoken, waitingRows } from "../../lib/signals";
import { type SignalData, loadGroups, loadSignalData } from "../../lib/signals.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Workspace · ${params.owner} · g1t` });
}

/** Most members listed before "and N more". */
const MAX_FACES = 10;
/** Entries each quiet change lists. */
const QUIET_ROWS = 4;

/**
 * The workspace's ground truth, from what its work says (lib/signals.ts),
 * for members who see Code: the past week, the quarter's agent spend
 * threaded to the work it produced, what is moving and what is waiting
 * team by team, and quiet changes in who works where. Streamed, each part
 * on its own. Then the workspace at a glance, for every member: who is in
 * it, its projects, and the month's usage against its plan. Each part is
 * left out when its service does not answer.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const slug = params.owner.toLowerCase();
  const role = roleIn(viewer, slug);
  if (!role) throw data(null, { status: 404 });
  // Getting started, for an owner, as on Home: streamed beside the rest.
  const setupAsked = new URL(request.url).searchParams.has("setup");
  const onboarding = loadOnboarding(viewer, slug, !setupAsked).catch(() => null);
  const membership = viewer?.workspaces?.find((m) => m.slug === slug) ?? null;
  const ground = viewer && hasCodeAccess(membership) ? loadGround(viewer, slug, Date.now()).catch(() => null) : null;
  const [members, usage, projects] = await Promise.all([
    part(identity.listMembers(slug, viewer), "The member list"),
    usageFor(slug, viewer),
    workspaceProjects(slug, viewer).catch(() => null),
  ]);
  return {
    slug,
    role,
    onboarding,
    setupAsked,
    members: isFailed(members) ? members : members.ok ? members.value : null,
    usage,
    projects: projects?.ok ? projects.value.length : null,
    ground,
  };
}

/** Everything the work says, shaped for the page; null when the work service did not answer. */
async function loadGround(viewer: User, slug: string, now: number) {
  const owned = await loadRepos(viewer, slug).catch(() => null);
  if (!owned) return null;
  const [found, groups] = await Promise.all([loadSignalData(viewer, slug, now, owned).catch(() => null), loadGroups(viewer, slug, owned).catch(() => null)]);
  return found ? shapeGround(found, groups, now) : null;
}

function shapeGround(found: SignalData, groups: Awaited<ReturnType<typeof loadGroups>>, now: number) {
  const name = (id: string) => found.repos[id]?.name ?? "a project";
  const path = (id: string) => (found.repos[id] ? `/${found.repos[id]!.namespace}/${found.repos[id]!.name}` : null);
  const quarterSpend = found.quarterUsage ? found.quarterUsage.byPull.reduce((sum, slice) => sum + slice.micros, 0) : null;
  return {
    tiles: dailySignal(found).tiles,
    complete: found.complete,
    capped: found.signals.pullsCapped,
    flow: spendFlow({ slug: found.slug, repos: found.repos, signals: found.signals, quarterUsage: found.quarterUsage, quarter: found.range.quarter }),
    sized: (quarterSpend ?? 0) > 0 ? ("spend" as const) : ("pulls" as const),
    quarterSpend,
    rhythm: groups ? { by: groups.by, rows: rhythm(found.signals.days, dayList(found.range.until, found.range.days), groups.groups) } : null,
    waiting: waitingRows(found.signals.waiting, found.repos).map((pull) => ({ ...pull, age: spoken(Math.max(0, (now - Date.parse(pull.createdAt)) / 1000)) })),
    silos: silos(found.signals.authors, now)
      .slice(0, QUIET_ROWS)
      .map((silo) => ({
        key: silo.repoId,
        to: path(silo.repoId),
        where: name(silo.repoId),
        line: `${silo.name} merged ${silo.theirs} of its ${silo.recent} changes in 90 days`,
        more: silo.joining.length > 0 ? `${silo.joining.map((who) => who.name).join(", ")} started this month` : "No one else has started there",
      })),
    newGround: newGround(found.signals.authors, now)
      .slice(0, QUIET_ROWS)
      .map((row) => ({ key: `${row.ownerId}:${row.repoId}`, to: path(row.repoId), where: name(row.repoId), line: `${row.name} merged a first change here`, more: `${row.elsewhere} merges elsewhere first` })),
    habits: newHabits(found.signals.pulls, now)
      .slice(0, QUIET_ROWS)
      .map((row) => ({ key: row.ownerId, to: path(row.repoId), where: name(row.repoId), line: `${row.name} merged a first agent-made change`, more: `after ${row.byHand} by hand` })),
  };
}

type Ground = ReturnType<typeof shapeGround>;

function Tile({ icon, label, value, to, action }: { icon: ReactNode; label: string; value: string; to: string; action: string }) {
  return (
    <Link to={to} className="group rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong">
      <p className="flex items-center gap-1.5 text-xs text-muted">
        {icon}
        {label}
      </p>
      <p className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      <p className="mt-0.5 flex items-center gap-1 text-xs text-faint group-hover:text-muted">
        {action} <ArrowRight size={11} />
      </p>
    </Link>
  );
}

export default function WorkspaceOverview({ loaderData }: Route.ComponentProps) {
  const { slug, role, members, usage, projects } = loaderData;
  return (
    <div className="space-y-8">
      <OnboardingOnPage slug={slug} view={loaderData.onboarding} asked={loaderData.setupAsked} />
      {loaderData.ground && (
        <Suspense fallback={<GroundSkeleton />}>
          <Await resolve={loaderData.ground}>{(ground) => (ground ? <GroundTruth slug={slug} ground={ground} /> : <Unavailable what="What the work says" />)}</Await>
        </Suspense>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Tile icon={<Users size={12} />} label="Members" value={members && !isFailed(members) ? String(members.length) : "—"} to={role === "owner" ? `/${slug}/-/members` : `/${slug}/-/people`} action={role === "owner" ? "Manage people" : "See everyone"} />
        <Tile icon={<Box size={12} />} label="Projects" value={projects == null ? "—" : String(projects)} to={`/${slug}/-/projects`} action="Open Code" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          {usage ? (
            <UsageCard slug={slug} glance={usage} owner={role === "owner"} />
          ) : (
            <Card asChild className="p-5">
              <section>
                <h2 className="font-medium">Usage</h2>
                <p className="mt-1.5 text-sm text-muted">This month&apos;s usage isn&apos;t available right now.</p>
                <Link to={`/${slug}/-/usage`} className="mt-3 inline-flex items-center gap-1 text-sm text-accent hover:underline">
                  Open Usage <ArrowRight size={13} />
                </Link>
              </section>
            </Card>
          )}
          <Card asChild className="p-5">
            <section>
              <h2 className="flex items-center gap-2 font-medium">
                <ShieldCheck size={15} className="text-faint" />
                Policies
              </h2>
              <p className="mt-1.5 text-sm text-muted">
                How long runs may take, the rules every repository follows, and how the workspace&apos;s security is set up.
              </p>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <Link to={`/${slug}/-/guardrails`} className="text-accent hover:underline">
                  Guardrails
                </Link>
                <Link to={`/${slug}/-/rules`} className="text-accent hover:underline">
                  Rules
                </Link>
                <Link to={`/${slug}/-/security/settings`} className="text-accent hover:underline">
                  Security settings
                </Link>
                <Link to={`/${slug}/-/audit`} className="text-accent hover:underline">
                  Audit log
                </Link>
              </div>
            </section>
          </Card>
        </div>
        <Card asChild className="self-start p-5">
          <section>
            <div className="flex items-center justify-between">
              <h2 className="font-medium">Members</h2>
              <Link to={role === "owner" ? `/${slug}/-/members` : `/${slug}/-/people`} className="text-xs text-muted hover:text-fg">
                {role === "owner" ? "Manage" : "See all"}
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
      </div>
    </div>
  );
}

function GroundSkeleton() {
  return (
    <div className="space-y-6">
      <PulseSkeleton />
      <Skeleton className="h-112 w-full rounded-2xl" />
    </div>
  );
}

/** A part of the ground truth: a mono eyebrow, a sentence for a heading, and what it shows. */
function Section({ id, eyebrow, title, hint, children }: { id: string; eyebrow: string; title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-6 rounded-2xl border border-line bg-surface px-5 py-6 md:px-8 md:py-7">
      <p className="font-mono text-[0.6875rem] tracking-[0.16em] text-accent uppercase">{eyebrow}</p>
      <h2 id={`${id}-title`} className="mt-2 font-display text-2xl leading-tight tracking-tight text-fg">
        {title}
      </h2>
      {hint && <p className="mt-1.5 max-w-3xl text-sm text-muted">{hint}</p>}
      <div className="mt-6">{children}</div>
    </section>
  );
}

type QuietRow = Ground["silos"][number];

function QuietList({ title, hint, rows, empty }: { title: string; hint: string; rows: QuietRow[]; empty: string }) {
  return (
    <div className="min-w-0">
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      <p className="mt-0.5 text-xs text-muted">{hint}</p>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-faint">{empty}</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {rows.map((row) => (
            <li key={row.key} className="text-sm">
              {row.to ? (
                <Link to={row.to} className="font-medium text-fg hover:text-accent">
                  {row.where}
                </Link>
              ) : (
                <span className="font-medium text-fg">{row.where}</span>
              )}
              <p className="text-fg-soft">{row.line}</p>
              <p className="font-mono text-[0.6875rem] text-faint">{row.more}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function GroundTruth({ slug, ground }: { slug: string; ground: Ground }) {
  return (
    <div className="space-y-6">
      <Boundary what="The past week">
        <PulseStrip tiles={ground.tiles} />
      </Boundary>
      {!ground.complete && <p className="text-xs text-faint">Some projects didn&apos;t answer, so what follows leaves them out.</p>}
      <Section
        id="spend"
        eyebrow="Spend, threaded to the work"
        title={ground.quarterSpend ? `${dollars(ground.quarterSpend)} of agent spend this quarter, and what it went into` : "This quarter's work, and how much of it agents did"}
        hint={
          ground.sized === "spend"
            ? "Each milestone, its work items, their change set in each project and its pull requests, sized by what the agents' usage on them came to and shaded by how much was an agent's. Choose a box to open what is under it."
            : "Usage isn't known for this quarter, so each box is sized by its pull requests and shaded by how many were an agent's. Choose a box to open what is under it."
        }
      >
        <Boundary what="Spend, threaded to the work">
          <SpendFlow flow={ground.flow} sized={ground.sized} />
        </Boundary>
        {ground.capped && <p className="mt-3 text-xs text-faint">There were more pull requests this quarter than this reads, so the newest are shown.</p>}
      </Section>
      <Section
        id="rhythm"
        eyebrow="What's moving and what's waiting"
        title={ground.rhythm?.by === "project" ? "Each project's last two weeks" : "Each team's last two weeks"}
        hint="Pull requests and agent sessions above the line; reviews, comments and requests for changes below it. Each row is drawn to its own scale: point at a day for its numbers."
      >
        <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_18rem]">
          <Boundary what="What's moving">{ground.rhythm ? <Rhythm rows={ground.rhythm.rows} by={ground.rhythm.by} /> : <Unavailable what="The teams" />}</Boundary>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-fg">Waiting on a first review</h3>
            <p className="mt-0.5 text-xs text-muted">Open, and no one has reviewed them yet: the oldest first.</p>
            {ground.waiting.length === 0 ? (
              <p className="mt-3 text-sm text-faint">Nothing is waiting for a first review.</p>
            ) : (
              <ul className="mt-3 divide-y divide-line">
                {ground.waiting.map((pull) => (
                  <li key={`${pull.repoId}#${pull.number}`} className="py-2.5 text-sm">
                    <Link to={pull.to} className="flex items-start gap-2 hover:text-accent">
                      <span className="shrink-0 pt-px font-mono text-xs text-muted">#{pull.number}</span>
                      <span className="min-w-0 grow">
                        <span className="line-clamp-2 font-medium text-fg">{pull.title}</span>
                        <span className="font-mono text-[0.6875rem] text-faint">
                          {pull.repo.name} · open {pull.age}
                          {pull.blocks.length > 0 && ` · holds up ${pull.blocks.length}`}
                        </span>
                      </span>
                      {pull.agent && <Bot size={13} className="mt-0.5 shrink-0 text-accent" aria-label="An agent's" />}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <Link to={`/${slug}/-/overview?tab=needs#work`} className="mt-3 inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
              The review queue <ArrowRight size={11} />
            </Link>
          </div>
        </div>
      </Section>
      <Section
        id="quiet"
        eyebrow="Quiet changes"
        title="Who works where, and what is spreading"
        hint="What no roll-up shows: knowledge resting with one person, people moving into new ground, and new ways of working taking hold. Each is a place to look, not a verdict."
      >
        <div className="grid gap-8 md:grid-cols-3">
          <QuietList title="Knowledge silos" hint="Projects where one person has done most of the last 90 days' work" rows={ground.silos} empty="No project rests on one person right now." />
          <QuietList title="New ground" hint="People who merged to a project for the first time in the last two weeks" rows={ground.newGround} empty="No one has moved into a new project in the last two weeks." />
          <QuietList title="New habits" hint="People whose first agent-made change merged in the last two weeks" rows={ground.habits} empty="No one new started merging agents' work in the last two weeks." />
        </div>
      </Section>
    </div>
  );
}
