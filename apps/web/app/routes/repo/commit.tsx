import { Check, Copy, GitCommitHorizontal, GitPullRequest, MessageSquareOff, MessagesSquare, Sparkles } from "lucide-react";
import { Suspense, useState } from "react";
import { Await, Link, data, redirect } from "react-router";

import type { ClosedIssue, Comparison, Pull } from "@g1t/contracts";

import { asComments } from "../../lib/commit-comments";

import { parseCommitMessage } from "../../lib/commit-message";
import { firstScreens } from "../../lib/diff";
import type { Route } from "./+types/commit";
import { page } from "../../lib/meta";
import { CommitChecksBadge } from "../../components/commit-checks";
import { CommitText, RefLink } from "../../components/commit-message";
import { DiffView } from "../../components/diff-view";
import { CommitAvatars, CommitNames } from "../../components/commit-person";
import { ErrorText, TimeAgo } from "../../components/ui";
import { CommentForm, CommentList } from "../../components/work";
import { IssueIcon } from "../../components/work-icons";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Skeleton } from "../../components/ui/skeleton";
import { commitChecksFor } from "../../lib/commit-checks.server";
import { immutable } from "../../lib/immutable.server";
import { pullForCommit } from "../../lib/provenance.server";
import { showOneCommit } from "../../lib/commit-people.server";
import { repos, work } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";
import { accessTo } from "../../lib/access.server";
import { Unavailable } from "../../components/boundary";
import { isFailed, part } from "../../lib/partial";

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
  // Its comments, whether more may be added and the issues it closed: never
  // cached, read beside the commit. Its comments and the issues it closed
  // are parts of the page that say so when they fail; without the settings
  // or the viewer's role, comments stay open and nobody moderates, which
  // the service checks again when one is sent.
  const said = Promise.all([
    part(work.commitComments(viewer, path, hash), "Comments"),
    work.getSettings(path, viewer).catch(() => null),
    accessTo(context, params).catch(() => null),
    part(work.closedByCommit(path, hash, viewer), "The issues it closed"),
  ]);
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
  // Its people, as their accounts where there are any; not kept with the
  // commit, since an address can be confirmed or removed later.
  const commit = (await showOneCommit(loaded.commit))!;
  const [comments, settings, access, closed] = await said;
  return data(
    {
      ...loaded,
      // Its first screens with their lines; the rest load as they are reached.
      comparison: firstScreens(loaded.comparison),
      commit,
      // Streamed: the page shows the commit while this is worked out.
      pull: part(pullForCommit(path, viewer, loaded.commit.hash), "The pull request it came in"),
      // Never cached: checks report on a commit long after it was made.
      checks: commitChecksFor(path, viewer, [loaded.commit.hash]),
      comments: isFailed(comments) ? comments : comments.ok ? comments.value : [],
      // Off, the comments made stay readable and no more can be added.
      commentsOn: settings?.ok ? settings.value.allowCommitComments : true,
      // The issues its message closed (`Closes #12`) when it was pushed.
      closed: isFailed(closed) ? closed : closed.ok ? closed.value : [],
      viewer: viewer ? { username: viewer.username } : null,
      // Maintain and up edit and delete anyone's comments; everyone, their own.
      canModerate: access?.can.manage_settings ?? false,
    },
    { headers: { "Server-Timing": `load;dur=${Date.now() - started};desc="${cached ? "cached" : "read"}"` } },
  );
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const path = { namespace: params.owner, name: params.repo };
  const action = String(form.get("action") ?? "");
  const body = String(form.get("body") ?? "");
  if (action === "edit-comment" || action === "delete-comment") {
    const id = String(form.get("comment") ?? "");
    const changed =
      action === "edit-comment" ? await work.editCommitComment(user, path, id, body) : await work.deleteCommitComment(user, path, id);
    return changed.ok ? null : { action, comment: id, error: changed.error.message };
  }
  if (action !== "comment") return { action, error: "Unknown action." };
  if (!body.trim()) return { action, error: "Write something first." };
  // On one line of a file it changed, from the diff, or on the whole commit.
  const file = String(form.get("path") ?? "");
  const line = Number(form.get("line"));
  const added = await work.addCommitComment(
    user,
    path,
    params.hash.toLowerCase(),
    body,
    file && line > 0 ? { path: file, line } : undefined,
  );
  return added.ok ? null : { action, error: added.error.message };
}

