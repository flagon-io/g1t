import { Container, type StopParams, type WaitOptions } from "@cloudflare/containers";
import { WorkerEntrypoint } from "cloudflare:workers";

import {
  type BumpArgs,
  UPDATE_BRANCH_PREFIX,
  type RunKind,
  agentsClient,
  type G1tEvent,
  type QueueJob,
  type RepoPath,
  type Result,
  type ServiceBinding,
  type User,
  type Viewer,
  type ComputeEntitlements,
  type ComputeKind,
  ComputeGate,
  actualMicros,
  eventsClient,
  refusalMessage,
  sandboxEstimateMicros,
  billingClient,
  fail,
  ok,
  reposClient,
  workClient,
  type InstanceType,
  STANDARD_INSTANCE,
  chargedAs,
  instanceNamed,
  priceScale,
  runnerMinutes,
} from "@g1t/contracts";

import { BUMP_MINUTES, BUMP_TOKEN_TTL_SECONDS, bumpEnv, bumpProblem, bumpSandboxName, systemActor } from "./bump";
import { BACKUP_MINUTES, backupEnv, backupPace, backupSandboxName } from "./backup";
import { holdCredentials, revokeCredentials, runCredential } from "./credentials";
import { cancelTask, enqueueTask, handedOverStep, selfHostedRoute, taskEnv, taskRepo } from "./self-hosted";
import {
  answered,
  capReached,
  describeError,
  noMachine,
  type Owed,
  recordOwed,
  START_POLL_MS,
  START_WAIT,
  stoppedShort,
  tellStopped,
  withinTimeCap,
} from "./lifecycle";
import {
  ABUSE_EXIT_CODE,
  ABUSE_HOST,
  ABUSE_MESSAGE,
  ALARM_GRACE_SECONDS,
  type PlanLimits,
  type RunGuard,
  abuse,
  buildGuard,
  dockerFor,
  egress,
  git,
  guardFor,
  harnessEnv,
  reportRun,
  SANDBOX_BINDINGS,
  sandboxNamespace,
  throughWorker,
  timeCapMessage,
  withPlanLimits,
} from "./guard";
import { newlyMisdirected } from "./broker";
import { relay, relayDeps } from "./broker-relay";
import { forward } from "./forward";
import { EGRESS_ENV, jobNamespaceOf } from "./egress";
import { GIT_PUBLIC_HOST } from "./internal-git";
import {
  GIT_EDGE_ENV,
  GIT_EDGE_PORT,
  CLONES,
  type Clones,
  NO_CLONES,
  noteClone,
  START_REST_MS,
  type SnapshotStore,
  answerEdge,
  keepSnapshot,
  restoreSnapshot,
  routeToEdge,
  snapshotStore,
} from "./gitedge";

// Outbound interception, which brokered secrets and abuse reports use,
// needs this exported.
export { ContainerProxy } from "@cloudflare/containers";

export interface RunnerEnv {
  SANDBOX: DurableObjectNamespace<AttemptSandbox>;
  /**
   * Workflow jobs that ask with `runs-on` for `ubuntu-slim` (a smaller
   * instance type), and a public repository's `ubuntu-latest` and other
   * Ubuntu labels (a larger one, as GitHub sizes them): the same image,
   * each in a class of its own.
   */
  SANDBOX_SLIM?: DurableObjectNamespace<SandboxSlim>;
  SANDBOX_LARGE?: DurableObjectNamespace<SandboxLarge>;
  /**
   * The git edge (gitedge.ts): one object and container per repository,
   * named by its id, that answers clones from a well-packed mirror. Not a
   * machine jobs can ask for. Absent on a g1t that does not deploy it, and
   * every clone is answered from Artifacts.
   */
  GIT_EDGE?: DurableObjectNamespace<GitEdge>;
  /**
   * The bucket the repos service keeps clone packs in: the git edge keeps
   * each repository's mirror there too (`packs/edge/<repo_id>/`), restored
   * when its container starts cold. Without it, a cold edge fetches all.
   */
  GIT_PACKS?: R2Bucket;
  IDENTITY: ServiceBinding;
  REPOS: ServiceBinding;
  WORK: ServiceBinding;
  BILLING: ServiceBinding;
  /** GitHub Actions jobs: told when a job's sandbox dies without reporting. */
  ACTIONS: ServiceBinding;
  /** Told when a deploy sandbox dies without reporting. */
  DEPLOYMENTS: ServiceBinding;
  /** The event bus: `abuse.flagged`, for g1t's staff. */
  EVENTS?: ServiceBinding;
  CLOUDFLARE_ACCOUNT_ID: string;
  /**
   * `off` stops passing any sandbox's HTTP and HTTPS through the Worker: a
   * switch for the operator, should it misbehave. Brokered secrets' stand-
   * ins then go out as they are, unfilled. Anything else passes the
   * requests of workflow jobs that may be given brokered secrets.
   */
  EGRESS?: string;
  /**
   * `off` stops sandboxes watching themselves for mining (crates/runner
   * abuse.rs): a switch for the operator, should it stop real work.
   * Anything else leaves it on. Miners named in commands are refused
   * either way.
   */
  ABUSE_WATCH?: string;
  /**
   * `off` leaves workflow jobs without a Docker Engine of their own
   * (crates/runner docker/): a switch for the operator. Anything else
   * gives each job one, started the first time it is used.
   */
  DOCKER?: string;
  /**
   * Nightly backups (backup.ts): how many queued backups one sweep starts
   * (`0`: none, backups off here), and how many may run at once.
   */
  BACKUPS_PER_SWEEP?: string;
  BACKUPS_RUNNING?: string;
}

/**
 * What a sandbox is doing. Runs of a work item's commands (`checks`) are from
 * before checks were workflows; a sandbox that was started for work g1t no
 * longer does is told apart by its kind and only cleaned up.
 */
type Run =
  | { kind: "checks"; runId: string; token: string }
  /** One combined state of a merge queue, being built and checked. */
  | { kind: "queue"; entryId: string; token: string }
  /** Whether a pull request merges cleanly: two commits merged, nothing pushed. */
  | { kind: "mergecheck"; pullId: string; token: string }
  /** One job of a GitHub Actions workflow. */
  | { kind: "actions"; jobId: string; token: string }
  /** A build of one commit, deployed to g1t.page. */
  | { kind: "deploy"; deployId: string; token: string }
  /**
   * A security update: one package raised in its lockfiles and pushed to
   * its branch. The security service opens the pull request when it hears
   * the push, so a failure has no one to tell.
   */
  | { kind: "bump"; repo: RepoPath; branch: string }
  /**
   * A repository's nightly backup: a bundle cut and sent to the repos
   * service. g1t's own work, never charged to the workspace.
   */
  | { kind: "backup"; jobId: string; token: string };
/**
 * Whose sandbox time it is, reported when the sandbox stops, and the
 * machine it ran on when it was not the standard one.
 */
type Meter = {
  workspace: string;
  repo: string;
  description: string;
  instance?: string | null;
};
/** A stopped sandbox's time, as billing records it (`recordSandbox`). */
type SandboxUsage = Parameters<ReturnType<typeof billingClient>["recordSandbox"]>[0];
/**
 * What billing reserved for a sandbox's work (`ComputeGate.admit`), settled
 * when it stops at what it cost: its seconds.
 */
type Held = { id: string; workspace: string; microsPerSecond: number };
/**
 * A sandbox that is not tracked as a run but still has a time cap: a
 * workflow job, a deploy build or an update, for `minutes` at most.
 */
type Build = {
  kind: "actions" | "deploy" | "bump";
  minutes: number;
  /**
   * A workflow job that may be given brokered secrets: its HTTP and HTTPS
   * pass the Worker, which fills them in.
   */
  brokered?: boolean;
};
/** Deploy builds are metered by the Deployments plan, not here. */
type RunRequest = Run & {
  envVars: Record<string, string>;
  meter?: Meter;
  track?: Track;
  /** The workspace's plan's caps, applied under its guardrails' (lower of each). */
  limits?: PlanLimits;
  reservation?: Held | null;
  build?: Build;
  /** Whose sandbox it is, when it has no meter: for `abuse.flagged`. */
  owner?: { workspace: string; repo: string };
  /**
   * The labels of the workspace's self-hosted runners this work goes to
   * instead of a container (self-hosted.ts). Null or absent: a container.
   */
  selfHosted?: string[] | null;
};

