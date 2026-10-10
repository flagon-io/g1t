/**
 * An agent's own computer, from the agents service's side
 * (docs.g1t.sh/guides/agents/, "Its computer"). The computer itself is the
 * runner's `AgentComputer` object (services/runner computer.ts), reached
 * through the RUNNER binding; here is what a session's tools call, and what
 * the Computer tab reads and presses.
 *
 * Sessions only: a chat reply never gets these ports, so a quick answer
 * never wakes a machine. Each session works in its own directory under the
 * home, `/home/agent/sessions/<id>`, and shares the home with every other
 * session of the agent. Every command is a `command` entry in the session's
 * transcript (transcript.ts), and is kept on the computer's own page.
 */
import type { AbilitySection, AgentComputerCommand, AgentComputerView, Result, ServiceBinding, User } from "@g1t/contracts";

// Relative, with extensions, so Node runs the tests on this file as it is.
import { runnerComputerClient } from "../../../packages/contracts/src/clients.ts";
import { fail, ok } from "../../../packages/contracts/src/result.ts";
import { canChange, canSeeAgent } from "./access.ts";
import type { Row } from "./store.ts";
import type { ComputerPorts } from "./tools.ts";

export type ComputerEnv = { RUNNER?: ServiceBinding };

/** The home on the computer, and where a session's work goes by default. */
export const COMPUTER_HOME = "/home/agent";
export function sessionCwd(sessionId: string): string {
  return `${COMPUTER_HOME}/sessions/${sessionId}`;
}

/** Whether the agent's abilities give it a computer this turn: shell or files, ready and not Never. */
export function hasComputer(sections: AbilitySection[]): boolean {
  return sections.some((section) => section.group === "computer" && section.sources.some((source) => source.abilities.some((ability) => ability.status === "ready" && ability.level !== "never")));
}

const NOT_HERE = "Agents' computers aren't available on this installation.";

/**
 * The ports a session's tool box calls (tools.ts `useComputer`): each
 * command names the agent, its workspace and who asked, so the runner
 * meters the machine time to them; `onCommand` is told of every command
 * that ran, for the transcript.
 */
export function computerPorts(
  env: ComputerEnv,
  input: { agent: Row; workspace: string; session: { id: string }; asker: { username: string | null }; onCommand: (command: AgentComputerCommand) => void },
): ComputerPorts | null {
  if (!env.RUNNER) return null;
  const runner = runnerComputerClient(env.RUNNER);
  const who = { agent_id: input.agent.id, workspace: input.workspace, agent_handle: input.agent.handle, asked_by: input.asker.username };
  const cwd = sessionCwd(input.session.id);
  const outcome = <T, U>(result: Result<T>, map: (value: T) => U) => (result.ok ? { ok: true as const, value: map(result.value) } : { ok: false as const, code: result.error.code, message: result.error.message });
  return {
    cwd,
    async exec(cmd, dir, timeoutSeconds) {
      const ran = await runner.computerExec({ ...who, cmd, cwd: dir ?? cwd, timeout_seconds: timeoutSeconds, session_id: input.session.id });
      if (ran.ok) input.onCommand(ran.value.command);
      return outcome(ran, (value) => value.command);
    },
    async readFile(path) {
      return outcome(await runner.computerReadFile({ ...who, path, session_id: input.session.id }), (value) => value);
    },
    async writeFile(path, text) {
      return outcome(await runner.computerWriteFile({ ...who, path, text, session_id: input.session.id }), (value) => value);
    },
  };
}

// ── The Computer tab ──────────────────────────────────────────────────────

/** What the views need: the workspace, the viewer, and the agents' database. */
export type ComputerCtx = { env: ComputerEnv; db: D1Database; slug: string; workspaceId: string; viewer: User };

/** The agent by handle, if the viewer may see it: a personal agent only its member and the owners. */
async function agentRow(ctx: ComputerCtx, handle: unknown): Promise<Row | null> {
  const row = await ctx.db
    .prepare("SELECT * FROM agents WHERE workspace_id = ? AND handle = ? AND archived_at IS NULL")
    .bind(ctx.workspaceId, String(handle ?? "").trim().replace(/^@/, "").toLowerCase())
    .first<Row>();
  return row && canSeeAgent(ctx.viewer, ctx.slug, row) ? row : null;
}

