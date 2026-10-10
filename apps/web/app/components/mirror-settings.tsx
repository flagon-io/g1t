import { ExternalLink, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { Form, Link } from "react-router";

import type { HandbackPlan, MirrorView, RefDecision, Remote, RepoMirror } from "@g1t/contracts";

import { DangerAction, DangerZone } from "./danger-zone";
import { MirrorNotes, TakeOverDialog } from "./mirror";
import { ConfirmDialog } from "./repo-lifecycle";
import { SettingsSection as Section, SettingToggle } from "./settings-section";
import { Button, ButtonLink, ErrorText, Field, Input, SubmitButton, TimeAgo } from "./ui";
import { Badge, type BadgeTone } from "./ui/badge";
import { Checkbox, CheckboxOption } from "./ui/checkbox";
import { Hint } from "./ui/hint";
import { RadioGroup, RadioOption } from "./ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import {
  MIRRORING_DOCS,
  TAKE_OVER_MINUTES,
  decisionChoices,
  decisionField,
  handBackReady,
  refActionWords,
  remoteStateWords,
  shortSha,
} from "../lib/mirror";

/** What a form on the mirroring page came back with. */
export type MirrorOutcome = {
  intent: string;
  ok: boolean;
  message: string | null;
  error: string | null;
  /** What it did that people should know: pull requests it opened, and so on. */
  notes?: string[];
};

const STATE_TONES: Record<string, BadgeTone> = {
  standby: "neutral",
  ci: "info",
  takeover: "warn",
  handing_back: "warn",
  following: "success",
  stuck: "warn",
};

const PROVIDERS: Record<Remote["provider"], string> = {
  github: "GitHub",
  g1t: "Another g1t",
  git: "A git host",
};

/** Who put it in this state, in words. */
function byWhom(by: string | null): string {
  if (!by) return "";
  return by === "g1t" ? ", on its own" : `, by ${by}`;
}