/** What a sandbox is, as billing meters it. */
function computeKindOf(kind: Run["kind"]): ComputeKind | null {
  switch (kind) {
    case "checks":
    case "mergecheck":
    // A security update resolves lockfiles, as cheap as a check.
    case "bump":
      return "check";
    case "queue":
      return "queue";
    case "actions":
      return "workflow";
    case "deploy":
      return "deploy";
    // Not metered: a backup is g1t's own cost; nor is a sandbox of a kind
    // g1t no longer starts, which ran before it stopped starting them.
    default:
      return null;
  }
}

/** One gate per isolate, so entitlements and prices are kept between calls. */
let gate: ComputeGate | null = null;
function gateFor(env: { BILLING: ServiceBinding }): ComputeGate {
  gate ??= new ComputeGate(env.BILLING);
  return gate;
}

/**
 * What to record the sandbox as, so people can watch it: a run of the
 * merge queue.
 */
type Track = {
  actor: User;
  repo: RepoPath;
  kind: RunKind;
  number?: number | null;
  pullId?: string | null;
  title?: string | null;
  startedBy?: string | null;
};
/** The run a sandbox reports to, kept so it can be closed when it stops. */
type TrackedRun = { runId: string; token: string };

function meter(repo: RepoPath, description: string): Meter {
  return { workspace: repo.namespace, repo: `${repo.namespace}/${repo.name}`, description };
}

/** What the deployments service asks a sandbox to build. */
type DeployJob = {
  deployId: string;
  /** The workspace the project is in, which pays. */
  workspace?: string;
  /** What the deployments service reserved for the build, settled when it stops. */
  reservation?: string | null;
  /** The price it reserved at, per second. */
  microsPerSecond?: number | null;
  /** The plan's longest run, in minutes; the build gets the lower of this and its own. */
  maxRunMinutes?: number | null;
  /** Lets the sandbox, and nothing else, report this build. */
  token: string;
  /** Whose access reads the commit. */
  actor: User;
  /** The repository the commit is in: the pull request's fork, or the repository. */
  source: RepoPath;
  /**
   * The project's repository, whose guardrails the build runs under, and
   * its id. A preview's `source` is its pull request's working copy, so
   * the two differ. Older callers send only `source`.
   */
  repo?: RepoPath | null;
  repoId?: string | null;
  commit: string;
  /** Where in the repository the project lives; empty for all of it. */
  rootDir?: string;
  buildCommand?: string | null;
  outputDir?: string | null;
  /** What it is built as (`auto`, `static`, `workers` or `docker`), and its Dockerfile's path when set. */
  buildAs?: string | null;
  dockerfile?: string | null;
  /** The repository's variables for deploy builds. */
  buildEnv?: Record<string, string>;
  /** Its secrets for deploy builds: set like variables, and redacted from the log. */
  buildSecrets?: Record<string, string>;
};

/** Long enough to install and build; then the read token stops working. */
const DEPLOY_TOKEN_TTL_SECONDS = 30 * 60;

/** Long enough to clone, build and test a merge queue's state; then the token stops working. */
const CHECKS_TOKEN_TTL_SECONDS = 45 * 60;

/** Long enough to clone and merge two commits; then the read token stops working. */
const MERGECHECK_TOKEN_TTL_SECONDS = 10 * 60;

/**
 * One sandbox, for one piece of work: a workflow job, a build, a state of
 * the merge queue, a merge check, an update or a backup. The image's entrypoint
 * is the g1t runner, which does the work and exits; this class only starts
 * it and cleans up if it dies without reporting.
 */
export class AttemptSandbox extends Container<RunnerEnv> {
  // Past the longest default time cap (90 minutes) and its alarm. A run whose guardrails allow longer (up to 240 minutes) is kept
  // past it by `onActivityExpired`, so only its own cap ends it. A finished
  // run's process exits and stops the sandbox well before this.
  sleepAfter = "100m";
  // HTTPS to an intercepted host goes through its handler too (guard.ts).
  interceptHttps = true;
  static {
    // Assigned, not declared: a class field would hide the setter that
    // registers the handler with the containers library. Which one a
    // sandbox uses is chosen as it starts (`run`).
    AttemptSandbox.outboundHandlers = { egress, abuse, git };
  }

  async run(request: RunRequest): Promise<void> {
    const { envVars, meter, track, limits, reservation, build, owner, selfHosted, ...run } = request;
    // What billing reserved is settled however this ends, once.
    if (reservation) await this.ctx.storage.put("reservation", reservation);
    let guard: RunGuard | null;
    try {
      // A tracked run gets its project's guardrails; no sandbox for one
      // starts without them. Workflow jobs, deploy builds and updates get
      // the time cap they were given. The plan's caps apply under them:
      // the lower of each.
      guard = track
        ? withPlanLimits(await guardFor(this.env.WORK, track.repo, track.kind), limits)
        : build
          ? withPlanLimits(buildGuard(build.minutes), limits)
          : null;
    } catch (error) {
      // Thrown to the caller, which says why the work did not start; logged
      // here too, so a sandbox that never started is traceable on its own.
      console.error("sandbox not started", run.kind, describeError(error));
      await this.settle(0);
      throw error;
    }
    await this.ctx.storage.put("run", run);
    // What an earlier attempt in this object left: its reason, its cap
    // and its cap's alarm, which would otherwise stop this attempt when
    // the earlier one's time ran out (re-runs use the same object).
    await this.ctx.storage.delete(["abuse", "stopReason", "remote", "misdirected", "timeCap"]);
    this.deleteSchedules("timeUp");
    if (meter) await this.ctx.storage.put("meter", { ...meter, started: Date.now() });
    await this.ctx.storage.put("started", Date.now());
    const who = meter ? { workspace: meter.workspace, repo: meter.repo } : owner;
    if (who) await this.ctx.storage.put("owner", { ...who, kind: track?.kind ?? run.kind });
    const tracked = track ? await this.openRun(track, envVars, guard) : null;
    // Its credentials are tied to the run, and revoked when it stops.
    await holdCredentials(this.env.IDENTITY, this.ctx.storage, envVars, tracked?.runId ?? null);
    try {
      const vars = tracked ? { ...envVars, AGENT_RUN: tracked.runId, AGENT_RUN_TOKEN: tracked.token } : envVars;
      // The workspace's own runner, not a container: the same environment,
      // handed over as a task.
      const repo = selfHosted?.length ? taskRepo(track, meter, owner) : null;
      if (selfHosted?.length && repo) {
        const harness = guard ? harnessEnv(guard, vars) : {};
        const minutes = guard?.minutes ?? limits?.minutes ?? 60;
        await enqueueTask(this.env.ACTIONS, {
          sandbox: this.ctx.id.toString(),
          repo,
          kind: track?.kind ?? run.kind,
          title: track?.title ?? meter?.description ?? `${run.kind} in ${repo.namespace}/${repo.name}`,
          labels: selfHosted,
          env: taskEnv({ ...vars, ...harness }),
          timeoutMinutes: minutes,
          runId: tracked?.runId ?? null,
        });
        await this.ctx.storage.put("remote", true);
        if (tracked) await reportRun(this.env.WORK, tracked, { steps: [handedOverStep(selfHosted)] });
        if (guard) {
          await this.ctx.storage.put("timeCap", guard.minutes);
          await this.schedule(guard.minutes * 60 + ALARM_GRACE_SECONDS, "timeUp");
        }
        return;
      }
      // Every sandbox reaches the internet. A workflow job that may be
      // given brokered secrets sends its HTTP and HTTPS through `egress`,
      // which fills them in from the job's stand-ins (asked for with the
      // job's token) and sends every request on, to any host; any other
      // sandbox has only `ABUSE_HOST` intercepted, so it can report that it
      // stopped itself for mining. Both are chosen here, as it starts: hosts
      // named on the class up front (`outboundByHost` in a static block)
      // left sandboxes that never picked up their jobs (rolled back
      // 2026-10-13). A workflow job's HTTPS to g1t.sh passes `git` (or
      // `egress`), which hands its signed-in fetches, such as
      // actions/checkout's, to the repos service over its binding rather
      // than over the internet (internal-git.ts). Should that host not be
      // routed, its git goes out as before.
      const brokering = run.kind === "actions" && throughWorker(build, this.env.EGRESS);
      this.enableInternet = true;
      if (brokering && run.kind === "actions") {
        await this.setOutboundHandler("egress", { job: { id: run.jobId, token: run.token } });
      } else if (this.env.EGRESS?.trim().toLowerCase() !== "off") {
        await this.setOutboundByHost(ABUSE_HOST, "abuse").catch((error: unknown) => console.log("abuse reports not routed", String(error)));
        if (run.kind === "actions") {
          await this.setOutboundByHost(GIT_PUBLIC_HOST, "git").catch((error: unknown) => console.log("internal git not routed", String(error)));
        }
      }
      const harness = guard && !build ? harnessEnv(guard, vars) : {};
      // Once any of its traffic is intercepted, Cloudflare passes all of it
      // through this Worker, and HTTPS is re-signed on the way
      // (`interceptHttps`); so a sandbox with either handler trusts that
      // certificate, or every HTTPS request it makes fails
      // (SELF_SIGNED_CERT_IN_CHAIN, as on 2026-10-13).
      const intercepted = brokering || this.env.EGRESS?.trim().toLowerCase() !== "off";
      const trust = intercepted ? EGRESS_ENV : {};
      const watch: Record<string, string> = this.env.ABUSE_WATCH === "off" ? { G1T_ABUSE: "off" } : {};
      // No port of its own: `start` checks the library's default when
      // `portToCheck` is left out, as it does with no wait options at all.
      await this.start({ envVars: { ...vars, ...harness, ...trust, ...watch }, enableInternet: true }, START_WAIT as WaitOptions);
      // A backup has no guardrails, but still a time cap.
      const cap = guard?.minutes ?? (run.kind === "backup" ? BACKUP_MINUTES : null);
      if (cap) {
        await this.ctx.storage.put("timeCap", cap);
        await this.schedule(cap * 60 + ALARM_GRACE_SECONDS, "timeUp");
      }
    } catch (error) {
      console.error("sandbox not started", run.kind, describeError(error));
      await revokeCredentials(this.env.IDENTITY, this.ctx.storage);
      if (tracked) await this.closeRun("failed", `The sandbox could not start: ${String(error)}`);
      await this.settle(0);
      throw error;
    }
  }

