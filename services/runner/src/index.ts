import { Container, type StopParams } from "@cloudflare/containers";
import { WorkerEntrypoint } from "cloudflare:workers";

import {
  type AgentModel,
  type CheckJob,
  type G1tEvent,
  type Issue,
  type Pull,
  type RepoPath,
  type Result,
  type RunHostedInput,
  type RunnerApi,
  type ServiceBinding,
  type User,
  type Viewer,
  fail,
  identityClient,
  ok,
  workClient,
} from "@g1t/contracts";

import { type ConfiguredModel, modelEnv } from "./model-env";

export interface RunnerEnv {
  SANDBOX: DurableObjectNamespace<AttemptSandbox>;
  IDENTITY: ServiceBinding;
  WORK: ServiceBinding;
  /** Secret. The model key the hosted agent runs on. */
  ANTHROPIC_API_KEY?: string;
  /**
   * Comma-separated usernames allowed to start hosted agents. Runs spend the
   * key above, so this stays an allowlist until accounts bring their own.
   */
  HOSTED_AGENT_USERS: string;
  /**
   * The models offered, as JSON:
   * `[{ id, label, description, modelName, model }]`. `modelName` is what
   * people see; `model` is the identifier sent to the provider.
   */
  AGENT_MODELS: string;
  /**
   * A Cloudflare AI Gateway id. When set, model traffic goes through that
   * gateway, which is where logging, spend limits, caching and fallback
   * between providers are configured. Empty sends it to the provider
   * directly.
   */
  AI_GATEWAY_ID: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  /** Secret. Needed only if the gateway requires authentication. */
  AI_GATEWAY_TOKEN?: string;
}

const MAX_AGENTS_PER_RUN = 5;
/** A run that takes longer than this has its token expire under it. */
const TOKEN_TTL_SECONDS = 2 * 60 * 60;
/** How g1t's own agent is labelled. What runs behind it is g1t's choice. */
const AGENT = "g1t-agent";

/**
 * What a sandbox is doing: an agent working on a pull request as someone,
 * or a run of acceptance checks.
 */
type Run =
  | { kind: "agent"; actor: User; repo: RepoPath; number: number }
  | { kind: "checks"; runId: string; token: string };
type RunRequest = Run & { envVars: Record<string, string> };

/** Long enough to clone, install and test; then the token stops working. */
const CHECKS_TOKEN_TTL_SECONDS = 45 * 60;

/**
 * One sandbox, for one agent or one run of checks. The image's entrypoint
 * is the g1t runner, which does the work and exits; this class only starts
 * it and cleans up if it dies without reporting.
 */
export class AttemptSandbox extends Container<RunnerEnv> {
  sleepAfter = "45m";

  async run(request: RunRequest): Promise<void> {
    const { envVars, ...run } = request;
    await this.ctx.storage.put("run", run);
    await this.start({ envVars, enableInternet: true });
  }

  override async onStop({ exitCode }: StopParams): Promise<void> {
    if (exitCode === 0) return;
    const run = await this.ctx.storage.get<Run>("run");
    if (!run) return;
    const work = workClient(this.env.WORK);
    if (run.kind === "checks") {
      // Refused harmlessly if the run did report before it stopped.
      await work.reportChecks(run.runId, run.token, {
        error: "The sandbox stopped before the checks finished.",
      });
      return;
    }
    // The runner closes its own pull request when it fails. This covers a
    // sandbox that was killed before it could; closing twice is refused
    // harmlessly.
    await work.closePull(run.actor, run.repo, run.number);
  }
}

function buildPrompt(issue: Issue, instructions: string): string {
  const parts = [
    "You are a coding agent working in the git repository checked out in the current directory.",
    `Issue #${issue.number}: ${issue.title}`,
    issue.body,
  ];
  if (issue.checks.length > 0) {
    parts.push(
      `These commands must pass when you are done. Run them if the tools are installed:\n${issue.checks.map((check) => `- ${check}`).join("\n")}`,
    );
  }
  if (instructions) parts.push(instructions);
  parts.push(
    "Make the change and keep it focused on the issue. Commit your work with a clear message. Do not push; that is done for you. Finish with a short summary of what you changed and why. It becomes the description of your pull request, so write it for a reviewer and leave out whether anything was committed or pushed.",
  );
  return parts.filter(Boolean).join("\n\n");
}

