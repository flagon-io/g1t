/**
 * An agent's own computer (docs.g1t.sh/guides/agents/, "Its computer"):
 * one Durable Object per workspace agent, named `computer:<agent_id>`, in
 * front of one container whose process is the runner in `MODE=computer`
 * (crates/runner computer.rs).
 *
 * It is a persistent home, not an always-on machine. Awake, the container
 * runs and its seconds are metered as agent sandbox time, attributed to
 * the agent and to whoever asked for the session that woke it. Ten minutes
 * after the last command with nothing running, the home (`/home/agent`) is
 * saved to object storage as one tar+zstd (`HOMES`, R2 on g1t's cloud,
 * streamed up in parts, never buffered whole) and the container stops.
 * Waking restores the home into a fresh container. Reset wipes the home;
 * an archived agent's home is kept `COMPUTER_KEEP_DAYS` and then deleted
 * by an alarm.
 *
 * Without `HOMES` (the bucket not made yet on an installation) everything
 * works, but the home is forgotten at every sleep, and the status says so
 * (`disk_attached: false`).
 *
 * Every wake, sleep and reset is written to the workspace's audit log, as
 * the agents service writes its own entries.
 */
import { Container, type StopParams } from "@cloudflare/containers";

import {
  type AgentComputerCommand,
  type AgentComputerState,
  type AgentComputerStatus,
  type ComputerExecArgs,
  type ComputerExecResult,
  type ComputerWakeArgs,
  type Result,
  COMPUTER_DISK_CAP_BYTES,
  COMPUTER_IDLE_MINUTES,
  COMPUTER_KEEP_DAYS,
  COMPUTER_TRANSCRIPT_BYTES,
  COMPUTER_TRANSCRIPTS_KEPT,
  ComputeGate,
  actualMicros,
  billingClient,
  fail,
  ok,
  sandboxEstimateMicros,
} from "@g1t/contracts";

import { concat, homeKey, ndjson, transcriptOf } from "./computer-shape";
import { describeError } from "./lifecycle";
import type { RunnerEnv } from "./index";

export { gather, homeKey, outcomeLine } from "./computer-shape";

/** The port the container's supervisor listens on (crates/runner computer.rs `PORT`). */
export const COMPUTER_PORT = 8787;
/** How long a wake is reserved for with billing before it starts: the first stretch awake. */
const RESERVE_MINUTES = 30;
/** Snapshots over the cap are refused; this many refusals in a row and the computer stops unsaved. */
const MAX_FAILED_SNAPSHOTS = 6;
/** Each part of a snapshot's multipart upload (R2 asks for at least 5 MiB, the last part excepted). */
const PART_BYTES = 8 * 1024 * 1024;
/** How long one command may be waited on end to end, past its own timeout. */
const EXEC_GRACE_MS = 15_000;

/** What billing reserved for a stretch awake, settled when it sleeps. */
type Held = { id: string; workspace: string; microsPerSecond: number };

/** Everything the object keeps about its computer. */
type Kept = {
  agentId: string;
  workspace: string | null;
  agentHandle: string | null;
  askedBy: string | null;
  state: AgentComputerState;
  since: string;
  lastWokeAt: string | null;
  lastSleptAt: string | null;
  snapshotBytes: number | null;
  snapshotAt: string | null;
  diskUsedBytes: number;
  problem: string | null;
  deleteAfter: string | null;
  /** When the current stretch awake started, for the meter; null when not awake. */
  meterStarted: number | null;
  reservation: Held | null;
  token: string | null;
  failedSnapshots: number;
};

const iso = () => new Date().toISOString();

/** One gate per isolate, as the sandboxes keep. */
let gate: ComputeGate | null = null;

/** The computer's status as reported, from what is kept. */
export function statusOf(kept: Kept, attached: boolean): AgentComputerStatus {
  return {
    agent_id: kept.agentId,
    state: kept.state,
    since: kept.since,
    disk_used_bytes: kept.diskUsedBytes,
    disk_cap_bytes: COMPUTER_DISK_CAP_BYTES,
    last_woke_at: kept.lastWokeAt,
    last_slept_at: kept.lastSleptAt,
    snapshot_bytes: kept.snapshotBytes,
    snapshot_at: kept.snapshotAt,
    where: "g1t_cloud",
    disk_attached: attached,
    problem: kept.problem,
    delete_after: kept.deleteAfter,
  };
}