/** A green dot when the remote answers, amber when it does not. */
function ReachDot({ reachable }: { reachable: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-2 shrink-0 rounded-full ${reachable ? "bg-success" : "bg-warn shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-warn)_20%,transparent)]"}`}
    />
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-faint">{label}</dt>
      <dd className="mt-0.5 text-sm text-fg">{children}</dd>
    </div>
  );
}

/** A result line under the form that sent it. */
function Result({ result }: { result: MirrorOutcome | undefined }) {
  if (!result) return null;
  if (!result.ok) return <ErrorText>{result.error}</ErrorText>;
  return (
    <>
      {result.message && (
        <p className="text-sm text-success" role="status">
          {result.message}
        </p>
      )}
      <MirrorNotes notes={result.notes} />
    </>
  );
}

const DOCS_LINK = (
  <a href={MIRRORING_DOCS} className="text-fg underline-offset-2 hover:underline">
    How mirroring works
  </a>
);

/**
 * The page under Settings → Mirroring: for a mirror, the remote that leads,
 * what can be done about it and how it behaves; for a repository that
 * leads, the remotes that follow it and adding one.
 */
export function MirroringSettings({
  base,
  full,
  mirror,
  view,
  planRequested,
  planError,
  result,
}: {
  base: string;
  full: string;
  mirror: RepoMirror | null;
  view: MirrorView;
  /** Whether the hand-back was asked to be reviewed (the plan is then filled, or `planError` says why not). */
  planRequested: boolean;
  planError: string | null;
  result: MirrorOutcome | undefined;
}) {
  const leader = view.remotes.find((remote) => remote.role === "leader") ?? null;
  const followers = view.remotes.filter((remote) => remote.role === "follower");
  const resultFor = (...intents: string[]) => (result && intents.includes(result.intent) ? result : undefined);
  if (leader && mirror) {
    return (
      <div className="max-w-4xl space-y-10">
        <Section
          title="Where work happens"
          about={
            <>
              {mirror.state === "takeover"
                ? `g1t has taken over from ${leader.name}, which leads otherwise. Work here as usual, then hand it back.`
                : `${full} follows ${leader.name}, which leads. While it stands by it is an exact, read-only copy that runs nothing. Take over whenever you need to work here.`}{" "}
              {DOCS_LINK}.
            </>
          }
        >
          <LeaderCard base={base} full={full} remote={leader} mirror={mirror} canManage={view.canManage} result={resultFor("take-over", "ci-on", "ci-off", "sync")} />
        </Section>

        {(mirror.state === "takeover" || mirror.state === "handing_back") && (
          <Section
            id="hand-back"
            title="Hand back"
            about={`When you're done, everything g1t did goes back to ${leader.name}, branch by branch, and ${full} follows it again.`}
          >
            {mirror.state === "handing_back" ? (
              <p className="rounded-xl border border-line bg-surface p-4 text-sm text-muted">
                Handing back to {leader.name} now. {full} is read-only until every branch is across; this page shows it
                standing by again once it is.
              </p>
            ) : view.plan ? (
              <HandBackForm full={full} remote={leader.name} plan={view.plan} canManage={view.canManage} result={resultFor("hand-back")} />
            ) : (
              <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
                <p className="text-sm text-muted">
                  g1t compares each branch with {leader.name} and shows what will happen to it before anything goes back.
                </p>
                {planRequested && planError && <ErrorText>{planError}</ErrorText>}
                <ButtonLink to="?plan=1#hand-back" preventScrollReset>
                  Review hand-back
                </ButtonLink>
              </div>
            )}
          </Section>
        )}

        <LeaderSettings remote={leader} full={full} canManage={view.canManage} result={resultFor("settings")} />

        {mirror.state !== "handing_back" && view.canManage && (
          <div className="border-t border-line pt-8">
            <DangerZone>
              <MoveToG1t full={full} remote={leader.name} error={resultFor("move-in")?.error ?? null} />
            </DangerZone>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="max-w-4xl space-y-10">
      <Section
        title="Mirrored to"
        about={
          <>
            Remotes that follow {full}. g1t leads, and every push here goes to each of them. {DOCS_LINK}.
          </>
        }
      >
        <Result result={resultFor("sync", "remove", "settings")} />
        {followers.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
            Not mirrored anywhere yet.
          </p>
        ) : (
          <>
            <ul className="divide-y divide-line rounded-xl border border-line">
              {followers.map((remote) => (
                <FollowerRow key={remote.id} remote={remote} canManage={view.canManage} />
              ))}
            </ul>
            {view.canManage && (
              <Form method="post" className="flex flex-wrap items-center gap-3">
                <SubmitButton variant="quiet" name="intent" value="sync" pending="Syncing…">
                  <RefreshCw size={14} />
                  Sync now
                </SubmitButton>
                <span className="text-xs text-muted">Pushes g1t's branches to every remote here now, over any that moved.</span>
              </Form>
            )}
          </>
        )}
      </Section>

      {view.canManage && (
        <Section
          title="Add a remote"
          about={
            <>
              Another g1t, or any host that speaks git over HTTPS. For GitHub, use{" "}
              <Link to="/new/github" className="text-fg underline-offset-2 hover:underline">
                New → Import from GitHub
              </Link>
              .
            </>
          }
        >
          <AddRemote result={resultFor("add")} />
        </Section>
      )}
    </div>
  );
}