const NO_AGENT = (handle: unknown) => fail("not_found", `There is no agent called @${String(handle ?? "")}.`);

async function view(ctx: ComputerCtx, row: Row): Promise<Result<AgentComputerView>> {
  if (!ctx.env.RUNNER) return fail("unavailable", NOT_HERE);
  const runner = runnerComputerClient(ctx.env.RUNNER);
  const [status, commands] = await Promise.all([runner.computerStatus(row.id), runner.computerCommands(row.id, null)]);
  if (!status.ok) return status;
  return ok({ status: status.value, commands: commands.ok ? commands.value : [], can_manage: canChange(ctx.viewer, ctx.slug, row) });
}

/** The agent's computer: its state, disk and recent commands, for anyone who may see the agent. */
export async function computerView(ctx: ComputerCtx, handle: unknown): Promise<Result<AgentComputerView>> {
  const row = await agentRow(ctx, handle);
  if (!row) return NO_AGENT(handle);
  return view(ctx, row);
}

/** The agent, if the viewer may act on its computer: owners a workspace agent's, its member a personal one's. */
async function managed(ctx: ComputerCtx, handle: unknown): Promise<Result<Row>> {
  const row = await agentRow(ctx, handle);
  if (!row) return NO_AGENT(handle);
  if (!canChange(ctx.viewer, ctx.slug, row)) return fail("forbidden", row.scope === "personal" ? "Only the person whose personal agent this is can manage its computer." : "Only the workspace's owners wake, sleep or reset an agent's computer.");
  if (!ctx.env.RUNNER) return fail("unavailable", NOT_HERE);
  return ok(row);
}

export async function wakeComputer(ctx: ComputerCtx, handle: unknown): Promise<Result<AgentComputerView>> {
  const row = await managed(ctx, handle);
  if (!row.ok) return row;
  const woke = await runnerComputerClient(ctx.env.RUNNER!).computerWake({ agent_id: row.value.id, workspace: ctx.slug, agent_handle: row.value.handle, asked_by: ctx.viewer.username });
  if (!woke.ok) return woke;
  return view(ctx, row.value);
}

export async function sleepComputer(ctx: ComputerCtx, handle: unknown): Promise<Result<AgentComputerView>> {
  const row = await managed(ctx, handle);
  if (!row.ok) return row;
  const slept = await runnerComputerClient(ctx.env.RUNNER!).computerSleep(row.value.id);
  if (!slept.ok) return slept;
  return view(ctx, row.value);
}

export async function resetComputer(ctx: ComputerCtx, handle: unknown): Promise<Result<AgentComputerView>> {
  const row = await managed(ctx, handle);
  if (!row.ok) return row;
  const reset = await runnerComputerClient(ctx.env.RUNNER!).computerReset(row.value.id);
  if (!reset.ok) return reset;
  return view(ctx, row.value);
}

/** The computer's recent commands, newest first; `sessionId` narrows them to one session's. */
export async function computerCommands(ctx: ComputerCtx, handle: unknown, sessionId: unknown): Promise<Result<AgentComputerCommand[]>> {
  const row = await agentRow(ctx, handle);
  if (!row) return NO_AGENT(handle);
  if (!ctx.env.RUNNER) return fail("unavailable", NOT_HERE);
  return runnerComputerClient(ctx.env.RUNNER).computerCommands(row.id, typeof sessionId === "string" && sessionId ? sessionId : null);
}

/** An archived agent's computer: its disk is kept 30 days, then deleted. Never fails the archive. */
export async function forgetComputer(env: ComputerEnv, agentId: string): Promise<void> {
  if (!env.RUNNER) return;
  await runnerComputerClient(env.RUNNER)
    .computerForget(agentId)
    .catch((error: unknown) => console.error("agents: an archived agent's computer was not told", agentId, String(error)));
}
