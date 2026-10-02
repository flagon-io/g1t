import { Container, type StopParams } from "@cloudflare/containers";
import { WorkerEntrypoint } from "cloudflare:workers";

import {
  type Attempt,
  type Intent,
  type Result,
  type RunHostedInput,
  type RunnerApi,
  type ServiceBinding,
  type User,
  type Viewer,
  type WorkApi,
  fail,
  identityClient,
  ok,
} from "@g1t/contracts";

export interface RunnerEnv {
  SANDBOX: DurableObjectNamespace<AttemptSandbox>;
  IDENTITY: ServiceBinding;
  WORK: WorkApi;
  /** Secret. The model key the hosted agent runs on. */
  ANTHROPIC_API_KEY?: string;
  /**
   * Comma-separated usernames allowed to start hosted agents. Runs spend the
   * key above, so this stays an allowlist until accounts bring their own.
   */
  HOSTED_AGENT_USERS: string;
}

const MAX_AGENTS_PER_RUN = 5;
/** A run that takes longer than this has its token expire under it. */
const TOKEN_TTL_SECONDS = 2 * 60 * 60;
const AGENT = "claude-code";

type RunRequest = { actor: User; attemptId: string; envVars: Record<string, string> };

/**
 * One sandbox, for one attempt. The image's entrypoint is the g1t runner,
 * which does the work and exits; this class only starts it and cleans up
 * if it dies without reporting.
 */
export class AttemptSandbox extends Container<RunnerEnv> {
  sleepAfter = "45m";

  async run(request: RunRequest): Promise<void> {
    await this.ctx.storage.put("run", {
      actor: request.actor,
      attemptId: request.attemptId,
    });
    await this.start({ envVars: request.envVars, enableInternet: true });
  }

  override async onStop({ exitCode }: StopParams): Promise<void> {
    if (exitCode === 0) return;
    // The runner abandons its own attempt when it fails. This covers a
    // sandbox that was killed before it could; abandoning twice is refused
    // harmlessly.
    const run = await this.ctx.storage.get<Pick<RunRequest, "actor" | "attemptId">>("run");
    if (run) await this.env.WORK.abandonAttempt(run.actor, run.attemptId);
  }
}

function buildPrompt(intent: Intent, instructions: string): string {
  const parts = [
    "You are a coding agent working in the git repository checked out in the current directory.",
    `Goal: ${intent.title}`,
    intent.brief,
  ];
  if (intent.checks.length > 0) {
    parts.push(
      `These commands must pass when you are done. Run them if the tools are installed:\n${intent.checks.map((check) => `- ${check}`).join("\n")}`,
    );
  }
  if (instructions) parts.push(instructions);
  parts.push(
    "Make the change and keep it focused on the goal. Commit your work with a clear message. Do not push; that is done for you. Finish with a short summary of what you changed and why.",
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

  async available(viewer: Viewer): Promise<boolean> {
    if (!viewer || !this.env.ANTHROPIC_API_KEY) return false;
    return this.env.HOSTED_AGENT_USERS.split(",")
      .map((name) => name.trim())
      .includes(viewer.username);
  }

  async run(
    actor: User,
    intentId: string,
    input: RunHostedInput,
  ): Promise<Result<Attempt[]>> {
    if (!(await this.available(actor))) {
      return fail("forbidden", "Hosted agents are not enabled for your account.");
    }
    const count = Math.min(Math.max(Math.trunc(input.count) || 1, 1), MAX_AGENTS_PER_RUN);
    const identity = identityClient(this.env.IDENTITY);

    const attempts: Attempt[] = [];
    for (let i = 0; i < count; i++) {
      const started = await this.env.WORK.startAttempt(actor, intentId, {
        agent: AGENT,
        runtime: "hosted",
      });
      // The first failure is the answer; later ones mean some already run.
      if (!started.ok) return attempts.length ? ok(attempts) : started;
      const attempt = started.value;
      attempts.push(attempt);

      const found = await this.env.WORK.getAttempt(attempt.id, actor);
      if (!found.ok) return found;
      // The sandbox acts as the person who started it, through a token
      // that only lives as long as a run can.
      const { token } = await identity.createAccessToken(
        actor,
        `Hosted attempt ${attempt.id}`,
        TOKEN_TTL_SECONDS,
      );
      const sandbox = this.env.SANDBOX.get(this.env.SANDBOX.idFromName(attempt.id));
      await sandbox.run({
        actor,
        attemptId: attempt.id,
        envVars: {
          G1T_API: "https://api.g1t.sh",
          G1T_TOKEN: token,
          G1T_USER: actor.username,
          ATTEMPT_ID: attempt.id,
          GIT_REMOTE: `https://g1t.sh/${attempt.fork.namespace}/${attempt.fork.name}.git`,
          COMMIT_MESSAGE: found.value.intent.title,
          PROMPT: buildPrompt(found.value.intent, input.instructions?.trim() ?? ""),
          ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY!,
        },
      });
    }
    return ok(attempts);
  }
}