/** The remote a mirror follows: how it stands, and what can be done now. */
function LeaderCard({
  base,
  full,
  remote,
  mirror,
  canManage,
  result,
}: {
  base: string;
  full: string;
  remote: Remote;
  mirror: RepoMirror;
  canManage: boolean;
  result: MirrorOutcome | undefined;
}) {
  const state = mirror.state;
  const silent = !remote.reachable;
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line bg-surface">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-4 py-3">
          <ReachDot reachable={remote.reachable} />
          <a
            href={remote.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-w-0 items-center gap-1.5 font-mono text-sm font-medium break-all hover:text-accent"
          >
            {remote.name}
            <ExternalLink size={12} className="shrink-0 text-faint" />
          </a>
          <Badge tone={STATE_TONES[state]}>{remoteStateWords(state)}</Badge>
          <span className="ml-auto text-xs text-faint">{PROVIDERS[remote.provider]}</span>
        </div>
        <dl className="grid gap-x-6 gap-y-3 px-4 py-3 sm:grid-cols-3">
          <Fact label="State">
            {remoteStateWords(state)}{" "}
            <span className="text-muted">
              <TimeAgo at={mirror.since} />
              {byWhom(remote.stateBy)}
            </span>
          </Fact>
          <Fact label="Remote">
            {silent ? (
              <span className="text-warn">
                Not answering
                {remote.unreachableSince && (
                  <span className="text-muted">
                    {" "}
                    for <Since at={remote.unreachableSince} />
                  </span>
                )}
              </span>
            ) : (
              "Answering"
            )}
          </Fact>
          <Fact label="Last synced">{remote.syncedAt ? <TimeAgo at={remote.syncedAt} /> : <span className="text-muted">Not yet</span>}</Fact>
        </dl>
        {remote.lastError && (
          <p className="mx-4 mb-3 flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-xs text-fg-soft">
            <TriangleAlert size={13} className="mt-px shrink-0 text-warn" aria-hidden="true" />
            <span className="min-w-0 break-words">{remote.lastError}</span>
          </p>
        )}
        {canManage && state !== "handing_back" && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
            {(state === "standby" || state === "ci") && (
              <TakeOverDialog
                base={base}
                full={full}
                mirror={mirror}
                error={result?.intent === "take-over" ? result.error : null}
                trigger={(open) => (
                  <Button type="button" variant={silent ? "primary" : "quiet"} onClick={open}>
                    Take over
                  </Button>
                )}
              />
            )}
            {(state === "standby" || state === "ci") && (
              <Form method="post" className="contents">
                {state === "standby" ? (
                  <SubmitButton variant="quiet" name="intent" value="ci-on" pending="Starting…">
                    Start CI failover
                  </SubmitButton>
                ) : (
                  <SubmitButton variant="quiet" name="intent" value="ci-off" pending="Ending…">
                    End CI failover
                  </SubmitButton>
                )}
                {state === "standby" && (
                  <SubmitButton variant="quiet" name="intent" value="sync" pending="Syncing…">
                    <RefreshCw size={14} />
                    Sync now
                  </SubmitButton>
                )}
              </Form>
            )}
            {state === "takeover" && (
              <ButtonLink to="?plan=1#hand-back" preventScrollReset>
                Review hand-back
              </ButtonLink>
            )}
          </div>
        )}
      </div>
      <p className="text-xs text-muted">
        {state === "standby"
          ? `CI failover keeps the code on ${remote.name} and runs its workflows here, results going back. Taking over makes g1t lead until you hand it back.`
          : state === "ci"
            ? `${remote.name} keeps the code; g1t runs its workflows. ${full} stays read-only for code, issues and pull requests.`
            : state === "takeover"
              ? `Everything works here. Nothing goes back to ${remote.name} until you hand it back.`
              : `Read-only until every branch is back on ${remote.name}.`}
      </p>
      {/* A refused takeover says why in its dialog, which opens again. */}
      {(result?.ok || result?.intent !== "take-over") && <Result result={result} />}
    </div>
  );
}

/** How long since: "5 minutes", "3 hours". */
function Since({ at }: { at: string }) {
  const minutes = Math.max(1, Math.round((Date.now() - new Date(at).getTime()) / 60_000));
  const words =
    minutes < 60
      ? `${minutes} minute${minutes === 1 ? "" : "s"}`
      : minutes < 48 * 60
        ? `${Math.round(minutes / 60)} hour${Math.round(minutes / 60) === 1 ? "" : "s"}`
        : `${Math.round(minutes / 1440)} days`;
  return (
    <time dateTime={new Date(at).toISOString()} suppressHydrationWarning>
      {words}
    </time>
  );
}