  /** Settles what billing reserved for this sandbox at `micros`, once. */
  private async settle(micros: number): Promise<void> {
    const held = await this.ctx.storage.get<Held>("reservation");
    if (!held) return;
    await this.ctx.storage.delete("reservation");
    await gateFor(this.env).settle(held.id, micros);
  }

  /** Settles the reservation at what the sandbox cost: its seconds at the price billing reserved at. */
  private async settleStopped(started: number | undefined): Promise<void> {
    const held = await this.ctx.storage.get<Held>("reservation");
    if (!held) return;
    const seconds = started ? Math.max(1, Math.ceil((Date.now() - started) / 1000)) : 0;
    await this.settle(actualMicros(seconds, held.microsPerSecond));
  }

  /**
   * The sandbox stopped itself because it looked like it was mining
   * (crates/runner abuse.rs), or exited saying so. Stops the run with
   * `ABUSE_MESSAGE`, tells g1t's staff with `abuse.flagged`, and destroys
   * the sandbox. Once.
   */
  async flagAbuse(verdict: unknown): Promise<void> {
    if (await this.ctx.storage.get<boolean>("abuse")) return;
    await this.ctx.storage.put("abuse", true);
    const tracked = await this.ctx.storage.get<TrackedRun>("agentRun");
    if (tracked) await reportRun(this.env.WORK, tracked, { halt: "abuse", error: ABUSE_MESSAGE });
    const owner = await this.ctx.storage.get<{ workspace: string; repo: string | null; kind: string }>("owner");
    console.log("abuse flagged", owner?.workspace, owner?.repo, owner?.kind, JSON.stringify(verdict));
    if (this.env.EVENTS && owner) {
      await eventsClient(this.env.EVENTS)
        .publish([
          {
            type: "abuse.flagged",
            source: "runner",
            // Never on a repository's timeline or its webhooks.
            repoId: null,
            actor: null,
            data: {
              workspace: owner.workspace,
              repo: owner.repo ?? null,
              run: tracked?.runId ?? null,
              kind: owner.kind,
              sandbox: this.ctx.id.toString(),
              metrics: verdict && typeof verdict === "object" ? (verdict as Record<string, unknown>) : null,
            },
          },
        ])
        .catch((error: unknown) => console.log("abuse.flagged not published", String(error)));
    }
    await this.destroy().catch((error: unknown) => console.log("sandbox not destroyed for abuse", String(error)));
  }

  /**
   * Records the run, which the sandbox then reports its steps to. Never
   * stops the sandbox from starting: without a record it just goes unseen.
   */
  private async openRun(track: Track, envVars: Record<string, string>, guard: RunGuard | null): Promise<TrackedRun | null> {
    const opened = await agentsClient(this.env.WORK)
      .openRun({
        ...track,
        model: null,
        sandbox: this.ctx.id.toString(),
        timeCapMinutes: guard?.minutes ?? null,
      })
      .catch((error: unknown) => ({ ok: false as const, error: { message: String(error) } }));
    if (!opened.ok) {
      console.log("run not recorded", track.kind, opened.error.message);
      return null;
    }
    await this.ctx.storage.put("agentRun", opened.value);
    return opened.value;
  }

