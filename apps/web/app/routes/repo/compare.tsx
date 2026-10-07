import { ArrowLeft, GitCommitHorizontal, GitPullRequest } from "lucide-react";
import { Form, Link } from "react-router";

import type { Comparison } from "@g1t/contracts";

import type { Route } from "./+types/compare";
import { DiffView } from "../../components/diff-view";
import { Avatar, ButtonLink, EmptyState, TimeAgo } from "../../components/ui";
import { page } from "../../lib/meta";
import { repos } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";

/** How far back each side's history is read to find what head has that base does not. */
const HEAD_DEPTH = 100;
const BASE_DEPTH = 300;

export function meta({ params, ...args }: Route.MetaArgs) {
  const range = params["*"] ? ` ${params["*"]}` : "";
  return page(args, { title: `Compare${range} · ${params.owner}/${params.repo} · g1t` });
}

/** `main...feature` into its two sides; either may be missing. */
function sides(range: string): { base: string | null; head: string | null } {
  const at = range.indexOf("...");
  if (at === -1) return { base: null, head: range || null };
  return { base: range.slice(0, at) || null, head: range.slice(at + 3) || null };
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const path = { namespace: params.owner, name: params.repo };
  const viewer = getViewer(context);
  const url = new URL(request.url);
  // The pickers submit as ?base=&head=; the address keeps base...head.
  if (url.searchParams.has("base") || url.searchParams.has("head")) {
    const base = url.searchParams.get("base") ?? "";
    const head = url.searchParams.get("head") ?? "";
    return Response.redirect(new URL(`/${params.owner}/${params.repo}/compare/${base}...${head}`, url).toString(), 302);
  }
  const [repo, list] = await Promise.all([repos.get(path, viewer), repos.branches(path, viewer)]);
  const found = unwrap(repo);
  const branches = unwrap(list)
    .map((branch) => branch.name)
    .filter((name) => !name.startsWith("g1t-queue/"));
  const asked = sides(params["*"] ?? "");
  const base = asked.base ?? found.defaultBranch;
  const head = asked.head;
  if (!head || head === base) return { base, head, branches, comparison: null, commits: [], same: head === base };
  const [headLog, baseLog] = await Promise.all([repos.log(path, viewer, head, HEAD_DEPTH), repos.log(path, viewer, base, BASE_DEPTH)]);
  if (!headLog.ok || headLog.value.length === 0) throw new Response(`There is no branch, tag or commit named ${head}.`, { status: 404 });
  // What head has that base does not: its history down to the first commit base also has.
  const onBase = new Set(baseLog.ok ? baseLog.value.map((commit) => commit.hash) : []);
  const shared = headLog.value.findIndex((commit) => onBase.has(commit.hash));
  const commits = (shared === -1 ? headLog.value : headLog.value.slice(0, shared)).map((commit) => ({
    hash: commit.hash,
    message: commit.message.split("\n")[0] ?? "",
    author: commit.author.name,
    at: commit.authoredAt,
  }));
  // The changes from where the two last agreed, as a pull request would
  // bring them: what base gained since is not head taking it away. When
  // that point is past what was read, the two tips are compared.
  const mergeBase = shared === -1 ? base : headLog.value[shared]!.hash;
  const compared = await repos.compare(found.id, viewer, mergeBase, head);
  const comparison: Comparison | null = compared.ok ? compared.value : null;
  return { base, head, branches, comparison, commits, same: false };
}

function RefPicker({ name, label, value, branches }: { name: string; label: string; value: string | null; branches: string[] }) {
  const options = value && !branches.includes(value) ? [value, ...branches] : branches;
  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <span className="text-muted">{label}</span>
      <select
        name={name}
        defaultValue={value ?? ""}
        className="h-8 max-w-56 rounded-md border border-line bg-surface px-2 font-mono text-[0.8125rem] outline-none hover:border-line-strong focus:border-accent-dim"
      >
        {value == null && <option value="">Choose a branch</option>}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function Compare({ loaderData, params }: Route.ComponentProps) {
  const { base, head, branches, comparison, commits, same } = loaderData;
  const repoBase = `/${params.owner}/${params.repo}`;
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Compare changes</h2>
        <p className="mt-1 text-sm text-muted">Choose two branches to see what one has that the other does not, then open a pull request for it.</p>
      </div>
      <Form method="get" className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3">
        <RefPicker name="base" label="base" value={base} branches={branches} />
        <ArrowLeft size={14} className="text-faint" aria-hidden="true" />
        <RefPicker name="head" label="compare" value={head} branches={branches} />
        <button
          type="submit"
          className="h-8 rounded-md border border-line px-3 text-sm text-fg/90 transition-colors hover:border-line-strong hover:bg-raised"
        >
          Compare
        </button>
        {head && !same && commits.length > 0 && (
          <ButtonLink to={`${repoBase}/pulls/new?branch=${encodeURIComponent(head)}`} variant="accent">
            <GitPullRequest size={15} />
            Open a pull request
          </ButtonLink>
        )}
      </Form>

      {!head ? (
        <EmptyState title="Pick a branch to compare">Its commits and changes against {base} show here.</EmptyState>
      ) : same ? (
        <EmptyState title="Nothing to compare">Both sides are {base}. Choose another branch to compare with it.</EmptyState>
      ) : commits.length === 0 ? (
        <EmptyState title={`${base} has everything ${head} has`}>There is nothing on {head} to bring into {base}.</EmptyState>
      ) : (
        <>
          <section>
            <h3 className="mb-2 text-sm font-medium text-muted">
              {commits.length === HEAD_DEPTH ? `${HEAD_DEPTH}+` : commits.length} {commits.length === 1 ? "commit" : "commits"}
            </h3>
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {commits.map((commit) => (
                <li key={commit.hash} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <GitCommitHorizontal size={15} className="shrink-0 text-faint" />
                  <Avatar name={commit.author} size={16} />
                  <Link to={`${repoBase}/commit/${commit.hash}`} className="min-w-0 grow truncate hover:text-accent" title={commit.message}>
                    {commit.message}
                  </Link>
                  <span className="hidden shrink-0 text-xs text-muted sm:inline">{commit.author}</span>
                  <Link to={`${repoBase}/commit/${commit.hash}`} className="shrink-0 font-mono text-xs text-faint hover:text-fg">
                    {commit.hash.slice(0, 7)}
                  </Link>
                  <span className="shrink-0 text-xs text-faint">
                    <TimeAgo at={commit.at} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
          {comparison ? (
            <DiffView comparison={comparison} fileBase={`${repoBase}/blob/${encodeURIComponent(head)}`} empty="The two sides have the same files." />
          ) : (
            <p className="text-sm text-muted">The changes could not be read just now. The commits above are what {head} adds.</p>
          )}
        </>
      )}
    </div>
  );
}
