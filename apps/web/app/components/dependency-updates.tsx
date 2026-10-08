/**
 * The dependency update file, as a project's Security page shows it: which
 * file was read, its problems with their lines, each `updates` entry with
 * its schedule and last check, the private registries, the update pull
 * requests g1t has open, and ignore conditions set in comments. "Check for
 * updates" posts the `check_updates` intent to its page, the Security
 * section's Dependency updates tab (`routes/repo/security-updates.tsx`).
 */
import {
  CalendarClock,
  CircleCheck,
  CircleDot,
  ExternalLink,
  FileCode,
  FileWarning,
  GitMerge,
  GitPullRequest,
  Info,
  KeyRound,
  Loader,
  RefreshCw,
  Wrench,
  EyeOff,
} from "lucide-react";
import { Link, useFetcher } from "react-router";

import type { UpdatePull, VersionUpdateEntry, VersionUpdatesState } from "@g1t/contracts";

import {
  DEPENDENCY_UPDATES_DOCS,
  PULL_STATES,
  conditionText,
  entryStatus,
  groupText,
  ignoreText,
  livePulls,
  timeUntil,
  utc,
} from "../lib/dependency-updates";
import { TimeAgo } from "./ui";
import { Badge, type BadgeTone } from "./ui/badge";
import { Hint } from "./ui/hint";

type Done = { ok: boolean; error?: string } | undefined;

const PULL_TONES: Record<UpdatePull["state"], BadgeTone> = {
  requested: "info",
  open: "accent",
  merged: "merged",
  closed: "neutral",
  superseded: "neutral",
  needs_code: "warn",
  failed: "danger",
};

