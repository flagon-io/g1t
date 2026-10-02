import { Container, type StopParams } from "@cloudflare/containers";
import { WorkerEntrypoint } from "cloudflare:workers";

import {
  type AgentModel,
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

/** Which pull request a sandbox is working on, and as whom. */
type Run = { actor: User; repo: RepoPath; number: number };
type RunRequest = Run & { envVars: Record<string, string> };

/**
 * One sandbox, for one pull request. The image's entrypoint is the g1t runner,
 * which does the work and exits; this class only starts it and cleans up
 * if it dies without reporting.
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
    // The runner closes its own pull request when it fails. This covers a
    // sandbox that was killed before it could; closing twice is refused
    // harmlessly.
    const run = await this.ctx.storage.get<Run>("run");
    if (run) await workClient(this.env.WORK).closePull(run.actor, run.repo, run.number);
  }
}

type ConfiguredModel = AgentModel & { model: string };

/** Where the sandbox sends model requests, and what it sends with them. */
function modelEnv(env: RunnerEnv, model: ConfiguredModel): Record<string, string> {
  const vars: Record<string, string> = {
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY!,
    ANTHROPIC_MODEL: model.model,
    // Recorded at the top of the session, so anyone can see what ran.
    AGENT_MODEL_NAME: `${model.modelName} (${model.label})`,
  };
  if (env.AI_GATEWAY_ID) {
    vars.ANTHROPIC_BASE_URL = `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/anthropic`;
    if (env.AI_GATEWAY_TOKEN) {
      vars.AI_GATEWAY_TOKEN = env.AI_GATEWAY_TOKEN;
      vars.ANTHROPIC_CUSTOM_HEADERS = `cf-aig-authorization: Bearer ${env.AI_GATEWAY_TOKEN}`;
    }
  }
  return vars;
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
    "Make the change and keep it focused on the issue. Commit your work with a clear message. Do not push; that is done for you. Finish with a short summary of what you changed and why.",
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

  private allowed(viewer: Viewer): boolean {
    if (!viewer || !this.env.ANTHROPIC_API_KEY) return false;
    return this.env.HOSTED_AGENT_USERS.split(",")
      .map((name) => name.trim())
      .includes(viewer.username);
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
        actor,
        repo,
        number: pull.number,
        envVars: {
          G1T_API: "https://api.g1t.sh",
          G1T_TOKEN: token,
          G1T_USER: actor.username,
          G1T_REPO: `${repo.namespace}/${repo.name}`,
          PULL_NUMBER: String(pull.number),
          GIT_REMOTE: `https://g1t.sh/${pull.fork.namespace}/${pull.fork.name}.git`,
          COMMIT_MESSAGE: issue.title,
          PROMPT: prompt,
          ...modelEnv(this.env, model),
        },
      });
    }
    return ok(pulls);
  }
}