  /**
   * A workflow job sent a brokered secret's stand-in to a host it is not
   * for: said once per secret and host, in the job's log.
   */
  async noteMisdirected(name: string, host: string): Promise<void> {
    const run = await this.ctx.storage.get<Run>("run");
    if (run?.kind !== "actions") return;
    const noted = newlyMisdirected((await this.ctx.storage.get<string[]>("misdirected")) ?? [], name, host);
    if (!noted) return;
    await this.ctx.storage.put("misdirected", noted.seen);
    try {
      const response = await this.env.ACTIONS.fetch("https://actions/rpc/job_report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ job: run.jobId, token: run.token, report: { kind: "note", text: noted.note } }),
      });
      await answered("job_report", response);
    } catch (error) {
      console.log("misdirected secret not noted", name, String(error));
    }
  }

  /** The run's time cap has passed: stop it, as stopped for time. */
  async timeUp(): Promise<void> {
    // It already stopped (nothing to stop), or the run in it now is a later
    // attempt whose cap has not passed: this alarm is an earlier attempt's,
    // left by a version of g1t that did not clear it, and the run now has
    // its own.
    const started = await this.ctx.storage.get<number>("started");
    const minutes = (await this.ctx.storage.get<number>("timeCap")) ?? 0;
    if (!capReached(started, minutes, Date.now())) {
      if (started) console.log("an earlier attempt's time cap passed; the run now keeps going", this.ctx.id.toString());
      return;
    }
    const tracked = await this.ctx.storage.get<TrackedRun>("agentRun");
    // A workflow job or a build has no run to halt: it fails saying why.
    await this.ctx.storage.put("stopReason", timeCapMessage(minutes));
    if (tracked) await reportRun(this.env.WORK, tracked, { halt: "time", error: timeCapMessage(minutes) });
    if (await this.ctx.storage.get<boolean>("remote")) {
      await cancelTask(this.env.ACTIONS, this.ctx.id.toString(), timeCapMessage(minutes));
      await this.remoteEnded(1, null);
      return;
    }
    await this.destroy().catch((error: unknown) => console.log("sandbox not destroyed at its time cap", String(error)));
  }

  /**
   * Stops this sandbox's work: its container, or the task a self-hosted
   * runner holds, which it hears about on its next poll.
   */
  async halt(reason: string | null): Promise<void> {
    if (await this.ctx.storage.get<boolean>("remote")) {
      await cancelTask(this.env.ACTIONS, this.ctx.id.toString(), reason);
      await this.remoteEnded(1, reason);
      return;
    }
    // A container already gone has nothing to stop; one that will not stop
    // is logged, and its time cap still ends it.
    await this.destroy().catch((error: unknown) => console.error("sandbox not destroyed", reason, describeError(error)));
  }

  /**
   * The library's `sleepAfter` has passed. The runner never fetches its
   * container, so to the library every sandbox looks idle: a run inside its
   * time cap keeps going, and the cap's own alarm (`timeUp`) ends it. Only
   * a sandbox with no cap is stopped for inactivity.
   */
  override async onActivityExpired(): Promise<void> {
    const started = await this.ctx.storage.get<number>("started");
    const cap = await this.ctx.storage.get<number>("timeCap");
    if (withinTimeCap(started, cap, Date.now(), ALARM_GRACE_SECONDS)) return;
    await super.onActivityExpired();
  }

  /**
   * A container that crashed or could not be reached, as the library tells
   * it. Logged at error level with the sandbox, never thrown: the library
   * ignores what this throws, and the stop that follows is handled by
   * `onStop` or by `run`, which says why the work did not start.
   */
  override onError(error: unknown): void {
    console.error("sandbox container error", this.ctx.id.toString(), describeError(error));
  }

  /**
   * The library's alarm: scheduled callbacks, the container's keep-alive,
   * and `onStop` once it has stopped. A failure is logged with the retry it
   * was, then thrown so Cloudflare tries the alarm again.
   */
  override async alarm(alarmProps?: AlarmInvocationInfo): Promise<void> {
    try {
      await super.alarm(alarmProps);
    } catch (error) {
      console.error("sandbox alarm failed", this.ctx.id.toString(), `retry ${alarmProps?.retryCount ?? 0}`, describeError(error));
      throw error;
    }
  }

  /**
   * A self-hosted runner's task ended (the actions service says so, or g1t
   * stopped it): everything a container's stop does, once.
   */
  async remoteEnded(exitCode: number, reason: string | null): Promise<void> {
    if (!(await this.ctx.storage.get<boolean>("remote"))) return;
    await this.ctx.storage.delete("remote");
    await this.ctx.storage.put("selfHostedEnded", true);
    if (exitCode !== 0 && reason && !(await this.ctx.storage.get<string>("stopReason"))) {
      await this.ctx.storage.put("stopReason", reason);
    }
    await this.onStop({ exitCode, reason: "exit" } as StopParams);
    await this.ctx.storage.delete("selfHostedEnded");
  }

  /**
   * Ends the run's record, once. Returns the status it ended with:
   * `stopped` when a person stopped it first.
   */
  private async closeRun(outcome: "succeeded" | "failed", error?: string): Promise<string | null> {
    const tracked = await this.ctx.storage.get<TrackedRun>("agentRun");
    if (!tracked) return null;
    await this.ctx.storage.delete("agentRun");
    const closed = await agentsClient(this.env.WORK)
      .closeRun(tracked.runId, tracked.token, outcome, error)
      .catch(() => null);
    return closed?.ok ? closed.value : null;
  }

  /**
   * Reports how long the sandbox ran, once, whatever it exited with. The
   * usage is fixed now and kept (`owed:<reference>`) until billing
   * confirms it, tried again from the object's alarm while it does not: a
   * re-run in this object writes a new `meter`, never over what is owed.
   * Billing records a reference once, so a try whose answer was lost
   * cannot charge twice. The reservation is settled apart (`settleStopped`).
   */
  private async meterStop(): Promise<void> {
    const metered = await this.ctx.storage.get<Meter & { started: number }>("meter");
    if (!metered) return;
    const seconds = Math.max(1, Math.ceil((Date.now() - metered.started) / 1000));
    const run = await this.ctx.storage.get<Run>("run");
    // On the workspace's own runner: its minutes, at $0.
    const selfHosted = (await this.ctx.storage.get<boolean>("selfHostedEnded")) ?? false;
    const usage: SandboxUsage = {
      workspace: metered.workspace,
      seconds,
      description: selfHosted ? `${metered.description} on a self-hosted runner` : metered.description,
      repo: metered.repo,
      reference: `sandbox/${this.ctx.id.toString()}/${metered.started}`,
      // Whether g1t's open-source pool may pay for it.
      kind: run ? computeKindOf(run.kind) : null,
      selfHosted,
      instance: metered.instance ?? null,
    };
    // One write: the meter becomes what is owed.
    await this.ctx.storage.put<Owed<SandboxUsage>>(`owed:${usage.reference}`, { usage, attempts: 0, since: Date.now() });
    await this.ctx.storage.delete("meter");
    await this.recordOwedTime();
  }

  /**
   * Records the sandbox time billing has not confirmed, and schedules the
   * next try for what it still has not. Never throws: it runs in the stop
   * hook and in the object's alarm.
   */
  async recordOwedTime(): Promise<void> {
    const owed = [...(await this.ctx.storage.list<Owed<SandboxUsage>>({ prefix: "owed:" })).values()];
    if (!owed.length) return;
    const billing = billingClient(this.env.BILLING);
    const result = await recordOwed(
      owed,
      async (usage) => {
        const recorded = await billing.recordSandbox(usage);
        if (!recorded.ok) console.log("sandbox time not recorded yet", usage.workspace, usage.seconds, recorded.error.message);
        return recorded.ok;
      },
      Date.now(),
    );
    for (const entry of result.recorded) await this.ctx.storage.delete(`owed:${entry.usage.reference}`);
    for (const entry of result.kept) await this.ctx.storage.put(`owed:${entry.usage.reference}`, entry);
    for (const entry of result.lost) {
      console.error("sandbox time not recorded, given up", entry.usage.reference, entry.usage.workspace, entry.usage.seconds, `after ${entry.attempts} tries`);
      await this.ctx.storage.delete(`owed:${entry.usage.reference}`);
    }
    this.deleteSchedules("recordOwedTime");
    if (result.retryInSeconds !== null) {
      await this.schedule(result.retryInSeconds, "recordOwedTime").catch((error: unknown) =>
        console.error("sandbox time retry not scheduled", this.ctx.id.toString(), describeError(error)),
      );
    }
  }

  override async onStop({ exitCode, reason }: StopParams): Promise<void> {
    await revokeCredentials(this.env.IDENTITY, this.ctx.storage);
    const started = await this.ctx.storage.get<number>("started");
    await this.meterStop();
    // It stopped itself for mining, and could not say so before it went.
    if (exitCode === ABUSE_EXIT_CODE && !(await this.ctx.storage.get<boolean>("abuse"))) {
      await this.flagAbuse(null);
    }
    const flagged = (await this.ctx.storage.get<boolean>("abuse")) ?? false;
    // Why it stopped, when g1t stopped it: said in place of a plain failure.
    const why = flagged ? ABUSE_MESSAGE : ((await this.ctx.storage.get<string>("stopReason")) ?? null);
    // Stopped by g1t, it failed whatever exit code the library passed on.
    const short = stoppedShort(exitCode, why);
    await this.closeRun(short ? "failed" : "succeeded", short ? (why ?? `The sandbox exited with ${exitCode}.`) : undefined);
    await this.settleStopped(started);
    await this.ctx.storage.delete("started");
    if (!short) return;
    const run = await this.ctx.storage.get<Run>("run");
    console.log("sandbox stopped", run?.kind, "exit", exitCode, reason);
    if (!run) return;
    // Never thrown: this runs in the sandbox's alarm, which a throw would
    // fail, retry and count as an error, running all of the above again.
    // What could not be told is logged, and the sweep catches it up.
    await tellStopped(run.kind, () => this.reportStopped(run, why, exitCode));
  }

  /**
   * Tells whoever is waiting on the sandbox's work that it stopped without
   * finishing it. Each is refused harmlessly when the sandbox reported its
   * end before it stopped. Throws when the service could not be reached.
   */
  private async reportStopped(run: Run, why: string | null, exitCode: number): Promise<void> {
    if (run.kind === "actions") {
      // Refused harmlessly if the job reported its end before it stopped.
      const response = await this.env.ACTIONS.fetch("https://actions/rpc/job_report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          job: run.jobId,
          token: run.token,
          report: { kind: "done", conclusion: "failure", reason: why ?? "The runner stopped before the job finished." },
        }),
      });
      await answered("job_report", response);
      return;
    }
    // Nothing was pushed, so no pull request opens; why is in its log.
    if (run.kind === "bump") return;
    if (run.kind === "backup") {
      // Refused harmlessly if the sandbox reported before it stopped; the
      // job is otherwise tried again later tonight.
      await reposClient(this.env.REPOS).failBackup(run.jobId, run.token, why ?? `The sandbox exited with ${exitCode}.`);
      return;
    }
    if (run.kind === "deploy") {
      // Refused harmlessly if the build reported its end before it stopped.
      const response = await this.env.DEPLOYMENTS.fetch(`https://deployments/jobs/${run.deployId}/fail`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: run.token, message: why ?? "The build stopped before it finished." }),
      });
      await answered("deploy fail", response);
      return;
    }
    const work = workClient(this.env.WORK);
    if (run.kind === "checks") {
      // Refused harmlessly if the run did report before it stopped.
      await work.reportChecks(run.runId, run.token, {
        error: why ?? "The sandbox stopped before the checks finished.",
      });
      return;
    }
    if (run.kind === "queue") {
      // Refused harmlessly if the state was reported before it stopped.
      await work.failQueue(run.entryId, run.token, why ?? "The sandbox stopped before the state was checked.");
      return;
    }
    if (run.kind === "mergecheck") {
      // Refused harmlessly if the probe reported before it stopped.
      await work.failMergecheck(run.pullId, run.token, why ?? "The sandbox stopped before the merge check finished.");
      return;
    }
    // A sandbox of a kind g1t no longer starts, which ran from before: it
    // has nobody left to tell.
  }
}

