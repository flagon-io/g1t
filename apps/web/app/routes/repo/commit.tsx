import { Check, Copy, GitCommitHorizontal, GitPullRequest, MessagesSquare, Sparkles } from "lucide-react";
import { Suspense, useState } from "react";
import { Await, Link, data, redirect } from "react-router";

import type { Comparison, Pull } from "@g1t/contracts";

import { parseCommitMessage } from "../../lib/commit-message";
import type { Route } from "./+types/commit";
import { page } from "../../lib/meta";
import { DiffView } from "../../components/diff-view";
import { Avatar, TimeAgo } from "../../components/ui";
import { Hint } from "../../components/ui/hint";
import { Skeleton } from "../../components/ui/skeleton";
import { immutable } from "../../lib/immutable.server";
import { pullForCommit } from "../../lib/provenance.server";
import { accounts, repos } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return { "Server-Timing": loaderHeaders.get("Server-Timing") ?? "" };
}

export function meta({ loaderData, params, ...args }: Route.MetaArgs) {
  const subject = loaderData?.commit.message.split("\n")[0];
  return page(args, {
    title: `${subject ? `${subject} · ` : ""}${params.hash.slice(0, 7)} · ${params.owner}/${params.repo} · g1t`,
  });
}

/** How far back a short hash is looked for. */
const SHORT_HASH_SEARCH = 300;

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const path = { namespace: params.owner, name: params.repo };
  const hash = params.hash.toLowerCase();
  if (!/^[0-9a-f]{4,40}$/.test(hash)) throw data(null, { status: 404 });
  if (hash.length < 40) {
    // A short hash: find the commit it names and go to its full address.
    const log = await repos.log(path, viewer, null, SHORT_HASH_SEARCH);
    const matches = log.ok ? log.value.filter((commit) => commit.hash.startsWith(hash)) : [];
    if (matches.length === 1) throw redirect(`/${params.owner}/${params.repo}/commit/${matches[0]!.hash}`);
    throw new Response("Commit not found.", { status: 404 });
  }
  const started = Date.now();
  const found = unwrap(await repos.get(path, viewer));
  // The viewer may read the repository, and a commit never changes: after
  // the first visit it and its diff come from the cache.
  let cached = true;
  const loaded = await immutable(`commit:${found.id}:${hash}`, async () => {
    cached = false;
    // At once: a commit is compared with its first parent, so the diff
    // does not wait for the commit.
    const [log, compared] = await Promise.all([
      repos.log(path, viewer, hash, 1),
      repos.compare(found.id, viewer, null, hash),
    ]);
    const commit = log.ok ? log.value[0] : undefined;
    if (!commit) return null;
    const comparison: Comparison = compared.ok
      ? compared.value
      : { base: null, head: commit.hash, files: [], truncated: false };
    return { commit, comparison };
  });
  if (!loaded) throw new Response("Commit not found.", { status: 404 });
  // The account the author address belongs to, if any; not cached, since
  // an address can be confirmed or removed later.
  const email = loaded.commit.author.email.toLowerCase();
  const owners = await accounts.emailOwners([email]).catch(() => ({}) as Record<string, never>);
  const owner: { username: string; avatar: string | null } | null = owners[email] ?? null;
  return data(
    {
      ...loaded,
      owner,
      // Streamed: the page shows the commit while this is worked out.
      pull: pullForCommit(path, viewer, loaded.commit.hash),
    },
    { headers: { "Server-Timing": `load;dur=${Date.now() - started};desc="${cached ? "cached" : "read"}"` } },
  );
}

function CopyHash({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(hash).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="flex items-center gap-1.5 rounded-md border border-line bg-bg px-2 py-1 font-mono text-xs text-muted transition-colors hover:border-line-strong hover:text-fg"
      aria-label="Copy the full hash"
    >
      {hash.slice(0, 12)}
      {copied ? <Check size={12} className="text-accent" /> : <Copy size={12} />}
    </button>
  );
}

