/**
 * A session's transcript (`agent_session_events`): one statement per entry,
 * appended in order. Here on its own so that whatever writes an entry
 * (sessions, cards, the computer) needs nothing else from sessions.ts.
 */
import type { AgentComputerCommand, SessionEvent } from "@g1t/contracts";

const iso = () => new Date().toISOString();

/** Appends to a session's transcript. */
export function eventStatement(db: D1Database, id: string, kind: SessionEvent["kind"], by: string | null, body: string, tool: string | null = null, outcome: string | null = null): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO agent_session_events (session_id, seq, kind, by_name, body, tool, outcome, created_at)
       SELECT ?1, COALESCE(MAX(seq), 0) + 1, ?2, ?3, ?4, ?5, ?6, ?7 FROM agent_session_events WHERE session_id = ?1`,
    )
    .bind(id, kind, by, body.slice(0, 20_000), tool, outcome, iso());
}

/** How much of a command's output a session's transcript keeps: the page shows it folded. */
const COMMAND_OUTPUT_CHARS = 8_000;

/** `outcome` for a command: `exit 0 · 1.2 s`, with what went wrong. */
export function commandOutcome(command: Pick<AgentComputerCommand, "exit_code" | "duration_ms" | "timed_out" | "truncated">): string {
  const seconds = command.duration_ms / 1000;
  const took = seconds < 10 ? `${seconds.toFixed(1)} s` : seconds < 90 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60)} min`;
  return [`exit ${command.exit_code}`, took, command.timed_out ? "timed out" : null, command.truncated ? "output cut" : null].filter(Boolean).join(" · ");
}

/**
 * A command the agent ran on its computer, as the transcript keeps it: the
 * command on the first line, then its output (cut), the directory as
 * `tool`, and how it ended as `outcome`.
 */
export function commandEvent(db: D1Database, sessionId: string, by: string, command: AgentComputerCommand): D1PreparedStatement {
  const output = command.output.length > COMMAND_OUTPUT_CHARS ? `${command.output.slice(0, COMMAND_OUTPUT_CHARS)}\n[cut: ${command.output.length - COMMAND_OUTPUT_CHARS} more characters]` : command.output;
  return eventStatement(db, sessionId, "command", by, `${command.cmd.split("\n")[0].slice(0, 500)}\n${output}`, command.cwd, commandOutcome(command));
}
