/**
 * The pure parts of an agent's computer (computer.ts): how a command's
 * streamed lines become one transcript, how its end is said in a session's
 * transcript, and how the container's NDJSON is read. No Workers imports,
 * so Node runs the tests on the file as it is.
 */
import type { AgentComputerCommand } from "@g1t/contracts";

/** How much of one command's output a kept transcript holds: `COMPUTER_TRANSCRIPT_BYTES` (@g1t/contracts runner.ts), which computer.ts passes. */
const DEFAULT_TRANSCRIPT_BYTES = 64 * 1024;

/** The object key a computer's saved home is kept under. */
export function homeKey(agentId: string): string {
  return `homes/${agentId}.tar.zst`;
}

/** A command's lines gathered into one transcript, in order, cut at the cap. */
export function gather(lines: { stream: string; line: string }[], cap = DEFAULT_TRANSCRIPT_BYTES): { output: string; truncated: boolean } {
  let output = "";
  let truncated = false;
  for (const entry of lines) {
    const next = output ? `${output}\n${entry.line}` : entry.line;
    if (next.length > cap) {
      truncated = true;
      break;
    }
    output = next;
  }
  return { output, truncated };
}

/** `outcome` for a session's transcript: `exit 0 · 1.2 s`, with what went wrong. */
export function outcomeLine(command: Pick<AgentComputerCommand, "exit_code" | "duration_ms" | "timed_out" | "truncated">): string {
  const seconds = command.duration_ms / 1000;
  const took = seconds < 10 ? `${seconds.toFixed(1)} s` : seconds < 90 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60)} min`;
  return [`exit ${command.exit_code}`, took, command.timed_out ? "timed out" : null, command.truncated ? "output cut" : null].filter(Boolean).join(" · ");
}

/** Byte parts as one array. */
export function concat(parts: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** The lines of an NDJSON body as they arrive, each parsed; lines that aren't JSON objects are skipped. */
export async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (line: string): Record<string, unknown> | null => {
    if (!line.trim()) return null;
    try {
      const value = JSON.parse(line) as unknown;
      return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const parsed = parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (parsed) yield parsed;
    }
  }
  const last = parse(buffer + decoder.decode());
  if (last) yield last;
}

/**
 * What a command's streamed lines and closing line become, as kept: the
 * output with the closing note on its last line, or a line saying the
 * computer stopped answering when there was no closing line.
 */
export function transcriptOf(
  lines: { stream: string; line: string }[],
  closing: { exit_code?: number; duration_ms?: number; truncated?: boolean; timed_out?: boolean; note?: string } | null,
  problem: string | null,
  cap = DEFAULT_TRANSCRIPT_BYTES,
): Pick<AgentComputerCommand, "output" | "truncated" | "timed_out" | "exit_code"> & { duration_ms: number | null } {
  const { output, truncated } = gather(lines, cap);
  const tail = closing ? (closing.note ? `[${closing.note}]` : null) : `[The computer stopped answering${problem ? `: ${problem}` : ""}.]`;
  return {
    output: tail ? `${output}${output ? "\n" : ""}${tail}` : output,
    truncated: truncated || Boolean(closing?.truncated),
    timed_out: Boolean(closing?.timed_out),
    exit_code: typeof closing?.exit_code === "number" ? closing.exit_code : -1,
    duration_ms: typeof closing?.duration_ms === "number" ? closing.duration_ms : null,
  };
}