/**
 * What the compute gate decided for one start: go, with what billing
 * reserved and the plan's caps; or not, refused with what to tell people.
 */
type Granted = {
  ok: true;
  held: Held | null;
  limits: PlanLimits;
  /** The labels of the self-hosted runners it goes to; null for a sandbox. */
  route: string[] | null;
};
type Admitted = Granted | { ok: false; code: string; message: string };

/**
 * The guardrails' default time cap of each kind of run, for estimating what
 * it may cost before it starts; the sandbox applies the project's own.
 */
const DEFAULT_MINUTES: Record<"queue" | "mergecheck", number> = {
  queue: 45,
  mergecheck: 10,
};

/** A plan's cap on one run, for the sandbox to apply under its guardrails'. */
function limitsOf(ent: ComputeEntitlements | null): PlanLimits {
  return { minutes: ent && ent.maxRunMinutes > 0 ? ent.maxRunMinutes : null };
}

/** The shorter of a kind's time cap and the plan's, for an estimate. */
function estimateMinutes(minutes: number, ent: ComputeEntitlements | null): number {
  return ent && ent.maxRunMinutes > 0 ? Math.min(minutes, ent.maxRunMinutes) : minutes;
}

/** A start the gate did not let through, as a result for whoever asked. */
function notAdmitted(admitted: Exclude<Admitted, Granted>): Result<never> {
  return fail("payment_required", admitted.message);
}

/**
 * Sandboxes for workflow jobs whose `runs-on` gets another machine
 * (`ubuntu-slim`, and `ubuntu-latest` in a public repository): the same
 * image and behaviour on another Containers instance type, each a class of
 * its own (wrangler.jsonc). Outbound handlers are registered by class, so
 * each registers its own.
 */
export class SandboxSlim extends AttemptSandbox {
  static {
    SandboxSlim.outboundHandlers = { egress, abuse, git };
  }
}
export class SandboxLarge extends AttemptSandbox {
  static {
    SandboxLarge.outboundHandlers = { egress, abuse, git };
  }
}

/**
 * The git edge of one repository (gitedge.ts): the runner binary as an
 * HTTP server (`MODE=gitedge`) that keeps a mirror of the repository,
 * fetched from Artifacts, and serves clones and fetches from it with real
 * git. It is not a sandbox: it runs nobody's code, is never metered or
 * capped, and holds no credentials but the read token each sync brings.
 * Its requests go straight out: it registers no outbound handlers, so
 * nothing of it is intercepted and it needs no re-signing certificate
 * (`EGRESS_ENV`). It sleeps after ten minutes without a request, and its
 * mirror goes with it (but for its snapshot); the next clone finds it cold
 * and starts it again. Every repository has one, and it costs a container
 * while awake, so it starts only for a repository cloned twice within the
 * hour, or pushed to after that within the day (gitedge.ts `startsOnRead`).
 * When it cannot start (every one of `max_instances` is running), it does
 * not try again for `START_REST_MS`: reads meanwhile are answered from
 * Artifacts, as they are while it is cold.
 */
export class GitEdge extends Container<RunnerEnv> {
  defaultPort = GIT_EDGE_PORT;
  sleepAfter = "10m";
  enableInternet = true;
  envVars = GIT_EDGE_ENV;
  /** The start under way, shared by every request that finds it cold. */
  private warming: Promise<void> | null = null;
  /** Until when no start is tried, after one failed. */
  private restUntil = 0;

  override async fetch(request: Request): Promise<Response> {
    const forward = (forwarded: Request) => this.containerFetch(forwarded, GIT_EDGE_PORT);
    const store = this.env.GIT_PACKS ? snapshotStore(this.env.GIT_PACKS) : null;
    return answerEdge(request, {
      ready: () => this.listening(),
      start: (repoId) => this.warm(repoId, store),
      forward,
      background: (work) => this.ctx.waitUntil(work),
      keep: store ? async (repoId, version) => void (await keepSnapshot(repoId, version, { store, forward })) : undefined,
      noteClone: () => this.noteClone(),
      clones: async () => (await this.ctx.storage.get<Clones>(CLONES)) ?? NO_CLONES,
    });
  }

  /** Notes a clone now in storage (`CLONES`), and gives the clones as noted. */
  private async noteClone(): Promise<Clones> {
    const before = (await this.ctx.storage.get<Clones>(CLONES)) ?? NO_CLONES;
    const after = noteClone(before, Date.now());
    if (after !== before) {
      this.ctx.waitUntil(this.ctx.storage.put(CLONES, after).catch((error: unknown) => console.error("git edge clone not noted", describeError(error))));
    }
    return after;
  }

  /** Listening on its port: what the library itself waits for before it passes a request on. */
  private async listening(): Promise<boolean> {
    return this.ctx.container?.running === true && (await this.getState()).status === "healthy";
  }

  /**
   * Starts the container and waits until its server listens, once however
   * many ask. A container started now (not one already running) is given
   * the repository's kept snapshot (gitedge.ts), so its first sync fetches
   * only what is new. A first start may pull the image, so it is given a
   * minute.
   */
  private warm(repoId: string, store: SnapshotStore | null): Promise<void> {
    if (!this.warming && Date.now() < this.restUntil) {
      return Promise.reject(new Error("a start failed a moment ago"));
    }
    this.warming ??= (async () => {
      const running = await this.listening();
      try {
        await this.startAndWaitForPorts({
          ports: GIT_EDGE_PORT,
          cancellationOptions: { instanceGetTimeoutMS: 60_000, portReadyTimeoutMS: 60_000, waitInterval: START_POLL_MS },
        });
      } catch (error) {
        this.restUntil = Date.now() + START_REST_MS;
        throw error;
      }
      if (!running && store) {
        await restoreSnapshot(repoId, store, (request) => this.containerFetch(request, GIT_EDGE_PORT)).catch((error: unknown) =>
          console.error("git edge snapshot not restored", repoId, describeError(error)),
        );
      }
    })().finally(() => {
      this.warming = null;
    });
    return this.warming;
  }

  /** Logged, never thrown: the next clone finds the edge cold and starts it again. */
  override onError(error: unknown): void {
    console.error("git edge container error", this.ctx.id.toString(), describeError(error));
  }
}

/**
 * What the actions service sends to start a job (`StartJobArgs`). Callers
 * from before may also send `workflow`, `environment` and `trusted`, for
 * workflow-only domains, which are gone: they are ignored.
 */
type ActionsJobArgs = {
  job: string;
  token: string;
  repo: RepoPath;
  timeoutMinutes: number;
  /** The machine its `runs-on` asked for, by label; absent, the standard one. */
  instance?: string | null;
  /** Whether it may be given brokered secrets, which its requests need filled in. */
  brokered?: boolean;
};

