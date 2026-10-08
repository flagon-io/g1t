/**
 * The pull requests for one issue, side by side, on each of them: how each
 * stands, how its checks went, where its review is and how big it is, so
 * two agents' attempts at the same issue can be compared and one chosen.
 */
import { CircleCheck, CircleDashed, CircleSlash, GitPullRequestArrow, MessageSquare } from "lucide-react";
import { Suspense } from "react";
import { Await, Link } from "react-router";

import { type Attempt, attemptOutcome } from "../lib/attempts";
import { checksTally } from "../lib/commit-checks";
import { CheckStateIcon } from "./commit-checks";
import { ChangeSize } from "./work";
import { PullIcon } from "./work-icons";
import { SkeletonLine } from "./ui/skeleton";

function ReviewIcon({ state }: { state: Attempt["review"]["state"] }) {
  if (state === "approved") return <CircleCheck size={14} className="shrink-0 text-success" />;
  if (state === "changes_requested") return <CircleSlash size={14} className="shrink-0 text-danger" />;
  if (state === "requested") return <MessageSquare size={14} className="shrink-0 text-warn" />;
  return <CircleDashed size={14} className="shrink-0 text-faint" />;
}

function AttemptRow({ attempt, base }: { attempt: Attempt; base: string }) {
  const merged = attempt.status === "merged";
  return (
    <li className={`px-4 py-3 ${attempt.current ? "bg-raised/40" : ""}`}>
      <div className="flex min-w-0 items-center gap-2">
        <PullIcon status={attempt.status} size={15} />
        {attempt.current ? (
          <span className="min-w-0 truncate font-medium">
            {attempt.title} <span className="font-normal text-faint">#{attempt.number}</span>
          </span>
        ) : (
          <Link to={`${base}/pull/${attempt.number}`} className="min-w-0 truncate font-medium hover:underline">
            {attempt.title} <span className="font-normal text-faint">#{attempt.number}</span>
          </Link>
        )}
        {attempt.current && (
          <span className="shrink-0 rounded-full border border-line px-1.5 py-px text-[0.625rem] text-faint">This one</span>
        )}
        <span className="ml-auto shrink-0">
          <ChangeSize files={attempt.files} />
        </span>
      </div>
      <dl className="mt-2 grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <dt className="sr-only">State</dt>
          <dd className={`truncate ${merged ? "font-medium text-merged" : "text-muted"}`}>
            {attemptOutcome(attempt)} · by {attempt.author}
          </dd>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <dt className="sr-only">Checks</dt>
          <CheckStateIcon state={attempt.checks?.state ?? "none"} size={14} />
          <dd className="truncate text-muted">{attempt.checks && attempt.checks.total > 0 ? checksTally(attempt.checks) : "No checks"}</dd>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <dt className="sr-only">Review</dt>
          <ReviewIcon state={attempt.review.state} />
          <dd className="truncate text-muted">{attempt.review.text}</dd>
        </div>
      </dl>
      {!attempt.current && attempt.shared.length > 0 && (
        <p className="mt-1.5 truncate font-mono text-xs text-faint">Also changes {attempt.shared.join(", ")}</p>
      )}
    </li>
  );
}

/**
 * Every pull request for issue `issue`, this one first: streamed, so the
 * page shows before the others are read. Nothing while there are no others.
 */
export function AttemptsBox({ attempts, issue, base }: { attempts: Promise<Attempt[]>; issue: number; base: string }) {
  return (
    <Suspense
      fallback={
        <div className="mt-4 rounded-xl border border-line bg-surface px-4 py-3" aria-busy>
          <SkeletonLine className="text-sm" barClassName="w-48" />
        </div>
      }
    >
      <Await resolve={attempts} errorElement={null}>
        {(found) =>
          found.filter((attempt) => !attempt.current).length > 0 && (
            <section aria-label={`Other attempts at #${issue}`} className="mt-4 overflow-hidden rounded-xl border border-line bg-surface text-sm">
              <h3 className="flex items-center gap-2.5 px-4 pt-3 font-medium">
                <GitPullRequestArrow size={16} className="shrink-0 text-info" />
                Other attempts at #{issue}
              </h3>
              <p className="px-4 pt-0.5 pb-2 text-xs text-faint">
                Pull requests for the same issue. Merging one closes the others.
              </p>
              <ul className="divide-y divide-line border-t border-line">
                {found.map((attempt) => (
                  <AttemptRow key={attempt.number} attempt={attempt} base={base} />
                ))}
              </ul>
            </section>
          )
        }
      </Await>
    </Suspense>
  );
}