export default class RunnerService
  extends WorkerEntrypoint<RunnerEnv>
  implements RunnerApi
{
  /** A Worker must have an event handler; this service is RPC-only. */
  fetch(): Response {
    return new Response("Not found\n", { status: 404 });
  }

  private configuredModels(): ConfiguredModel[] {
    return JSON.parse(this.env.AGENT_MODELS);
  }

  /** Whether sandboxes may be started on this person's say-so. */
  private enabledFor(username: string): boolean {
    return this.env.HOSTED_AGENT_USERS.split(",")
      .map((name) => name.trim())
      .includes(username);
  }

  private allowed(viewer: Viewer): boolean {
    if (!viewer || !this.env.ANTHROPIC_API_KEY) return false;
    return this.enabledFor(viewer.username);
  }

  /** Events from the bus: a pull request was opened, became ready, or moved. */
  async queue(batch: MessageBatch<G1tEvent>): Promise<void> {
    for (const message of batch.messages) {
      const event = message.body;
      // A pull request opened from a branch is ready from the start; one
      // opened as a draft is refused below until it is marked ready.
      if (
        event.type === "pull.opened" ||
        event.type === "pull.ready" ||
        event.type === "pull.updated"
      ) {
        await this.startChecks(event.data.pullId);
      }
      message.ack();
    }
  }

  /**
   * Runs a pull request's acceptance checks in a sandbox of its own. Does
   * nothing when there is nothing to run.
   */
  private async startChecks(pullId: string): Promise<boolean> {
    const work = workClient(this.env.WORK);
    const started = await work.startChecks(pullId);
    if (!started.ok) return false;
    const job: CheckJob = started.value;
    // Checks are commands one person wrote, run against code another
    // pushed, on g1t's machines. In the preview they run only when one of
    // the two is someone sandboxes are enabled for.
    if (!this.enabledFor(job.requestedBy) && !this.enabledFor(job.author.username)) {
      await work.reportChecks(job.runId, job.token, { skip: true });
      return false;
    }
    // To read the commit, which may be private, as the one who pushed it.
    const { token } = await identityClient(this.env.IDENTITY).createAccessToken(
      job.author,
      `Checks on ${job.repo.namespace}/${job.repo.name}#${job.number}`,
      CHECKS_TOKEN_TTL_SECONDS,
    );
    const sandbox = this.env.SANDBOX.get(this.env.SANDBOX.idFromName(job.runId));
    await sandbox.run({
      kind: "checks",
      runId: job.runId,
      token: job.token,
      envVars: {
        MODE: "checks",
        G1T_API: "https://api.g1t.sh",
        CHECK_RUN: job.runId,
        CHECK_TOKEN: job.token,
        G1T_USER: job.author.username,
        G1T_TOKEN: token,
        GIT_REMOTE: `https://g1t.sh/${job.source.namespace}/${job.source.name}.git`,
        GIT_COMMIT: job.commit,
        CHECKS: JSON.stringify(job.commands),
      },
    });
    return true;
  }

  async recheck(actor: User, repo: RepoPath, number: number): Promise<Result<boolean>> {
    const found = await workClient(this.env.WORK).getPull(repo, number, actor);
    if (!found.ok) return found;
    const { pull } = found.value;
    const member = (actor.workspaces ?? []).some(
      (membership) => membership.slug === repo.namespace,
    );
    if (!member && pull.author.id !== actor.id) {
      return fail(
        "forbidden",
        "Only whoever opened a pull request, or a member of the workspace, can run its checks.",
      );
    }
    return (await this.startChecks(pull.id))
      ? ok(true)
      : fail("conflict", "There are no checks to run for this pull request right now.");
  }

  async models(viewer: Viewer): Promise<AgentModel[]> {
    if (!this.allowed(viewer)) return [];
    return this.configuredModels().map(({ id, label, description, modelName }) => ({
      id,
      label,
      description,
      modelName,
    }));
  }

  async run(
    actor: User,
    repo: RepoPath,
    issueNumber: number,
    input: RunHostedInput,
  ): Promise<Result<Pull[]>> {
    if (!this.allowed(actor)) {
      return fail("forbidden", "g1t agents are not enabled for your account.");
    }
    const models = this.configuredModels();
    const model = input.model
      ? models.find((candidate) => candidate.id === input.model)
      : models[0];
    if (!model) return fail("invalid", "That model is not available.");
    const count = Math.min(Math.max(Math.trunc(input.count) || 1, 1), MAX_AGENTS_PER_RUN);
    const identity = identityClient(this.env.IDENTITY);
    const work = workClient(this.env.WORK);

    const found = await work.getIssue(repo, issueNumber, actor);
    if (!found.ok) return found;
    const { issue } = found.value;
    const prompt = buildPrompt(issue, input.instructions?.trim() ?? "");

    const pulls: Pull[] = [];
    for (let i = 0; i < count; i++) {
      const opened = await work.openPull(actor, repo, {
        issue: issue.number,
        agent: AGENT,
        runtime: "hosted",
      });
      // The first failure is the answer; later ones mean some already run.
      if (!opened.ok) return pulls.length ? ok(pulls) : opened;
      const pull = opened.value;
      // Opened without a branch, so it has a fork.
      const fork = pull.fork!;
      pulls.push(pull);

      // The sandbox acts as the person who started it, through a token
      // that only lives as long as a run can.
      const { token } = await identity.createAccessToken(
        actor,
        `g1t agent on ${repo.namespace}/${repo.name}#${pull.number}`,
        TOKEN_TTL_SECONDS,
      );
      const sandbox = this.env.SANDBOX.get(this.env.SANDBOX.idFromName(pull.id));
      await sandbox.run({
        kind: "agent",
        actor,
        repo,
        number: pull.number,
        envVars: {
          G1T_API: "https://api.g1t.sh",
          G1T_TOKEN: token,
          G1T_USER: actor.username,
          G1T_REPO: `${repo.namespace}/${repo.name}`,
          PULL_NUMBER: String(pull.number),
          GIT_REMOTE: `https://g1t.sh/${fork.namespace}/${fork.name}.git`,
          COMMIT_MESSAGE: issue.title,
          PROMPT: prompt,
          ...modelEnv(this.env, model),
        },
      });
    }
    return ok(pulls);
  }
}