export class AgentComputer extends Container<RunnerEnv> {
  defaultPort = COMPUTER_PORT;
  // Idle: this long after the last request to the container (every command
  // is one), `onActivityExpired` saves the home and stops it.
  sleepAfter = `${COMPUTER_IDLE_MINUTES}m`;

  /** Commands running now: a busy computer is not put to sleep for idleness. */
  private running = 0;
  /** A wake in progress, so two commands arriving together start one container. */
  private waking: Promise<Result<AgentComputerStatus>> | null = null;

  private get attached(): boolean {
    return Boolean(this.env.HOMES);
  }

  private async kept(agentId: string): Promise<Kept> {
    const found = await this.ctx.storage.get<Kept>("computer");
    if (found) return found;
    const fresh: Kept = {
      agentId,
      workspace: null,
      agentHandle: null,
      askedBy: null,
      state: "asleep",
      since: iso(),
      lastWokeAt: null,
      lastSleptAt: null,
      snapshotBytes: null,
      snapshotAt: null,
      diskUsedBytes: 0,
      problem: null,
      deleteAfter: null,
      meterStarted: null,
      reservation: null,
      token: null,
      failedSnapshots: 0,
    };
    await this.ctx.storage.put("computer", fresh);
    return fresh;
  }

  private async save(kept: Kept): Promise<void> {
    await this.ctx.storage.put("computer", kept);
  }