/** Each branch, what happens to it, and a choice for those both sides moved. */
function HandBackForm({
  full,
  remote,
  plan,
  canManage,
  result,
}: {
  full: string;
  remote: string;
  plan: HandbackPlan;
  canManage: boolean;
  result: MirrorOutcome | undefined;
}) {
  const [chosen, setChosen] = useState<Record<string, RefDecision | undefined>>({});
  const moving = plan.refs.filter((ref) => ref.action !== "same");
  const same = plan.refs.length - moving.length;
  const ready = handBackReady(plan, chosen);
  const choices = decisionChoices(remote);
  return (
    <Form method="post" preventScrollReset className="space-y-4">
      <input type="hidden" name="intent" value="hand-back" />
      {!plan.reachable && (
        <p className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/5 px-3.5 py-2.5 text-sm text-fg-soft">
          <TriangleAlert size={15} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
          {remote} isn't answering yet; hand back once it is.
        </p>
      )}
      {moving.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
          Every branch is already the same on both sides. Handing back only makes {remote} lead again.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line">
          <div className="hidden grid-cols-[minmax(0,1fr)_5.5rem_5.5rem_minmax(0,1.5fr)] gap-4 border-b border-line bg-surface px-4 py-2 text-xs font-medium text-muted sm:grid">
            <span>Branch</span>
            <span>g1t</span>
            <span className="truncate">{remote.split("/")[0]}</span>
            <span>What happens</span>
          </div>
          <ul className="divide-y divide-line">
            {moving.map((ref) => (
              <li
                key={ref.ref}
                className="grid gap-x-4 gap-y-1.5 px-4 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_5.5rem_5.5rem_minmax(0,1.5fr)] sm:items-start"
              >
                <span className="min-w-0 truncate font-mono font-medium">{ref.ref}</span>
                <div className="flex gap-4 sm:contents">
                  <span className="font-mono text-xs text-muted sm:pt-0.5">
                    <span className="text-faint sm:hidden">g1t </span>
                    {shortSha(ref.ours)}
                  </span>
                  <span className="font-mono text-xs text-muted sm:pt-0.5">
                    <span className="text-faint sm:hidden">{remote.split("/")[0]} </span>
                    {shortSha(ref.theirs)}
                  </span>
                </div>
                {ref.action === "diverged" ? (
                  <div className="space-y-1.5">
                    <p className="flex items-center gap-1.5 text-warn">
                      <TriangleAlert size={13} aria-hidden="true" />
                      Both moved: choose
                    </p>
                    <RadioGroup
                      name={decisionField(ref.ref)}
                      value={chosen[ref.ref] ?? ref.decision ?? undefined}
                      onValueChange={(value) => setChosen((now) => ({ ...now, [ref.ref]: value as RefDecision }))}
                      disabled={!canManage}
                      aria-label={`What happens to ${ref.ref}`}
                      className="gap-1.5"
                    >
                      {choices.map((choice) => (
                        <RadioOption key={choice.value} value={choice.value} label={choice.label} />
                      ))}
                    </RadioGroup>
                  </div>
                ) : (
                  <span className={ref.action === "pull_request" ? "text-info" : "text-fg-soft"}>
                    {refActionWords(ref.action, remote)}
                    {ref.action === "pull_request" && (
                      <span className="mt-0.5 block font-mono text-xs text-muted">g1t/handback/{ref.ref}</span>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {same > 0 && moving.length > 0 && (
        <p className="text-xs text-muted">
          {same} other branch{same === 1 ? " is" : "es are"} already the same on both sides.
        </p>
      )}
      <Result result={result} />
      {canManage && (
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton variant="accent" disabled={!ready} pending="Handing back…">
            Hand back
          </SubmitButton>
          <span className="text-xs text-muted">
            {ready
              ? `${remote} leads again once every branch is across. Until then ${full} is read-only.`
              : plan.reachable
                ? "Choose what happens to each branch both sides moved."
                : `Waiting for ${remote} to answer.`}
          </span>
        </div>
      )}
    </Form>
  );
}

/** How a mirror behaves when its remote stops answering, and what runs in CI failover and takeovers. */
function LeaderSettings({
  remote,
  full,
  canManage,
  result,
}: {
  remote: Remote;
  full: string;
  canManage: boolean;
  result: MirrorOutcome | undefined;
}) {
  const settings = remote.settings;
  const [auto, setAuto] = useState(settings.takeOverAfter != null);
  const id = useId();
  const [least, most] = TAKE_OVER_MINUTES;
  return (
    <Form method="post" className="space-y-10">
      <input type="hidden" name="intent" value="settings" />
      <input type="hidden" name="kind" value="leader" />
      <input type="hidden" name="remoteId" value={remote.id} />
      <fieldset disabled={!canManage} className="space-y-10">
        <Section
          title={`When ${remote.name} stops answering`}
          about="g1t checks every minute. Unless you choose otherwise, it only says so here: nobody is paged, and nothing happens on its own."
        >
          <RadioGroup name="notify" defaultValue={settings.notify} className="gap-3">
            <RadioOption value="banner" label="Show it on the repository" description={`A line across ${full}'s pages, and an amber dot beside its name.`} />
            <RadioOption value="inbox" label="Also tell workspace owners in their notifications" description="Once when it stops answering, and once when it answers again." />
          </RadioGroup>
          <div className="rounded-xl border border-line bg-surface p-4">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
              <Checkbox id={`${id}-auto`} name="autoTakeOver" checked={auto} onCheckedChange={(checked) => setAuto(checked === true)} />
              <label htmlFor={`${id}-auto`} className="cursor-pointer text-sm font-medium">
                Take over automatically after
              </label>
              <span className="flex items-center gap-2">
              <span className="w-20">
                <Input
                  type="number"
                  name="takeOverAfter"
                  aria-label="Minutes"
                  min={least}
                  max={most}
                  step={1}
                  defaultValue={settings.takeOverAfter ?? 30}
                  disabled={!auto}
                />
              </span>
              <span className="text-sm text-muted">minutes</span>
              </span>
            </div>
            <p className="mt-1.5 pl-6.5 text-xs text-faint">
              Off unless you turn it on: people take over when they want. From {least} minutes to a day.
            </p>
          </div>
          <SettingToggle name="handBackWhenClean" on={settings.handBack === "when_clean"} title="Hand back on its own when every branch goes back cleanly">
            Only after an automatic takeover. A branch that moved on both sides always waits for someone to choose.
          </SettingToggle>
        </Section>

        <Section title="Workflows" about="What runs on g1t during CI failover and takeovers. A mirror standing by runs nothing unless CI is kept warm.">
          <SettingToggle name="keepCiWarm" on={settings.keepCiWarm} title="Keep CI warm">
            Run .g1t/workflows on every push copied in from {remote.name}, so CI is ready the moment you need it.
          </SettingToggle>
          <SettingToggle name="githubWorkflows" on={settings.githubWorkflows} title={`Run ${remote.name}'s .github workflows`}>
            In CI failover and takeovers, workflows in .github/workflows run on g1t too, beside .g1t/workflows.
          </SettingToggle>
          <SettingToggle name="holdDeploys" on={settings.holdDeploys} title="Hold workflows that deploy for approval">
            A job that deploys waits for someone to approve it, so taking over never ships anything by surprise.
          </SettingToggle>
        </Section>
      </fieldset>
      {canManage && (
        <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-4 border-t border-line bg-bg/90 px-4 py-4 backdrop-blur">
          <SubmitButton pending="Saving…">Save settings</SubmitButton>
          {result?.ok && <span className="text-sm text-muted">Saved.</span>}
          <ErrorText>{result && !result.ok ? result.error : null}</ErrorText>
        </div>
      )}
    </Form>
  );
}

/** Making g1t the leader for good, said plainly, with the remote kept as a follower if they like. */
function MoveToG1t({ full, remote, error }: { full: string; remote: string; error: string | null }) {
  return (
    <ConfirmDialog
      intent="move-in"
      title={`Move ${full} to g1t?`}
      description={`g1t will no longer track ${remote}. Pushes made there won't come here.`}
      confirm={full}
      submit="Move to g1t"
      busy="Moving…"
      error={error}
      trigger={(open) => (
        <DangerAction
          title="Move to g1t"
          action={
            <Button type="button" variant="danger" onClick={open}>
              Move to g1t
            </Button>
          }
        >
          Make g1t lead {full} for good. It stops being a mirror, and g1t stops tracking {remote}.
        </DangerAction>
      )}
      extra={
        <CheckboxOption
          name="keepRemoteUpdated"
          label={`Keep ${remote} updated from g1t`}
          description={`${remote} follows instead: every push here is pushed there. Off, g1t leaves it as it is.`}
        />
      }
    >
      <li>{full} stops being a mirror: pushes, pull requests, issues, agents and workflows work here from now on.</li>
      <li>This is for good. There is nothing to hand back afterwards.</li>
    </ConfirmDialog>
  );
}

/** One remote that follows: how it stands, what happens to pushes made on it, and removing it. */
function FollowerRow({ remote, canManage }: { remote: Remote; canManage: boolean }) {
  const stuck = remote.state === "stuck";
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <ReachDot reachable={remote.reachable} />
        <a href={remote.url} target="_blank" rel="noreferrer" className="min-w-0 font-mono text-sm font-medium break-all hover:text-accent">
          {remote.name}
        </a>
        <Hint label={stuck ? "It refused a push or moved on its own. Sync now pushes g1t's branches over it." : null}>
          <Badge tone={STATE_TONES[remote.state] ?? "neutral"} tabIndex={stuck ? 0 : undefined}>
            {remoteStateWords(remote.state)}
          </Badge>
        </Hint>
        {canManage && (
          <span className="ml-auto">
            <ConfirmDialog
              intent="remove"
              fields={{ remoteId: remote.id }}
              title={`Stop mirroring to ${remote.name}?`}
              description={`${remote.name} keeps what it has; g1t stops pushing to it. Its token is deleted.`}
              submit="Remove"
              busy="Removing…"
              trigger={(open) => (
                <Button type="button" variant="quiet" onClick={open} aria-label={`Remove ${remote.name}`}>
                  <Trash2 size={14} />
                  <span className="hidden sm:inline">Remove</span>
                </Button>
              )}
            />
          </span>
        )}
      </div>
      <p className="text-xs text-faint">
        {PROVIDERS[remote.provider]} · {remote.syncedAt ? <>Synced <TimeAgo at={remote.syncedAt} /></> : "Not synced yet"}
        {!remote.reachable && <span className="text-warn"> · Not answering</span>}
      </p>
      {remote.lastError && (
        <p className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-xs text-fg-soft">
          <TriangleAlert size={13} className="mt-px shrink-0 text-warn" aria-hidden="true" />
          <span className="min-w-0 break-words">{remote.lastError}</span>
        </p>
      )}
      {canManage && (
        <Form method="post" className="flex flex-wrap items-center gap-2 text-sm">
          <input type="hidden" name="intent" value="settings" />
          <input type="hidden" name="kind" value="follower" />
          <input type="hidden" name="remoteId" value={remote.id} />
          <span className="text-muted">Pushes made on {remote.name}:</span>
          <Select name="remotePushes" defaultValue={remote.settings.remotePushes}>
            <SelectTrigger size="sm" aria-label={`Pushes made on ${remote.name}`} className="w-auto min-w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="adopt">Take in fast-forwards</SelectItem>
              <SelectItem value="overwrite">Overwrite with g1t's</SelectItem>
            </SelectContent>
          </Select>
          <SubmitButton
            variant="quiet"
            match={{ intent: "settings", remoteId: remote.id }}
            pending="Saving…"
            className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg disabled:opacity-50"
          >
            Save
          </SubmitButton>
        </Form>
      )}
    </li>
  );
}

/** A remote to add: where, which one leads, and how to sign in to it. */
function AddRemote({ result }: { result: MirrorOutcome | undefined }) {
  const [round, setRound] = useState(0);
  // Cleared once added, ready for the next.
  useEffect(() => {
    if (result?.ok) setRound((n) => n + 1);
  }, [result]);
  return (
    <Form key={round} method="post" className="space-y-5 rounded-xl border border-line bg-surface p-4">
      <input type="hidden" name="intent" value="add" />
      <fieldset className="space-y-2">
        <legend className="mb-1.5 text-sm font-medium text-muted">Provider</legend>
        <RadioGroup name="provider" defaultValue="git" className="gap-2.5 sm:grid-cols-2">
          <RadioOption value="g1t" label="Another g1t" description="A repository on another g1t, such as one you host yourself." />
          <RadioOption value="git" label="Any git host" description="Anywhere that takes git over HTTPS." />
        </RadioGroup>
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="mb-1.5 text-sm font-medium text-muted">Which one leads</legend>
        <RadioGroup name="role" defaultValue="follower" className="gap-2.5">
          <RadioOption value="follower" label="g1t leads; the remote follows" description="Every push here is pushed there." />
          <RadioOption
            value="leader"
            label="The remote leads; this repository mirrors it"
            description="Only for an empty repository: g1t copies the remote, and this repository becomes a read-only mirror of it."
          />
        </RadioGroup>
      </fieldset>
      <Field label="HTTPS URL">
        <Input name="url" type="url" required inputMode="url" spellCheck={false} placeholder="https://git.example.com/acme/web.git" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Username (optional)">
          <Input name="username" spellCheck={false} autoCapitalize="off" />
        </Field>
        <Field label="Token" hint="Stored encrypted; never shown again.">
          <Input name="token" type="password" spellCheck={false} />
        </Field>
      </div>
      <Result result={result} />
      <SubmitButton pending="Adding…" match={{ intent: "add" }}>
        Add remote
      </SubmitButton>
    </Form>
  );
}