/** The pull request a commit arrived in, once it has been worked out. */
function MergedIn({ base, pull }: { base: string; pull: Pull }) {
  const byAgent = pull.runtime === "hosted";
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-5 py-3 text-sm">
            <span className="flex items-center gap-2">
              <GitPullRequest size={15} className="text-merged" />
              <span className="text-muted">Merged in</span>
              <Link to={`${base}/pull/${pull.number}`} className="font-medium hover:underline">
                {pull.title} <span className="font-normal text-faint">#{pull.number}</span>
              </Link>
            </span>
            {byAgent && (
              <span className="flex items-center gap-1.5 rounded-full border border-merged/30 bg-merged/10 px-2 py-0.5 text-xs text-merged">
                <Sparkles size={12} />
                written by {pull.agent}
              </span>
            )}
            <Link
              to={`${base}/pull/${pull.number}?tab=session`}
              className="ml-auto flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs text-muted transition-colors hover:border-line-strong hover:text-fg"
            >
              <MessagesSquare size={13} />
              Why it was written
            </Link>
          </div>
  );
}

export default function CommitPage({ loaderData, params }: Route.ComponentProps) {
  const { commit, pull, comparison, owner } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const { subject, body, coAuthors, trailers } = parseCommitMessage(commit.message);
  return (
    <div>
      <section className="overflow-hidden rounded-xl border border-line bg-surface">
        <div className="p-5">
          <p className="flex items-center gap-2 text-xs text-faint">
            <GitCommitHorizontal size={14} />
            <Link to={`${base}/commits`} className="hover:text-fg">
              Commit
            </Link>
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-balance">{subject}</h2>
          {body && <p className="mt-3 max-w-3xl text-sm whitespace-pre-wrap text-muted">{body}</p>}
          {trailers.length > 0 && (
            <dl className="mt-3 space-y-0.5 font-mono text-xs text-faint">
              {trailers.map((trailer) => (
                <div key={`${trailer.key}:${trailer.value}`}>
                  <dt className="inline">{trailer.key}:</dt> <dd className="inline text-muted">{trailer.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-line bg-bg/40 px-5 py-3 text-sm">
          <span className="flex items-center gap-2">
            <Avatar name={owner?.username ?? commit.author.name} image={owner?.avatar} size={20} />
            {owner ? (
              <Hint label={commit.author.name}>
                <Link to={`/u/${owner.username}`} className="font-medium hover:underline">
                  {owner.username}
                </Link>
              </Hint>
            ) : (
              <span className="font-medium">{commit.author.name}</span>
            )}
            {coAuthors.length > 0 && (
              <span className="text-muted">
                and <span className="font-medium text-fg">{coAuthors.join(", ")}</span>
              </span>
            )}
            <span className="text-muted">
              committed <TimeAgo at={commit.authoredAt} />
            </span>
          </span>
          <span className="flex items-center gap-2 text-xs text-muted">
            {commit.parents.length === 0 ? (
              "The first commit"
            ) : (
              <>
                {commit.parents.length === 1 ? "Parent" : "Parents"}
                {commit.parents.map((parent) => (
                  <Link
                    key={parent}
                    to={`${base}/commit/${parent}`}
                    prefetch="intent"
                    className="font-mono text-fg/80 hover:text-accent hover:underline"
                  >
                    {parent.slice(0, 7)}
                  </Link>
                ))}
              </>
            )}
          </span>
          <span className="ml-auto flex items-center gap-2">
            <Link
              to={`${base}/tree/${commit.hash}/`}
              className="rounded-md px-2 py-1 text-xs text-muted hover:bg-raised hover:text-fg"
            >
              Browse files
            </Link>
            <CopyHash hash={commit.hash} />
          </span>
        </div>
        <Suspense
          fallback={
            <div aria-busy="true" className="flex h-12 items-center gap-3 border-t border-line px-4">
              <Skeleton className="size-4 rounded-full" />
              <Skeleton className="h-3 w-64 max-w-[60%]" />
            </div>
          }
        >
          <Await resolve={pull}>{(pull) => (pull ? <MergedIn base={base} pull={pull} /> : null)}</Await>
        </Suspense>
      </section>
      <div className="mt-6">
        <DiffView comparison={comparison} empty="This commit changes no files." fileBase={`${base}/blob/${commit.hash}`} />
      </div>
    </div>
  );
}