/** Text with `code` spans, as the service writes its messages. */
function Said({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, index) =>
        index % 2 === 1 ? (
          <code key={index} className="text-fg-soft">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h4 className="text-xs font-medium tracking-wide text-faint uppercase">{children}</h4>;
}

/** One `updates` entry: what it covers, when it runs, what it found. */
function Entry({ entry, action, canCheck }: { entry: VersionUpdateEntry; action: string; canCheck: boolean }) {
  const check = useFetcher<Done>();
  const status = entryStatus(entry);
  const checking = check.state !== "idle";
  const rules: { label: string; values: string[] }[] = [
    { label: "Groups", values: entry.groups.map(groupText) },
    { label: "Ignored", values: entry.ignore.map(ignoreText) },
    {
      label: "Allowed",
      values: entry.allow.map((rule) =>
        [rule.dependency, rule.dependencyType, ...rule.updateTypes.map((type) => type.replace("version-update:semver-", ""))]
          .filter(Boolean)
          .join(" · "),
      ),
    },
    { label: "Assignees", values: entry.assignees },
    { label: "Reviewers", values: entry.reviewers },
  ].filter((rule) => rule.values.length > 0);
  return (
    <li className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono font-medium text-fg">{entry.ecosystem}</span>
            <span className="font-mono text-muted wrap-anywhere">{entry.directories.join(", ")}</span>
            {entry.targetBranch && <span className="font-mono text-xs text-faint">→ {entry.targetBranch}</span>}
            <Badge tone={status.tone}>{status.label}</Badge>
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            {entry.schedule && (
              <span className="inline-flex items-center gap-1">
                <CalendarClock size={12} className="shrink-0" />
                {entry.schedule}
              </span>
            )}
            {entry.nextRunAt && (
              <Hint label={utc(entry.nextRunAt)}>
                <span>Next check {timeUntil(entry.nextRunAt)}</span>
              </Hint>
            )}
            <span>
              {entry.lastCheckedAt ? (
                <>
                  Last checked <TimeAgo at={entry.lastCheckedAt} />
                </>
              ) : (
                "Not checked yet"
              )}
            </span>
            {entry.supported && <span>Up to {entry.openPullRequestsLimit} open</span>}
          </p>
        </div>
        {entry.supported && canCheck && (
          <check.Form method="post" action={action} className="shrink-0">
            <input type="hidden" name="intent" value="check_updates" />
            <input type="hidden" name="entry" value={entry.id} />
            <button
              type="submit"
              disabled={checking || entry.openPullRequestsLimit === 0}
              className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs text-fg/80 transition-colors hover:border-line-strong hover:bg-raised hover:text-fg disabled:opacity-50"
            >
              <RefreshCw size={12} className={checking ? "animate-spin" : ""} />
              {checking ? "Checking…" : "Check for updates"}
            </button>
          </check.Form>
        )}
      </div>
      {check.data?.error && <p className="mt-2 text-xs text-danger">{check.data.error}</p>}
      {entry.lastError ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-danger">
          <FileWarning size={12} className="mt-0.5 shrink-0" />
          <span className="wrap-anywhere">
            <Said text={entry.lastError} />
          </span>
        </p>
      ) : (
        entry.lastResult && (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-muted">
            <CircleCheck size={12} className="mt-0.5 shrink-0 text-accent" />
            <span className="wrap-anywhere">
              <Said text={entry.lastResult} />
            </span>
          </p>
        )
      )}
      {rules.length > 0 && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {rules.map((rule) => (
            <div key={rule.label} className="contents">
              <dt className="text-faint">{rule.label}</dt>
              <dd className="font-mono text-muted wrap-anywhere">{rule.values.join("; ")}</dd>
            </div>
          ))}
        </dl>
      )}
      {entry.notes.length > 0 && (
        <ul className="mt-2 space-y-1">
          {entry.notes.map((note) => (
            <li key={note} className="flex items-start gap-1.5 text-xs text-faint">
              <Info size={12} className="mt-0.5 shrink-0" />
              <span>
                <Said text={note} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** One update pull request g1t has open or is making. */
function PullRow({ pull, base }: { pull: UpdatePull; base: string }) {
  const icon =
    pull.state === "needs_code" ? (
      <Wrench size={13} className="text-warn" />
    ) : pull.state === "requested" ? (
      <Loader size={13} className="text-info" />
    ) : (
      <GitPullRequest size={13} className="text-accent" />
    );
  const count = pull.dependencies.length;
  return (
    <li className="flex items-start gap-2 py-2">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm">
          {pull.pull ? (
            <Link to={`${base}/pulls/${pull.pull}`} className="hover:underline">
              {pull.title} <span className="text-muted">#{pull.pull}</span>
            </Link>
          ) : (
            pull.title
          )}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <Badge tone={PULL_TONES[pull.state]}>{PULL_STATES[pull.state]}</Badge>
          <span>{pull.kind === "security" ? "Security update" : "Version update"}</span>
          <span>
            {count} {count === 1 ? "dependency" : "dependencies"}
          </span>
          {pull.mergeRequestedBy && (
            <span className="inline-flex items-center gap-1">
              <GitMerge size={11} />
              Merges when its checks pass, as @{pull.mergeRequestedBy} asked
            </span>
          )}
        </p>
        {pull.error && <p className="mt-0.5 text-xs text-danger wrap-anywhere">{pull.error}</p>}
      </div>
    </li>
  );
}

export function DependencyUpdates({
  state,
  action,
  base,
  canCheck,
  titled = true,
}: {
  state: VersionUpdatesState;
  action: string;
  base: string;
  canCheck: boolean;
  /** Its own title and what it is for; off where the page says so above it. */
  titled?: boolean;
}) {
  const pulls = livePulls(state.pulls);
  const fileLink = state.path && state.commit ? `${base}/blob/${state.commit}/${state.path}` : null;
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      {titled && (
      <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">Dependency updates</span>
        <a
          href={DEPENDENCY_UPDATES_DOCS}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-fg-soft hover:text-fg hover:underline"
        >
          How to write the file
          <ExternalLink size={10} />
        </a>
      </div>
      <p className="mt-1 text-sm text-muted">
        Pull requests that keep dependencies current on a schedule, from a <code className="text-fg-soft">dependabot.yml</code>{" "}
        file (version 2) in <code className="text-fg-soft">.g1t/</code> or <code className="text-fg-soft">.github/</code>. Security
        updates follow the same file.
      </p>
      </>
      )}

      <div className={`${titled ? "mt-3 " : ""}flex items-start gap-1.5 text-xs text-muted`}>
        {state.found && state.path ? (
          <>
            {state.problems.length > 0 ? (
              <FileWarning size={13} className="shrink-0 text-danger" />
            ) : (
              <FileCode size={13} className="shrink-0 text-accent" />
            )}
            <span>
              Reading{" "}
              {fileLink ? (
                <Link to={fileLink} className="font-mono text-fg-soft hover:underline">
                  {state.path}
                </Link>
              ) : (
                <span className="font-mono text-fg-soft">{state.path}</span>
              )}
              {state.readAt && (
                <>
                  , read <TimeAgo at={state.readAt} />
                </>
              )}
              {state.problems.length === 0 && (
                <>
                  : {state.updates.length} {state.updates.length === 1 ? "entry" : "entries"}
                </>
              )}
            </span>
          </>
        ) : (
          <>
            <CircleDot size={13} className="shrink-0 text-faint" />
            <span>
              No <code>dependabot.yml</code> on the default branch.
            </span>
          </>
        )}
      </div>
      {state.ignoredPaths.length > 0 && (
        <p className="mt-1 flex items-start gap-1.5 text-xs text-warn">
          <Info size={12} className="mt-0.5 shrink-0" />
          <span>
            Also found {state.ignoredPaths.map((path) => <code key={path}>{path} </code>)}
            and ignored it: the file under <code>.g1t/</code> is read in its place.
          </span>
        </p>
      )}

      {state.problems.length > 0 && (
        <div className="mt-3 rounded-lg border border-danger/40 bg-danger/5 p-3">
          <p className="text-xs font-medium text-danger">
            {state.problems.length === 1 ? "1 problem" : `${state.problems.length} problems`}. Nothing is updated from this file until
            {state.problems.length === 1 ? " it is" : " they are"} fixed.
          </p>
          <ul className="mt-2 space-y-1 text-xs">
            {state.problems.map((problem) => (
              <li key={`${problem.line}:${problem.column}:${problem.key}:${problem.message}`} className="flex gap-2">
                <span className="w-14 shrink-0 font-mono text-faint tabular-nums">
                  {problem.line > 0 ? `Line ${problem.line}` : "File"}
                </span>
                <span className="min-w-0 text-fg/90 wrap-anywhere">
                  {problem.key && <code className="mr-1 text-fg-soft">{problem.key}</code>}
                  <Said text={problem.message} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {state.updates.length > 0 && (
        <section className="mt-4">
          <Heading>Entries</Heading>
          <ul className="mt-2 space-y-2">
            {state.updates.map((entry) => (
              <Entry key={entry.id} entry={entry} action={action} canCheck={canCheck && state.problems.length === 0} />
            ))}
          </ul>
        </section>
      )}

      {state.registries.length > 0 && (
        <section className="mt-4">
          <Heading>Private registries</Heading>
          <ul className="mt-2 divide-y divide-line/60 text-xs">
            {state.registries.map((registry) => (
              <li key={registry.name} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5">
                <span className="font-mono text-fg-soft">{registry.name}</span>
                <span className="text-faint">{registry.kind}</span>
                <span className="min-w-0 font-mono text-muted wrap-anywhere">{registry.url}</span>
                {registry.secrets.length > 0 && (
                  <span className="inline-flex items-center gap-1 text-muted">
                    <KeyRound size={11} />
                    {registry.secrets.join(", ")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-4">
        <Heading>Update pull requests</Heading>
        {pulls.length > 0 ? (
          <ul className="mt-1 divide-y divide-line/60">
            {pulls.map((pull) => (
              <PullRow key={`${pull.branch}:${pull.updatedAt}`} pull={pull} base={base} />
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-muted">None open.</p>
        )}
      </section>

      {state.ignores.length > 0 && (
        <section className="mt-4">
          <Heading>Ignored in comments</Heading>
          <ul className="mt-2 space-y-1 text-xs">
            {state.ignores.map((condition) => (
              <li
                key={`${condition.ecosystem}:${condition.dependency}:${conditionText(condition)}`}
                className="flex flex-wrap items-center gap-x-2 gap-y-0.5"
              >
                <EyeOff size={11} className="shrink-0 text-faint" />
                <span className="font-mono text-fg-soft">{condition.dependency}</span>
                <span className="text-muted">{conditionText(condition)}</span>
                <span className="text-faint">
                  {condition.ecosystem} · @{condition.by}
                  {condition.pull != null && (
                    <>
                      {" "}
                      in{" "}
                      <Link to={`${base}/pulls/${condition.pull}`} className="hover:underline">
                        #{condition.pull}
                      </Link>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-faint">
            Comment <code>@g1t unignore &lt;dependency&gt;</code> on an update pull request to undo one.
          </p>
        </section>
      )}
    </div>
  );
}