  /** A request to the container's supervisor, with its token. */
  private async call(kept: Kept, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers ?? {});
    if (kept.token) headers.set("authorization", `Bearer ${kept.token}`);
    return this.containerFetch(`http://computer${path}`, { ...init, headers }, COMPUTER_PORT);
  }

  // ── Status ──────────────────────────────────────────────────────────────

  async status(agentId: string): Promise<AgentComputerStatus> {
    const kept = await this.kept(agentId);
    if (kept.state === "awake") {
      const health = await this.call(kept, "/health").then((r) => (r.ok ? r.json<{ disk_used_bytes?: number }>() : null)).catch(() => null);
      if (health && typeof health.disk_used_bytes === "number") {
        kept.diskUsedBytes = health.disk_used_bytes;
        await this.save(kept);
      }
    }
    return statusOf(kept, this.attached);
  }

  async commands(agentId: string, sessionId: string | null = null): Promise<AgentComputerCommand[]> {
    await this.kept(agentId);
    const all = (await this.ctx.storage.get<AgentComputerCommand[]>("commands")) ?? [];
    return sessionId ? all.filter((command) => command.session_id === sessionId) : all;
  }

  // ── Waking ──────────────────────────────────────────────────────────────

  async wake(args: ComputerWakeArgs): Promise<Result<AgentComputerStatus>> {
    if (this.waking) return this.waking;
    this.waking = this.doWake(args).finally(() => {
      this.waking = null;
    });
    return this.waking;
  }

  private async doWake(args: ComputerWakeArgs): Promise<Result<AgentComputerStatus>> {
    const kept = await this.kept(args.agent_id);
    if (kept.state === "awake") return ok(statusOf(kept, this.attached));
    if (kept.state === "sleeping") return fail("conflict", "The computer is going to sleep; try again in a moment.");
    const workspace = args.workspace.toLowerCase();
    // Its workspace's plan says whether it may run, and what is reserved.
    gate ??= new ComputeGate(this.env.BILLING);
    const [microsPerSecond, ent] = await Promise.all([gate.microsPerSecond(), gate.entitlements(workspace)]);
    const admission = await gate.admit(
      {
        workspace,
        repo: { namespace: workspace, name: `agents/${args.agent_handle}` },
        public: false,
        kind: "agent",
        estimateMicros: sandboxEstimateMicros(RESERVE_MINUTES, microsPerSecond),
        // Its model is metered by the agents service; this is machine time only.
        hostedModel: false,
      },
      ent,
    );
    if (!admission.ok) return fail("payment_required", admission.message);
    kept.workspace = workspace;
    kept.agentHandle = args.agent_handle;
    kept.askedBy = args.asked_by ?? null;
    kept.reservation = admission.reservation ? { id: admission.reservation.id, workspace, microsPerSecond } : null;
    kept.token = crypto.randomUUID();
    kept.state = "waking";
    kept.since = iso();
    kept.problem = null;
    await this.save(kept);
    try {
      await this.startAndWaitForPorts(COMPUTER_PORT, undefined, {
        envVars: { MODE: "computer", G1T_COMPUTER_TOKEN: kept.token, ...(this.env.ABUSE_WATCH === "off" ? { G1T_ABUSE: "off" } : {}) },
        enableInternet: true,
      });
    } catch (error) {
      console.error("computer not started", args.agent_id, describeError(error));
      await this.release(kept);
      kept.state = "asleep";
      kept.since = iso();
      kept.problem = `The computer could not start: ${describeError(error)}`;
      await this.save(kept);
      return fail("unavailable", "The computer could not start just now. Try again in a moment.");
    }
    // The meter runs from the moment the container is up, restore included.
    kept.meterStarted = Date.now();
    await this.save(kept);
    await this.restore(kept);
    kept.state = "awake";
    kept.since = iso();
    kept.lastWokeAt = kept.since;
    await this.save(kept);
    this.audit(kept, "computer_wake", `Woke @${kept.agentHandle}'s computer${kept.snapshotAt ? ", restoring its home" : " with a fresh home"}.`);
    return ok(await this.status(args.agent_id));
  }

  /** Puts the saved home back into a container that just started. */
  private async restore(kept: Kept): Promise<void> {
    if (!this.env.HOMES || !kept.snapshotAt) return;
    try {
      const object = await this.env.HOMES.get(homeKey(kept.agentId));
      if (!object) {
        kept.snapshotAt = null;
        kept.snapshotBytes = null;
        return;
      }
      const response = await this.call(kept, "/restore", { method: "POST", body: object.body, headers: { "content-type": "application/zstd" } });
      if (!response.ok) throw new Error(`restore answered ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`);
      const answer = await response.json<{ disk_used_bytes?: number }>().catch((): { disk_used_bytes?: number } => ({}));
      if (typeof answer.disk_used_bytes === "number") kept.diskUsedBytes = answer.disk_used_bytes;
    } catch (error) {
      console.error("computer home not restored", kept.agentId, describeError(error));
      kept.problem = "Its saved home could not be restored this time, so it woke with a fresh one. The saved home is kept for the next wake.";
    }
  }

  /** A wake that admitted and then failed gives back what was reserved. */
  private async release(kept: Kept): Promise<void> {
    if (!kept.reservation) return;
    gate ??= new ComputeGate(this.env.BILLING);
    await gate.settle(kept.reservation.id, 0);
    kept.reservation = null;
  }

  /** Awake, or why not. */
  private async awake(args: ComputerWakeArgs): Promise<Result<Kept>> {
    const kept = await this.kept(args.agent_id);
    if (kept.state !== "awake") {
      const woke = await this.wake(args);
      if (!woke.ok) return woke;
    }
    return ok(await this.kept(args.agent_id));
  }

  // ── Commands and files ─────────────────────────────────────────────────

  async exec(args: ComputerExecArgs): Promise<Result<ComputerExecResult>> {
    const cmd = String(args.cmd ?? "").trim();
    if (!cmd) return fail("invalid", "Give the command to run.");
    const ready = await this.awake(args);
    if (!ready.ok) return ready;
    const kept = ready.value;
    const timeout = Math.max(1, Math.min(1800, Math.floor(Number(args.timeout_seconds ?? 120)) || 120));
    const startedAt = iso();
    this.running++;
    const lines: { stream: string; line: string }[] = [];
    let closing: { exit_code?: number; duration_ms?: number; truncated?: boolean; timed_out?: boolean; note?: string } | null = null;
    let problem: string | null = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout * 1000 + EXEC_GRACE_MS);
      try {
        const response = await this.call(kept, "/exec", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cmd, cwd: args.cwd ?? null, timeout_seconds: timeout }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          const text = await response.text().catch(() => "");
          let message = text;
          try {
            message = (JSON.parse(text) as { message?: string }).message ?? text;
          } catch {
            // Plain text, kept as it is.
          }
          return fail("invalid", message || `The computer answered ${response.status}.`);
        }
        for await (const line of ndjson(response.body)) {
          if (typeof line.exit_code === "number") closing = line as unknown as typeof closing;
          else if (typeof line.line === "string") lines.push({ stream: String(line.stream ?? "stdout"), line: line.line });
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      problem = describeError(error);
      console.error("computer exec failed", kept.agentId, problem);
    } finally {
      this.running--;
    }
    const shaped = transcriptOf(lines, closing, problem, COMPUTER_TRANSCRIPT_BYTES);
    const command: AgentComputerCommand = {
      id: `cmd_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
      session_id: args.session_id ?? null,
      asked_by: args.asked_by ?? kept.askedBy,
      started_at: startedAt,
      cmd,
      cwd: args.cwd?.trim() || "/home/agent",
      exit_code: shaped.exit_code,
      duration_ms: shaped.duration_ms ?? Math.max(0, Date.now() - Date.parse(startedAt)),
      output: shaped.output,
      truncated: shaped.truncated,
      timed_out: shaped.timed_out,
    };
    const all = (await this.ctx.storage.get<AgentComputerCommand[]>("commands")) ?? [];
    await this.ctx.storage.put("commands", [command, ...all].slice(0, COMPUTER_TRANSCRIPTS_KEPT));
    return ok({ command, status: await this.status(kept.agentId) });
  }

  async readFile(args: ComputerWakeArgs & { path: string }): Promise<Result<{ path: string; text: string; bytes: number }>> {
    const path = String(args.path ?? "").trim();
    if (!path) return fail("invalid", "Give the file's path under the home.");
    const ready = await this.awake(args);
    if (!ready.ok) return ready;
    const response = await this.call(ready.value, `/files?path=${encodeURIComponent(path)}`).catch((error: unknown) => {
      console.error("computer read failed", args.agent_id, describeError(error));
      return null;
    });
    if (!response) return fail("unavailable", "The computer didn't answer.");
    if (response.status === 404) return fail("not_found", `There is no file at ${path}.`);
    if (!response.ok) return fail("invalid", await said(response));
    const bytes = new Uint8Array(await response.arrayBuffer());
    return ok({ path, text: new TextDecoder().decode(bytes), bytes: bytes.byteLength });
  }

  async writeFile(args: ComputerWakeArgs & { path: string; text: string }): Promise<Result<{ path: string; bytes: number }>> {
    const path = String(args.path ?? "").trim();
    if (!path) return fail("invalid", "Give the file's path under the home.");
    const ready = await this.awake(args);
    if (!ready.ok) return ready;
    const body = new TextEncoder().encode(String(args.text ?? ""));
    const response = await this.call(ready.value, `/files?path=${encodeURIComponent(path)}`, { method: "PUT", body, headers: { "content-type": "application/octet-stream" } }).catch((error: unknown) => {
      console.error("computer write failed", args.agent_id, describeError(error));
      return null;
    });
    if (!response) return fail("unavailable", "The computer didn't answer.");
    if (!response.ok) return fail("invalid", await said(response));
    return ok({ path, bytes: body.byteLength });
  }

  // ── Sleeping ────────────────────────────────────────────────────────────

  async sleep(agentId: string): Promise<Result<AgentComputerStatus>> {
    const kept = await this.kept(agentId);
    if (kept.state === "asleep") return ok(statusOf(kept, this.attached));
    if (kept.state !== "awake") return fail("conflict", `The computer is ${kept.state}; try again in a moment.`);
    if (this.running > 0) return fail("conflict", "A command is still running. It sleeps once the command ends and it has been idle for ten minutes.");
    kept.state = "sleeping";
    kept.since = iso();
    await this.save(kept);
    const saved = await this.snapshot(kept);
    if (!saved.ok) {
      kept.failedSnapshots++;
      kept.problem = saved.error.message;
      if (kept.failedSnapshots < MAX_FAILED_SNAPSHOTS) {
        kept.state = "awake";
        kept.since = iso();
        await this.save(kept);
        // Another try at the next idle expiry.
        this.renewActivityTimeout();
        return fail("conflict", saved.error.message);
      }
      kept.problem = `${saved.error.message} It was stopped without saving after ${MAX_FAILED_SNAPSHOTS} tries, so changes since its last save are gone.`;
    } else {
      kept.failedSnapshots = 0;
      kept.problem = null;
    }
    await this.save(kept);
    await this.call(kept, "/stop", { method: "POST" }).catch(() => null);
    await this.stop().catch(() => undefined);
    await this.stopped(0, "asked");
    this.audit(kept, "computer_sleep", `Put @${kept.agentHandle}'s computer to sleep${saved.ok ? ", home saved" : " without saving its home"}.`);
    return ok(statusOf((await this.kept(agentId))!, this.attached));
  }

  /** Streams the home out of the container and up to object storage, in parts. */
  private async snapshot(kept: Kept): Promise<Result<null>> {
    const bucket = this.env.HOMES;
    if (!bucket) {
      // Nothing to save to: the home is forgotten, and the status says so.
      kept.snapshotAt = null;
      kept.snapshotBytes = null;
      return ok(null);
    }
    let response: Response;
    try {
      response = await this.call(kept, "/snapshot", { method: "POST" });
    } catch (error) {
      return fail("unavailable", `The home could not be read for saving: ${describeError(error)}`);
    }
    if (response.status === 413) return fail("invalid", await said(response));
    if (!response.ok || !response.body) return fail("unavailable", `The home could not be saved: the computer answered ${response.status}.`);
    const upload = await bucket.createMultipartUpload(homeKey(kept.agentId));
    const parts: R2UploadedPart[] = [];
    let total = 0;
    try {
      let held: Uint8Array[] = [];
      let size = 0;
      const flush = async () => {
        const part = concat(held, size);
        held = [];
        size = 0;
        parts.push(await upload.uploadPart(parts.length + 1, part));
      };
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        held.push(value);
        size += value.byteLength;
        total += value.byteLength;
        if (size >= PART_BYTES) await flush();
      }
      if (size > 0 || parts.length === 0) await flush();
      await upload.complete(parts);
    } catch (error) {
      await upload.abort().catch(() => undefined);
      return fail("unavailable", `The home could not be saved: ${describeError(error)}`);
    }
    kept.snapshotBytes = total;
    kept.snapshotAt = iso();
    const used = Number(response.headers.get("x-g1t-disk-used"));
    if (Number.isFinite(used) && used > 0) kept.diskUsedBytes = used;
    return ok(null);
  }

  /**
   * Everything the end of a stretch awake does, once: the meter, the
   * reservation, the state. From `sleep`, and from `onStop` when the
   * container went by itself.
   */
  private async stopped(exitCode: number, how: "asked" | "exit"): Promise<void> {
    const kept = await this.ctx.storage.get<Kept>("computer");
    if (!kept) return;
    if (kept.meterStarted != null) {
      const seconds = Math.max(1, Math.ceil((Date.now() - kept.meterStarted) / 1000));
      const recorded = await billingClient(this.env.BILLING)
        .recordSandbox({
          workspace: kept.workspace ?? "",
          seconds,
          description: `@${kept.agentHandle ?? "agent"}'s computer, awake`,
          repo: null,
          reference: `computer/${kept.agentId}/${kept.meterStarted}`,
          kind: "agent",
          selfHosted: false,
          instance: null,
          agent: kept.agentHandle,
          askedBy: kept.askedBy,
        })
        .catch((error: unknown) => ({ ok: false as const, error: { message: String(error) } }));
      if (!recorded.ok) console.log("computer time not recorded", kept.workspace, seconds, recorded.error.message);
      if (kept.reservation) {
        gate ??= new ComputeGate(this.env.BILLING);
        await gate.settle(kept.reservation.id, actualMicros(seconds, kept.reservation.microsPerSecond, 0));
      }
      kept.meterStarted = null;
      kept.reservation = null;
    }
    if (how === "exit" && (kept.state === "awake" || kept.state === "waking")) {
      kept.problem = `The computer stopped by itself (exit ${exitCode}); changes since its last save are gone.`;
    }
    if (kept.state !== "asleep") {
      kept.state = "asleep";
      kept.since = iso();
      kept.lastSleptAt = kept.since;
    }
    kept.token = null;
    await this.save(kept);
  }

  /**
   * Idle for `sleepAfter`: save and stop, unless a command is running, in
   * which case look again later. Never `super`, which would stop the
   * container without saving.
   */
  override async onActivityExpired(): Promise<void> {
    const kept = await this.ctx.storage.get<Kept>("computer");
    if (!kept || kept.state !== "awake") return;
    if (this.running > 0) {
      this.renewActivityTimeout();
      return;
    }
    const slept = await this.sleep(kept.agentId);
    if (!slept.ok) console.log("computer not put to sleep", kept.agentId, slept.error.message);
  }

  override async onStop({ exitCode, reason }: StopParams): Promise<void> {
    const kept = await this.ctx.storage.get<Kept>("computer");
    if (kept?.state === "asleep" && kept.meterStarted == null) return;
    console.log("computer stopped", kept?.agentId, "exit", exitCode, reason);
    await this.stopped(exitCode, "exit");
  }

  override onError(error: unknown): void {
    console.error("computer container error", this.ctx.id.toString(), describeError(error));
  }

  override async alarm(alarmProps?: AlarmInvocationInfo): Promise<void> {
    try {
      await super.alarm(alarmProps);
    } catch (error) {
      console.error("computer alarm failed", this.ctx.id.toString(), `retry ${alarmProps?.retryCount ?? 0}`, describeError(error));
      throw error;
    }
  }

  // ── Reset and forgetting ───────────────────────────────────────────────

  async reset(agentId: string): Promise<Result<AgentComputerStatus>> {
    const kept = await this.kept(agentId);
    if (kept.state !== "asleep") {
      await this.destroy().catch((error: unknown) => console.log("computer not destroyed for reset", agentId, describeError(error)));
      await this.stopped(0, "asked");
    }
    if (this.env.HOMES) await this.env.HOMES.delete(homeKey(agentId)).catch((error: unknown) => console.log("computer home not deleted", agentId, describeError(error)));
    await this.ctx.storage.delete("commands");
    const fresh = (await this.kept(agentId))!;
    fresh.snapshotAt = null;
    fresh.snapshotBytes = null;
    fresh.diskUsedBytes = 0;
    fresh.problem = null;
    fresh.failedSnapshots = 0;
    fresh.state = "asleep";
    fresh.since = iso();
    await this.save(fresh);
    this.audit(fresh, "computer_reset", `Reset @${fresh.agentHandle ?? "agent"}'s computer: its home was wiped.`);
    return ok(statusOf(fresh, this.attached));
  }

  /** The agent was archived: its home is kept `COMPUTER_KEEP_DAYS`, then deleted. */
  async forget(agentId: string): Promise<Result<AgentComputerStatus>> {
    const kept = await this.kept(agentId);
    if (kept.state === "awake") await this.sleep(agentId);
    const fresh = (await this.kept(agentId))!;
    fresh.deleteAfter = new Date(Date.now() + COMPUTER_KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await this.save(fresh);
    await this.schedule(COMPUTER_KEEP_DAYS * 24 * 60 * 60, "purge");
    return ok(statusOf(fresh, this.attached));
  }

  /** The alarm after `forget`: the disk and everything kept here go. */
  async purge(): Promise<void> {
    const kept = await this.ctx.storage.get<Kept>("computer");
    if (!kept?.deleteAfter || Date.parse(kept.deleteAfter) > Date.now()) return;
    if (kept.state !== "asleep") await this.destroy().catch(() => undefined);
    if (this.env.HOMES) await this.env.HOMES.delete(homeKey(kept.agentId)).catch(() => undefined);
    await this.ctx.storage.deleteAll();
  }

  /** An entry in the workspace's audit log, as the agents service writes them. Never fails the call. */
  private audit(kept: Kept, action: string, message: string): void {
    if (!this.env.EVENTS || !kept.workspace) return;
    const entry = {
      actorKind: "agent",
      actor: kept.agentHandle ?? kept.agentId,
      actorId: kept.agentId,
      agent: kept.agentHandle,
      onBehalfOf: kept.askedBy,
      runId: null,
      runKind: null,
      credentialId: null,
      action,
      surface: "web",
      workspace: kept.workspace,
      repo: null,
      number: null,
      gitRef: null,
      path: `agents/${kept.agentHandle ?? kept.agentId}/computer`,
      outcome: "allowed",
      rule: "owner",
      result: "ok",
      message,
      requestId: `req_${crypto.randomUUID()}`,
    };
    this.ctx.waitUntil(
      this.env.EVENTS.fetch("https://service/rpc/audit_record", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entries: [entry] }) })
        .then((response) => {
          if (!response.ok) throw new Error(`status ${response.status}`);
        })
        .catch((error: unknown) => console.error("computer audit entry not recorded", action, kept.agentId, String(error))),
    );
  }
}

/** A JSON error body's `message`, or the status. */
async function said(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    return (JSON.parse(text) as { message?: string }).message ?? `The computer answered ${response.status}.`;
  } catch {
    return text || `The computer answered ${response.status}.`;
  }
}