function CopyHash({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(hash).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }} variant="outline" size="inline" className="bg-bg px-2 py-1 font-mono text-xs text-muted" aria-label="Copy the full hash">
      {hash.slice(0, 12)}
      {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
    </Button>
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
              <Badge tone="accent" size="md" className="gap-1.5">
                <Sparkles size={12} />
                written by {pull.agent}
              </Badge>
            )}
            <Link
              to={`${base}/pull/${pull.number}/session`}
              className="ml-auto flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs text-muted transition-colors hover:border-line-strong hover:text-fg"
            >
              <MessagesSquare size={13} />
              Why it was written
            </Link>
          </div>
  );
}

/** An issue the commit's message closed when it was pushed. */
function ClosedIssueRow({ base, issue }: { base: string; issue: ClosedIssue }) {
  return (
    <div className="flex items-center gap-2 border-t border-line px-5 py-3 text-sm">
      <IssueIcon issue={{ state: "closed", reason: "completed" }} size={15} />
      <span className="text-muted">Closed</span>
      <RefLink repo={base.slice(1)} number={issue.number} className="min-w-0 truncate font-medium hover:underline">
        {issue.title} <span className="font-normal text-faint">#{issue.number}</span>
      </RefLink>
    </div>
  );
}

export default function CommitPage({ loaderData, actionData, params }: Route.ComponentProps) {
  const { commit, pull, comparison, checks, comments, commentsOn, closed, viewer, canModerate } = loaderData;
  // Comments that could not be read count as none; the list says so in its place.
  const said = asComments(isFailed(comments) ? [] : comments);
  const general = said.filter((comment) => !comment.path);
  const base = `/${params.owner}/${params.repo}`;
  const { subject, body, trailers } = parseCommitMessage(commit.message);
  return (
    <div>
      <Card asChild className="overflow-hidden">
        <section>
          <div className="p-5">
            <p className="flex items-center gap-2 text-xs text-faint">
              <GitCommitHorizontal size={14} />
              <Link to={`${base}/commits`} className="hover:text-fg">
                Commit
              </Link>
            </p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-balance">
              <CommitText text={subject} base={base} />
            </h2>
            {body && (
              <p className="mt-3 max-w-3xl text-sm whitespace-pre-wrap text-muted">
                <CommitText text={body} base={base} />
              </p>
            )}
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
              <CommitAvatars commit={commit} size={20} />
              <span className="font-medium">
                <CommitNames commit={commit} all />
              </span>
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
              <CommitChecksBadge checks={checks} sha={commit.hash} />
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
            <Await resolve={pull}>
              {(pull) =>
                isFailed(pull) ? (
                  <div className="border-t border-line px-5 py-3">
                    <Unavailable what={pull.what} compact />
                  </div>
                ) : pull ? (
                  <MergedIn base={base} pull={pull} />
                ) : null
              }
            </Await>
          </Suspense>
          {isFailed(closed) ? (
            <div className="border-t border-line px-5 py-3">
              <Unavailable what={closed.what} compact />
            </div>
          ) : (
            closed.map((issue) => <ClosedIssueRow key={issue.number} base={base} issue={issue} />)
          )}
        </section>
      </Card>
      <div className="mt-6">
        <DiffView
          comparison={comparison}
          repo={base}
          empty="This commit changes no files."
          fileBase={`${base}/blob/${commit.hash}`}
          review={{ comments: said.filter((comment) => comment.path), canComment: viewer != null && commentsOn }}
        />
      </div>
      <section aria-labelledby="commit-comments" className="mt-10 space-y-4">
        <h3 id="commit-comments" className="flex items-center gap-2 text-sm font-medium">
          <MessagesSquare size={15} className="text-faint" />
          {general.length === 0 ? "Comments" : `${general.length} ${general.length === 1 ? "comment" : "comments"}`}
          {said.length > general.length && (
            <span className="font-normal text-faint">
              · {said.length - general.length} on lines above
            </span>
          )}
        </h3>
        {isFailed(comments) && <Unavailable what={comments.what} />}
        <CommentList
          comments={general}
          base={base}
          // Commit comments name their author by username.
          viewerId={viewer?.username ?? null}
          canModerate={canModerate}
          failed={actionData && "comment" in actionData ? { comment: String(actionData.comment), error: actionData.error } : null}
        />
        {commentsOn ? (
          <CommentForm author={viewer?.username ?? null} resetKey={said.length} />
        ) : (
          <Card className="flex items-center gap-2.5 px-4 py-3 text-sm text-muted">
            <MessageSquareOff size={15} className="shrink-0 text-faint" />
            Comments on commits are turned off in this repository.
          </Card>
        )}
        {actionData?.action === "comment" && <ErrorText>{actionData.error}</ErrorText>}
      </section>
    </div>
  );
}