export default class RunnerService extends WorkerEntrypoint<RunnerEnv> {
  /**
   * The JSON protocol the Rust services speak: `POST /rpc/<method>` with the
   * arguments as the body, and the git edge's routes (`/gitedge/…`). Only
   * bound services can.
   */
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/rpc/start_actions_job") {
      return Response.json(await this.startActionsJob((await request.json()) as ActionsJobArgs));
    }
    if (request.method === "POST" && pathname === "/rpc/stop_actions_job") {
      const args = (await request.json()) as { job: string };
      // Whichever machine it asked for: the job's object in every namespace.
      await Promise.all(
        Object.keys(SANDBOX_BINDINGS).map((className) => {
          const namespace = sandboxNamespace(this.env, className) as unknown as DurableObjectNamespace<AttemptSandbox>;
          return namespace
            .get(namespace.idFromName(`actions:${args.job}`))
            .destroy()
            .catch(() => undefined);
        }),
      );
      return Response.json(ok(true));
    }
    // A self-hosted runner's task ended: the sandbox that handed it over
    // does what it does when a container stops.
    if (request.method === "POST" && pathname === "/rpc/task_ended") {
      const args = (await request.json()) as { sandbox: string; exitCode: number; reason?: string | null };
      const sandbox = this.env.SANDBOX.get(this.env.SANDBOX.idFromString(args.sandbox));
      await sandbox.remoteEnded(args.exitCode, args.reason ?? null);
      return Response.json(ok(true));
    }
    // A self-hosted job's request to a brokered secret's host, which the
    // API passes on as it came (broker-relay.ts).
    if (request.method === "POST" && pathname === "/rpc/broker") {
      try {
        return await relay(
          request,
          relayDeps(this.env.ACTIONS, (upstream) => forward(upstream)),
        );
      } catch (error) {
        console.log("broker relay failed", String(error));
        return Response.json({ error: { code: "unavailable", message: "g1t could not relay the request." } }, { status: 503 });
      }
    }
    if (request.method === "POST" && pathname === "/rpc/bump") {
      return Response.json(await this.startBump(await request.json()));
    }
    if (request.method === "POST" && pathname === "/rpc/start_deploy") {
      return Response.json(await this.startDeploy((await request.json()) as DeployJob));
    }
    // The repos service's clones and syncs, to the repository's git edge
    // (gitedge.ts), passed on as they came.
    if (pathname.startsWith("/gitedge/")) {
      return routeToEdge(request, this.env.GIT_EDGE);
    }
    return new Response("Not found\n", { status: 404 });
  }

  // ---- The compute gate (@g1t/contracts compute.ts) -------------------------

  /** Whether `repo` is public: what g1t's open-source pool can pay for. */
  private async isPublic(repo: RepoPath): Promise<boolean> {
    const found = await reposClient(this.env.REPOS)
      .get(repo, null)
      .catch(() => null);
    return Boolean(found?.ok && !found.value.isPrivate);
  }

  /**
   * Whether a sandbox (the merge queue, a
   * merge check, a workflow job) may start in `repo`, with what it may cost
   * for `minutes` reserved. Public repositories' checks, workflows and
   * queue can be paid by the open-source pool. Never throws.
   */
  private async admitSandbox(
    kind: ComputeKind,
    repo: RepoPath,
    minutes: number,
    instance: InstanceType = STANDARD_INSTANCE,
    { selfHosted = true }: { selfHosted?: boolean } = {},
  ): Promise<Admitted> {
    const workspace = repo.namespace.toLowerCase();
    const compute = gateFor(this.env);
    const ent = await compute.entitlements(workspace);
    if (ent?.paused) return { ok: false, code: "paused", message: refusalMessage("paused", workspace, kind, ent.paused) };
    // Checks and the merge queue go to the workspace's own runners when it
    // says so, and cost nothing there. Workflow jobs choose with `runs-on`.
    const route = selfHosted && (kind === "check" || kind === "queue") ? await selfHostedRoute(this.env.ACTIONS, repo) : null;
    if (route) return { ok: true, held: null, limits: limitsOf(ent), route };
    const [standardMicros, isPublic] = await Promise.all([compute.microsPerSecond(), this.isPublic(repo)]);
    // Reserved for its time limit at the larger of what it may cost (the
    // sandbox price, scaled to its machine) and its minutes at the
    // machine's rate, which is what it is charged.
    const limit = estimateMinutes(minutes, ent);
    const microsPerSecond = standardMicros * priceScale(instance);
    const estimateMicros = Math.max(sandboxEstimateMicros(limit, microsPerSecond), runnerMinutes(limit * 60) * instance.microsPerMinute);
    const admission = await compute.admit({ workspace, repo, public: isPublic, kind, estimateMicros }, ent);
    if (!admission.ok) return { ok: false, code: admission.code, message: admission.message };
    return {
      ok: true,
      held: admission.reservation ? { id: admission.reservation.id, workspace, microsPerSecond } : null,
      limits: limitsOf(ent),
      route: null,
    };
  }

  /** Gives back what was reserved for a start that never reached its sandbox. */
  private async release(held: Held | null): Promise<void> {
    if (held) await gateFor(this.env).settle(held.id, 0);
  }

  /**
   * Runs `start`, giving back what was reserved if it fails. A sandbox that
   * could not start has given it back already; settling twice at nothing
   * is harmless.
   */
  private async holding<T>(granted: Granted, start: () => Promise<T>): Promise<T> {
    try {
      return await start();
    } catch (error) {
      await this.release(granted.held);
      throw error;
    }
  }

  /**
   * Starts one job of a GitHub Actions workflow in a sandbox of its own.
   * The sandbox fetches the job, its contexts and its secrets with the
   * job's token, and reports back to the actions service through the API.
   * Jobs run on g1t's machines, so only for workspaces that may use them.
   */
  private async startActionsJob(args: ActionsJobArgs): Promise<Result<true>> {
    // The machine its `runs-on` asked for; the standard one otherwise, and
    // also when this runner has no such machine (a g1t that does not deploy
    // it, or a deploy that has reached the actions service first): the job
    // runs, smaller, rather than failing.
    const asked = instanceNamed(args.instance);
    const instance = this.jobNamespace(asked) ? asked : STANDARD_INSTANCE;
    // What it is charged as (`billedAs`): its own machine, or the standard
    // one for a public repository's 4-core machine, which GitHub gives at
    // no extra charge. Its reservation, minutes and rate are that machine's.
    const billed = chargedAs(instance);
    // Workflow jobs run on g1t's machines: only as the workspace's plan
    // allows, or on a public repository, from the open-source pool.
    const admitted = await this.admitSandbox("workflow", args.repo, args.timeoutMinutes, billed);
    if (!admitted.ok) return fail("payment_required", `Not started: ${admitted.message}`);
    const namespace = this.jobNamespace(instance);
    if (!namespace) {
      await this.release(admitted.held);
      return fail("invalid", `Not started: ${instance.label} machines are not available here.`);
    }
    const sandbox = namespace.get(namespace.idFromName(`actions:${args.job}`));
    // The statement line says what it ran on; billing adds the minutes on
    // the machine it is charged as.
    const on = instance === STANDARD_INSTANCE ? "" : billed === instance ? ` on ${instance.label}` : ` on the ${instance.machine} machine`;
    try {
      await sandbox.run({
        kind: "actions",
        jobId: args.job,
        token: args.token,
        reservation: admitted.held,
        limits: admitted.limits,
        // The job's own time limit, and whether its requests pass the
        // Worker for its brokered secrets.
        build: {
          kind: "actions",
          minutes: Math.max(1, args.timeoutMinutes),
          brokered: args.brokered === true,
        },
        meter: {
          ...meter(args.repo, `A workflow job in ${args.repo.namespace}/${args.repo.name}${on}`),
          instance: billed === STANDARD_INSTANCE ? null : billed.label,
        },
        envVars: {
          MODE: "actions",
          G1T_API: "https://api.g1t.sh",
          ACTIONS_JOB: args.job,
          ACTIONS_TOKEN: args.token,
          // Docker of the job's own, inside its sandbox (crates/runner docker/).
          G1T_DOCKER: dockerFor(this.env.DOCKER),
        },
      });
    } catch (error) {
      // No machine free: the actions service puts the job back in the
      // queue for its next sweep. What was reserved is given back already.
      if (noMachine(error)) {
        return { ok: false, error: { code: "unavailable", message: `No ${instance.label} machine was free to start the job.` } };
      }
      // A sandbox that could not start, or stopped at once: the job fails
      // with why, rather than waiting to be noticed.
      return {
        ok: false,
        error: { code: "conflict", message: `The runner could not start the job: ${String(error).replace(/^Error: /, "")}` },
      };
    }
    // `true`, not null: an outcome needs a value.
    return ok(true);
  }

  /** The sandboxes of a label: the class the catalogue names for it, by its binding. */
  private jobNamespace(instance: InstanceType): DurableObjectNamespace<AttemptSandbox> | null {
    return jobNamespaceOf(this.env, instance) as DurableObjectNamespace<AttemptSandbox> | null;
  }

  /**
   * Builds one commit in a sandbox of its own and deploys it to g1t.page.
   * Asked by the deployments service, which has already checked that the
   * workspace pays for Deployments; that plan is what
   * lets a build use g1t's machines.
   */
  private async startDeploy(job: DeployJob): Promise<Result<true>> {
    // To read the commit, which may be private, as whoever pushed it.
    const token = await runCredential(this.env.IDENTITY, {
      onBehalfOf: job.actor,
      repo: job.source,
      kind: "deploy",
      use: "runner",
      read: [job.source],
      ttlSeconds: DEPLOY_TOKEN_TTL_SECONDS,
    });
    const sandbox = this.env.SANDBOX.get(this.env.SANDBOX.idFromName(`deploy:${job.deployId}`));
    const workspace = (job.workspace ?? job.source.namespace).toLowerCase();
    // The project the build is for, and who it is charged to.
    const project = job.repo ?? job.source;
    try {
      await sandbox.run({
        kind: "deploy",
        deployId: job.deployId,
        token: job.token,
        reservation: job.reservation ? { id: job.reservation, workspace, microsPerSecond: job.microsPerSecond ?? 0 } : null,
        limits: { minutes: job.maxRunMinutes ?? null },
        // For as long as its read token lasts.
        build: { kind: "deploy", minutes: DEPLOY_TOKEN_TTL_SECONDS / 60 },
        owner: { workspace, repo: `${project.namespace}/${project.name}` },
        envVars: {
          MODE: "deploy",
          G1T_API: "https://api.g1t.sh",
          DEPLOY_ID: job.deployId,
          DEPLOY_TOKEN: job.token,
          G1T_USER: job.actor.username,
          G1T_TOKEN: token,
          GIT_REMOTE: `https://g1t.sh/${job.source.namespace}/${job.source.name}.git`,
          GIT_COMMIT: job.commit,
          ROOT_DIR: job.rootDir ?? "",
          BUILD_COMMAND: job.buildCommand ?? "",
          OUTPUT_DIR: job.outputDir ?? "",
          BUILD_AS: job.buildAs ?? "auto",
          DOCKERFILE: job.dockerfile ?? "",
          // A container build's own Docker Engine (crates/runner docker/),
          // started only if the project is built as one.
          G1T_DOCKER: dockerFor(this.env.DOCKER),
          BUILD_ENV: JSON.stringify(job.buildEnv ?? {}),
          BUILD_SECRETS: JSON.stringify(job.buildSecrets ?? {}),
        },
      });
    } catch (error) {
      return {
        ok: false,
        error: { code: "conflict", message: `The runner could not start the build: ${String(error).replace(/^Error: /, "")}` },
      };
    }
    return ok(true);
  }

  /**
   * Makes a security update in a sandbox of its own (crates/runner
   * bump.rs): raises one package to a fixed version in the lockfiles
   * named, commits that as g1t and pushes it to its `g1t/security/…`
   * branch. A version update (`kind: "version"`) raises one or more
   * packages the same way, to the branch its dependency update file names,
   * which is never the default one. Asked by the security service, which
   * opens the pull request when it hears the push; nothing here opens one.
   * Admitted, reserved and metered like checks, always in g1t's sandbox (a
   * self-hosted runner may not know the mode), under the project's network
   * list plus the package registries. Returns whether the sandbox started.
   */
  private async startBump(input: unknown): Promise<Result<boolean>> {
    const problem = bumpProblem(input, UPDATE_BRANCH_PREFIX);
    if (problem) return fail("invalid", problem);
    const args = input as BumpArgs;
    const repo = args.repo;
    const what = args.kind === "version" ? "version update" : "security update";
    const actor = systemActor(repo.namespace);
    const closed = await this.closedRepo(actor, repo);
    if (closed) return closed;
    const admitted = await this.admitSandbox("check", repo, BUMP_MINUTES, STANDARD_INSTANCE, { selfHosted: false });
    if (!admitted.ok) return notAdmitted(admitted);
    try {
      const defaultBranch = await this.defaultBranch(repo, actor);
      // From its `target-branch`, which its pull request merges into, or
      // the default branch.
      const base = args.base ?? defaultBranch;
      // A version update names its own branch, which is never the one it
      // starts from, nor the default one.
      if (args.kind === "version" && (args.branch === defaultBranch || args.branch === base)) {
        await this.release(admitted.held);
        return fail("invalid", `A version update cannot push to ${args.branch}, the branch it starts from.`);
      }
      // As g1t, for the workspace: reads the repository and pushes this
      // branch only, with no API operations.
      const token = await runCredential(this.env.IDENTITY, {
        onBehalfOf: actor,
        repo,
        kind: "bump",
        use: "runner",
        read: [repo],
        push: [{ repo, branch: args.branch }],
        ttlSeconds: BUMP_TOKEN_TTL_SECONDS,
      });
      const sandbox = this.env.SANDBOX.get(this.env.SANDBOX.idFromName(bumpSandboxName(args)));
      await sandbox.run({
        kind: "bump",
        repo,
        branch: args.branch,
        reservation: admitted.held,
        limits: admitted.limits,
        build: { kind: "bump", minutes: BUMP_MINUTES },
        meter: meter(repo, `${args.kind === "version" ? "Version" : "Security"} update in ${repo.namespace}/${repo.name}`),
        envVars: bumpEnv(args, base, token),
      });
    } catch (error) {
      await this.release(admitted.held);
      return fail("conflict", `The runner could not start the ${what}: ${String(error).replace(/^Error: /, "")}`);
    }
    return ok(true);
  }

  /**
   * Events from the bus. Each one that could change what a pull request
   * needs next moves it along: the work service decides whether it can
   * merge by the repository's settings, and merges it if so. Merge checks
   * and the merge queue's states start here too.
   */
  async queue(batch: MessageBatch<G1tEvent>): Promise<void> {
    for (const message of batch.messages) {
      const event = message.body;
      switch (event.type) {
        case "pull.opened":
        case "pull.ready":
        case "pull.updated":
        case "checks.completed":
        case "review.completed":
        case "pull.mergeability":
          await this.advance(event.data.pullId);
          break;
        // Its head or its target moved and both changed the same files:
        // find out whether it still merges cleanly.
        case "pull.mergecheck":
          await this.startMergecheck(event.data.pullId);
          break;
        // Something joined, left or landed: test the next batch if none is.
        case "queue.changed":
          await this.buildQueue(event.data.repoId);
          break;
        // A person approved or asked for changes, which may let it merge.
        case "comment.created":
          if (event.data.pullId && event.data.verdict) await this.advance(event.data.pullId);
          break;
        // The branch the others would land on has moved.
        case "pull.merged":
          await this.advanceAll(event.data.repoId);
          break;
        // Read-only or gone: the runs there stop.
        case "repo.archived":
        case "repo.deleted":
          await this.stopRunsIn(event.data.repoId);
          break;
      }
      message.ack();
    }
  }

  /** A sweep, for steps whose trigger was missed or whose sandbox died, and the nightly backups. */
  async scheduled(): Promise<void> {
    // Each step on its own: one that fails does not stop the others.
    await this.advanceAll().catch((error: unknown) => console.log("pull requests not advanced", String(error)));
    await this.buildWaitingQueues().catch((error: unknown) => console.log("waiting queues not built", String(error)));
    await this.startBackups().catch((error: unknown) => console.log("backups not started", String(error)));
  }

  /**
   * Starts a few of the nightly backups the repos service queued, each in
   * a sandbox of its own that holds only its job's token: the sandbox asks
   * for a read-only git credential itself, when it is ready to clone. No
   * plan is asked and nothing is metered: backups are g1t's own work.
   */
  private async startBackups(): Promise<void> {
    const pace = backupPace(this.env.BACKUPS_PER_SWEEP, this.env.BACKUPS_RUNNING);
    if (pace.perSweep === 0) return;
    const repos = reposClient(this.env.REPOS);
    for (const claim of await repos.claimBackups(pace.perSweep, pace.running)) {
      try {
        const sandbox = this.env.SANDBOX.get(this.env.SANDBOX.idFromName(backupSandboxName(claim)));
        await sandbox.run({
          kind: "backup",
          jobId: claim.jobId,
          token: claim.token,
          // For `abuse.flagged`: whose repository it was.
          owner: { workspace: claim.path.namespace, repo: `${claim.path.namespace}/${claim.path.name}` },
          envVars: backupEnv(claim, "https://api.g1t.sh"),
        });
      } catch (error) {
        await repos.failBackup(claim.jobId, claim.token, `The sandbox could not start: ${String(error)}`).catch(() => null);
      }
    }
  }

  /**
   * Builds again each merge queue that waits on a refusal for now (a
   * repository being copied into a fork takes no writes): no event says the
   * refusal has ended, so the sweep tries, at its pace, never faster.
   */
  private async buildWaitingQueues(): Promise<void> {
    for (const repoId of await workClient(this.env.WORK).waitingQueues()) {
      await this.buildQueue(repoId).catch((error: unknown) => console.log("queue not built", repoId, String(error)));
    }
  }

  private async advanceAll(repoId?: string): Promise<void> {
    const pulls = await workClient(this.env.WORK).managedPulls(repoId);
    for (const pullId of pulls) await this.advance(pullId);
  }

  /**
   * Merges a pull request by the repository's settings when it is ready:
   * the work service decides and merges, and claims the step, so calling
   * this twice merges nothing twice.
   */
  private async advance(pullId: string): Promise<void> {
    const next = await workClient(this.env.WORK).advance(pullId);
    // g1t no longer reviews, revises or catches up pull requests itself.
    if (next.action !== "none") console.log("lifecycle step not taken", pullId, next.action);
  }

  /**
   * Starts the next batch of a repository's merge queue, if it has one
   * ready: a sandbox per entry, all at once, each building the default
   * branch with that entry and everything ahead of it.
   */
  private async buildQueue(repoId: string): Promise<void> {
    const work = workClient(this.env.WORK);
    const jobs = await work.queueBuild(repoId);
    // Merge queue sandboxes, like any other, only as the workspace's plan
    // allows: refused states fail at once, saying why. A state whose
    // sandbox could not start fails at once too, rather than holding the
    // queue until it times out.
    await Promise.all(
      jobs.map(async (job) => {
        const admitted = await this.admitSandbox("queue", job.repo, DEFAULT_MINUTES.queue);
        if (!admitted.ok) {
          await work.failQueue(job.entryId, job.token, `Not started: ${admitted.message}`);
          return;
        }
        await this.holding(admitted, () => this.startQueueRun(job, admitted)).catch((error: unknown) =>
          work.failQueue(job.entryId, job.token, `Its sandbox could not start: ${String(error)}`),
        );
      }),
    );
  }

  private async startQueueRun(job: QueueJob, granted: Granted): Promise<void> {
    // To read the changes and push the tested state, as a member.
    // Reads each queued change; pushes only the queue's own branch.
    const token = await runCredential(this.env.IDENTITY, {
      onBehalfOf: job.actor,
      repo: job.repo,
      kind: "queue",
      use: "runner",
      number: job.stack.at(-1)?.number ?? null,
      read: job.stack.map((item) => item.source),
      push: [{ repo: job.repo, branch: job.branch }],
      ttlSeconds: CHECKS_TOKEN_TTL_SECONDS,
    });
    const remote = (path: RepoPath) => `https://g1t.sh/${path.namespace}/${path.name}.git`;
    const sandbox = this.env.SANDBOX.get(this.env.SANDBOX.idFromName(`queue-${job.entryId}-${job.baseCommit}`));
    await sandbox.run({
      kind: "queue",
      entryId: job.entryId,
      token: job.token,
      reservation: granted.held,
      limits: granted.limits,
      selfHosted: granted.route,
      track: {
        actor: job.actor,
        repo: job.repo,
        kind: "queue",
        number: job.stack.at(-1)?.number ?? null,
        title: `Merge queue: ${job.stack.map((item) => `#${item.number}`).join(" + ")}`,
      },
      meter: meter(job.repo, `Merge queue on ${job.repo.namespace}/${job.repo.name}`),
      envVars: {
        MODE: "queue",
        G1T_API: "https://api.g1t.sh",
        QUEUE_ENTRY: job.entryId,
        QUEUE_TOKEN: job.token,
        G1T_USER: job.actor.username,
        G1T_TOKEN: token,
        BASE_REMOTE: remote(job.repo),
        BASE_COMMIT: job.baseCommit,
        QUEUE_BRANCH: job.branch,
        STACK: JSON.stringify(
          job.stack.map((item) => ({
            number: item.number,
            title: item.title,
            remote: remote(item.source),
            branch: item.branch,
            commit: item.commit,
          })),
        ),
        CHECKS: JSON.stringify(job.checks),
        CONTRACT_CHECKS: JSON.stringify(job.contractChecks),
      },
    });
  }

  /**
   * Merges a pull request's head into its target in a sandbox of its own,
   * pushing nothing, to find the files that conflict.
   * The work service decides when one is needed and how many may run.
   */
  private async startMergecheck(pullId: string): Promise<void> {
    const work = workClient(this.env.WORK);
    const started = await work.startMergecheck(pullId);
    if (!started.ok) return;
    const job = started.value;
    let granted: Granted | null = null;
    try {
      // Like any sandbox, only as the workspace's plan allows.
      const admitted = await this.admitSandbox("check", job.repo, DEFAULT_MINUTES.mergecheck);
      if (!admitted.ok) throw new Error(`Not started: ${admitted.message}`);
      granted = admitted;
      // To read the change, which may be private, as whoever opened it.
      const token = await runCredential(this.env.IDENTITY, {
        onBehalfOf: job.author,
        repo: job.repo,
        kind: "mergecheck",
        use: "runner",
        number: job.number,
        read: [job.repo, job.source],
        ttlSeconds: MERGECHECK_TOKEN_TTL_SECONDS,
      });
      const remote = (path: RepoPath) => `https://g1t.sh/${path.namespace}/${path.name}.git`;
      // One sandbox per pair of commits: asking twice starts nothing twice.
      const sandbox = this.env.SANDBOX.get(this.env.SANDBOX.idFromName(`mergecheck-${job.pullId}-${job.head}-${job.base}`));
      await sandbox.run({
        kind: "mergecheck",
        pullId: job.pullId,
        token: job.token,
        reservation: granted.held,
        limits: granted.limits,
        selfHosted: granted.route,
        meter: meter(job.repo, `Merge check of ${job.repo.namespace}/${job.repo.name}#${job.number}`),
        envVars: {
          MODE: "mergecheck",
          G1T_API: "https://api.g1t.sh",
          MERGECHECK_PULL: job.pullId,
          MERGECHECK_TOKEN: job.token,
          G1T_USER: job.author.username,
          G1T_TOKEN: token,
          BASE_REMOTE: remote(job.repo),
          BASE_COMMIT: job.base,
          HEAD_REMOTE: remote(job.source),
          HEAD_BRANCH: job.branch,
          HEAD_COMMIT: job.head,
        },
      });
    } catch (error) {
      if (granted) await this.release(granted.held);
      await work.failMergecheck(job.pullId, job.token, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * A refusal if `repo` takes no work from anyone: it is archived, so
   * read-only, or it was deleted (repos hides a deleted one, so it is not
   * found). Null when repos cannot answer now; the other checks still run.
   */
  private async closedRepo(actor: User, repo: RepoPath): Promise<Result<never> | null> {
    const repos = reposClient(this.env.REPOS);
    const found = await repos.get(repo, actor).catch(() => null);
    if (!found) return null;
    if (!found.ok) {
      return found.error.code === "not_found" ? fail("not_found", `There is no repository at ${repo.namespace}/${repo.name}, or it was deleted.`) : null;
    }
    const status = await repos.statusById(found.value.id).catch(() => null);
    if (status?.deleted) {
      return fail("not_found", `${found.value.namespace}/${found.value.name} was deleted. An owner can restore it from the workspace's settings.`);
    }
    if (status?.archived || found.value.archivedAt) {
      return fail("forbidden", `${found.value.namespace}/${found.value.name} is archived, so it is read-only. An owner can unarchive it in its settings.`);
    }
    return null;
  }

  /**
   * Stops every run in a repository that was archived or deleted: the
   * work service marks them stopped when it hears of it, and lists them
   * here (`runs_in_repo`, by id, so a deleted repository's runs are found
   * too), and each sandbox is destroyed. Never throws.
   */
  private async stopRunsIn(repoId: string): Promise<void> {
    try {
      const response = await this.env.WORK.fetch("https://work/rpc/runs_in_repo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoId }),
      });
      if (!response.ok) return;
      const runs = (await response.json()) as { runId: string; sandbox: string | null }[];
      for (const run of runs) {
        if (!run.sandbox) continue;
        try {
          await this.env.SANDBOX.get(this.env.SANDBOX.idFromString(run.sandbox)).halt("The repository was archived or deleted.");
        } catch (error) {
          // Already gone, or never started.
          console.log("sandbox not destroyed", run.runId, String(error));
        }
      }
    } catch (error) {
      console.error("could not stop the runs in", repoId, error);
    }
  }

  private async defaultBranch(repo: RepoPath, viewer: Viewer): Promise<string> {
    const found = await reposClient(this.env.REPOS).get(repo, viewer);
    return found.ok ? found.value.defaultBranch : "main";
  }
}
