import { ArrowRight, KeyRound } from "lucide-react";
import { Link } from "react-router";

import type { Route } from "./+types/overview";
import { RepoList } from "../../components/repo-list";
import { Avatar, ButtonLink, CopyLine, Pill, TimeAgo } from "../../components/ui";
import { PullIcon } from "../../components/work";
import { identity, repos as reposApi, work } from "../../lib/services.server";
import { getViewer, roleIn } from "../../lib/session.server";

/** Repositories whose open issues and pull requests are counted. */
const MAX_COUNTED = 30;
/** Repositories whose pull requests are listed under "In progress". */
const MAX_LISTED = 8;
const MAX_PULLS = 8;
const MAX_FACES = 8;

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const slug = params.owner.toLowerCase();
  const role = roleIn(viewer, slug);
  const [repos, members] = await Promise.all([
    reposApi.list(viewer, { namespace: slug }),
    role ? identity.listMembers(slug, viewer) : null,
  ]);

  const counted = repos.slice(0, MAX_COUNTED);
  const counts = await Promise.all(
    counted.map((repo) => work.counts({ namespace: repo.namespace, name: repo.name }, viewer)),
  );
  const open: Record<string, { issues: number; pulls: number }> = {};
  counted.forEach((repo, i) => {
    const result = counts[i];
    if (result.ok) open[repo.id] = result.value;
  });

  const busy = counted.filter((repo) => (open[repo.id]?.pulls ?? 0) > 0).slice(0, MAX_LISTED);
  const lists = await Promise.all(
    busy.map((repo) =>
      work.listPulls({ namespace: repo.namespace, name: repo.name }, viewer, "open"),
    ),
  );
  const pulls = lists
    .flatMap((result, i) =>
      result.ok ? result.value.map((pull) => ({ pull, repo: busy[i].name })) : [],
    )
    .sort((a, b) => b.pull.updatedAt.localeCompare(a.pull.updatedAt))
    .slice(0, MAX_PULLS);

  return { slug, role, repos, open, pulls, members: members?.ok ? members.value : null };
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3">
      <p className="text-xl font-semibold tabular-nums tracking-tight">{value}</p>
      <p className="text-xs text-muted">{label}</p>
    </div>
  );
}

/** What a member sees in a workspace that has no repositories yet. */
function GetStarted({ slug }: { slug: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-6">
      <h2 className="font-medium">Add the first repository</h2>
      <p className="mt-1.5 max-w-xl text-sm text-muted">
        A repository holds code, the issues that say what should change, and
        the pull requests agents and people make for them.
      </p>
      <div className="mt-5 flex flex-wrap gap-3">
        <ButtonLink to={`/new?workspace=${slug}`}>Create or import a repository</ButtonLink>
      </div>
      <p className="mt-6 text-sm text-muted">Or push one you already have:</p>
      <div className="mt-2 max-w-xl">
        <CopyLine prompt text={`git push https://g1t.sh/${slug}/my-project.git main`} />
      </div>
    </div>
  );
}

export default function WorkspaceOverview({ loaderData }: Route.ComponentProps) {
  const { slug, role, repos, open, pulls, members } = loaderData;
  const totals = Object.values(open).reduce(
    (sum, counts) => ({
      issues: sum.issues + counts.issues,
      pulls: sum.pulls + counts.pulls,
    }),
    { issues: 0, pulls: 0 },
  );
  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_18rem]">
      <div className="min-w-0 space-y-10">
        {repos.length === 0 && role ? (
          <GetStarted slug={slug} />
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3">
              <Stat
                value={repos.length}
                label={repos.length === 1 ? "Repository" : "Repositories"}
              />
              <Stat value={totals.issues} label="Open issues" />
              <Stat value={totals.pulls} label="Pull requests in progress" />
            </div>

            {pulls.length > 0 && (
              <section>
                <h2 className="text-sm font-medium text-muted">In progress</h2>
                <ul className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
                  {pulls.map(({ pull, repo }) => (
                    <li key={pull.id}>
                      <Link
                        prefetch="intent"
                        to={`/${slug}/${repo}/pull/${pull.number}`}
                        className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-raised"
                      >
                        <PullIcon status={pull.status} />
                        <span className="min-w-0 grow">
                          <span className="block truncate font-medium">{pull.title}</span>
                          <span className="font-mono text-xs text-muted">
                            {repo}#{pull.number}
                            {pull.issue != null && ` · for #${pull.issue}`} ·{" "}
                            {pull.author.username}
                          </span>
                        </span>
                        <span className="hidden shrink-0 text-xs text-muted sm:block">
                          {pull.status === "draft" ? "Being worked on" : "Ready for review"}
                        </span>
                        <span className="w-14 shrink-0 text-right text-xs text-faint">
                          <TimeAgo at={pull.updatedAt} />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section>
              <h2 className="text-sm font-medium text-muted">Repositories</h2>
              <RepoList repos={repos} open={open} />
            </section>
          </>
        )}
      </div>

      <aside className="space-y-6">
        {members ? (
          <section>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">People</h2>
              <Link to={`/${slug}/-/people`} className="text-xs text-muted hover:text-fg">
                {role === "owner" ? "Manage" : "See all"}
              </Link>
            </div>
            <ul className="mt-3 space-y-1.5">
              {members.slice(0, MAX_FACES).map((member) => (
                <li key={member.username} className="flex items-center gap-2 text-sm">
                  <Avatar name={member.username} />
                  <span className="grow truncate font-mono">{member.username}</span>
                  {member.role === "owner" && <Pill>owner</Pill>}
                </li>
              ))}
            </ul>
            {members.length > MAX_FACES && (
              <p className="mt-2 text-xs text-faint">
                and {members.length - MAX_FACES} more
              </p>
            )}
          </section>
        ) : (
          <p className="text-sm text-muted">
            Members of this workspace create repositories here and merge pull
            requests into them. Anyone can open an issue or a pull request on
            a public repository.
          </p>
        )}

        {role && (
          <section className="rounded-xl border border-line bg-surface p-5">
            <h2 className="flex items-center gap-2 font-medium">
              <KeyRound size={15} className="text-faint" />
              Automate without a service account
            </h2>
            <p className="mt-1.5 text-sm text-muted">
              A workspace has access tokens of its own for CI, integrations
              and agents. They act as the workspace, not as a person.
            </p>
            <Link
              prefetch="intent"
              to={`/${slug}/-/tokens`}
              className="mt-3 inline-flex items-center gap-1 text-sm text-accent hover:underline"
            >
              Access tokens <ArrowRight size={13} />
            </Link>
          </section>
        )}
      </aside>
    </div>
  );
}
