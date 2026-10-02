import { WorkerEntrypoint } from "cloudflare:workers";

import {
  type Attempt,
  type EventsApi,
  type G1tEvent,
  type Intent,
  type IntentDetail,
  type IntentStatus,
  type NewEvent,
  type NewSessionEntry,
  type OpenIntentInput,
  type RepoPath,
  type ReposApi,
  type Result,
  type SessionEntry,
  type StartAttemptInput,
  type User,
  type Viewer,
  type WorkApi,
  UNVERIFIED,
  fail,
  newId,
  ok,
} from "@g1t/contracts";

import {
  type AttemptRow,
  type IntentRow,
  type SessionRow,
  toAttempt,
  toIntent,
  toSessionEntry,
} from "./rows";

export interface WorkEnv {
  DB: D1Database;
  REPOS: ReposApi;
  EVENTS: EventsApi;
}

const SOURCE = "work";
const MAX_ENTRY_BATCH = 200;
const MAX_ENTRY_CHARS = 64_000;
const SESSION_PAGE = 500;

const INTENT_COLUMNS = `intents.*,
  (SELECT count(*) FROM attempts WHERE attempts.intent_id = intents.id) AS attempt_count`;

const NO_INTENT = fail("not_found", "Intent not found.");
const NO_ATTEMPT = fail("not_found", "Attempt not found.");
const SIGN_IN = fail("unauthenticated", "Sign in to do that.");

export default class WorkService
  extends WorkerEntrypoint<WorkEnv>
  implements WorkApi
{
  private get db(): D1Database {
    return this.env.DB;
  }

  private async intentById(id: string): Promise<Intent | null> {
    const row = await this.db
      .prepare(`SELECT ${INTENT_COLUMNS} FROM intents WHERE id = ?`)
      .bind(id)
      .first<IntentRow>();
    return row ? toIntent(row) : null;
  }

  private async attemptById(id: string): Promise<Attempt | null> {
    const row = await this.db
      .prepare("SELECT * FROM attempts WHERE id = ?")
      .bind(id)
      .first<AttemptRow>();
    return row ? toAttempt(row) : null;
  }

  /** The attempt, if `actor` is the one running it. */
  private async ownAttempt(actor: User, id: string): Promise<Result<Attempt>> {
    const attempt = await this.attemptById(id);
    if (!attempt) return NO_ATTEMPT;
    // Reading it must be allowed before "forbidden" may reveal it exists.
    const repo = await this.env.REPOS.getById(attempt.repoId, actor);
    if (!repo.ok) return NO_ATTEMPT;
    if (attempt.startedBy.id !== actor.id) {
      return fail("forbidden", "Only the person who started an attempt can change it.");
    }
    return ok(attempt);
  }

  private publish(...events: NewEvent[]): Promise<void> {
    return this.env.EVENTS.publish(events);
  }

  async openIntent(
    actor: User,
    repoPath: RepoPath,
    input: OpenIntentInput,
  ): Promise<Result<Intent>> {
    if (!actor.verified) return UNVERIFIED;
    const title = input.title.trim();
    const brief = input.brief.trim();
    if (!title) return fail("invalid", "An intent needs a title.");
    const repo = await this.env.REPOS.get(repoPath, actor);
    if (!repo.ok) return repo;
    const checks = (input.checks ?? []).map((check) => check.trim()).filter(Boolean);

    const id = newId("int");
    // Numbering and insert are one statement, so concurrent opens on the
    // same repo cannot take the same number.
    await this.db
      .prepare(
        `INSERT INTO intents
           (id, repo_id, number, title, brief, checks, author_id, author_name, created_at)
         SELECT ?, ?, COALESCE(MAX(number), 0) + 1, ?, ?, ?, ?, ?, ?
         FROM intents WHERE repo_id = ?`,
      )
      .bind(
        id,
        repo.value.id,
        title,
        brief,
        JSON.stringify(checks),
        actor.id,
        actor.username,
        Date.now(),
        repo.value.id,
      )
      .run();
    const intent = (await this.intentById(id))!;
    await this.publish({
      type: "intent.opened",
      source: SOURCE,
      repoId: intent.repoId,
      actor: actor.id,
      data: {
        intentId: intent.id,
        repoId: intent.repoId,
        number: intent.number,
        title: intent.title,
      },
    });
    return ok(intent);
  }

  async listIntents(
    repoPath: RepoPath,
    viewer: Viewer,
    status?: IntentStatus,
  ): Promise<Result<Intent[]>> {
    const repo = await this.env.REPOS.get(repoPath, viewer);
    if (!repo.ok) return repo;
    const { results } = await this.db
      .prepare(
        `SELECT ${INTENT_COLUMNS} FROM intents
         WHERE repo_id = ? AND (? IS NULL OR status = ?)
         ORDER BY number DESC LIMIT 100`,
      )
      .bind(repo.value.id, status ?? null, status ?? null)
      .all<IntentRow>();
    return ok(results.map(toIntent));
  }

  async getIntent(
    repoPath: RepoPath,
    number: number,
    viewer: Viewer,
  ): Promise<Result<IntentDetail>> {
    const repo = await this.env.REPOS.get(repoPath, viewer);
    if (!repo.ok) return repo;
    const row = await this.db
      .prepare(
        `SELECT ${INTENT_COLUMNS} FROM intents WHERE repo_id = ? AND number = ?`,
      )
      .bind(repo.value.id, number)
      .first<IntentRow>();
    if (!row) return NO_INTENT;
    const attempts = await this.db
      .prepare("SELECT * FROM attempts WHERE intent_id = ? ORDER BY number")
      .bind(row.id)
      .all<AttemptRow>();
    return ok({ intent: toIntent(row), attempts: attempts.results.map(toAttempt) });
  }

  async withdrawIntent(actor: User, intentId: string): Promise<Result<Intent>> {
    const intent = await this.intentById(intentId);
    if (!intent) return NO_INTENT;
    const repo = await this.env.REPOS.getById(intent.repoId, actor);
    if (!repo.ok) return NO_INTENT;
    if (intent.author.id !== actor.id && repo.value.ownerId !== actor.id) {
      return fail("forbidden", "Only the author or the repo owner can withdraw an intent.");
    }
    if (intent.status !== "open") {
      return fail("conflict", `This intent is already ${intent.status}.`);
    }
    await this.db
      .prepare("UPDATE intents SET status = 'withdrawn' WHERE id = ?")
      .bind(intent.id)
      .run();
    await this.publish({
      type: "intent.closed",
      source: SOURCE,
      repoId: intent.repoId,
      actor: actor.id,
      data: { intentId: intent.id, repoId: intent.repoId, reason: "withdrawn" },
    });
    return ok({ ...intent, status: "withdrawn" });
  }

  async startAttempt(
    actor: User,
    intentId: string,
    input: StartAttemptInput,
  ): Promise<Result<Attempt>> {
    if (!actor.verified) return UNVERIFIED;
    const intent = await this.intentById(intentId);
    if (!intent) return NO_INTENT;
    if (intent.status !== "open") {
      return fail("conflict", `This intent is already ${intent.status}.`);
    }
    const agent = input.agent.trim() || "agent";

    const id = newId("att");
    const fork = await this.env.REPOS.forkForAttempt(intent.repoId, id, actor);
    if (!fork.ok) return fork.error.code === "not_found" ? NO_INTENT : fork;

    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO attempts
           (id, intent_id, repo_id, number, agent, runtime, fork_repo_id,
            fork_namespace, fork_name, started_by_id, started_by_name,
            created_at, updated_at)
         SELECT ?, ?, ?, COALESCE(MAX(number), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM attempts WHERE intent_id = ?`,
      )
      .bind(
        id,
        intent.id,
        intent.repoId,
        agent,
        input.runtime,
        fork.value.id,
        fork.value.namespace,
        fork.value.name,
        actor.id,
        actor.username,
        now,
        now,
        intent.id,
      )
      .run();
    const attempt = (await this.attemptById(id))!;
    await this.publish({
      type: "attempt.started",
      source: SOURCE,
      repoId: intent.repoId,
      actor: actor.id,
      data: {
        attemptId: attempt.id,
        intentId: intent.id,
        repoId: intent.repoId,
        agent: attempt.agent,
      },
    });
    return ok(attempt);
  }

  async getAttempt(
    attemptId: string,
    viewer: Viewer,
  ): Promise<Result<{ attempt: Attempt; intent: Intent }>> {
    const attempt = await this.attemptById(attemptId);
    if (!attempt) return NO_ATTEMPT;
    const repo = await this.env.REPOS.getById(attempt.repoId, viewer);
    if (!repo.ok) return NO_ATTEMPT;
    return ok({ attempt, intent: (await this.intentById(attempt.intentId))! });
  }

  private async setStatus(
    actor: User,
    attemptId: string,
    status: "submitted" | "abandoned",
    summary: string | null,
  ): Promise<Result<Attempt>> {
    const own = await this.ownAttempt(actor, attemptId);
    if (!own.ok) return own;
    const attempt = own.value;
    if (attempt.status !== "working" && attempt.status !== "submitted") {
      return fail("conflict", `This attempt is already ${attempt.status}.`);
    }
    const now = Date.now();
    await this.db
      .prepare(
        "UPDATE attempts SET status = ?, summary = COALESCE(?, summary), updated_at = ? WHERE id = ?",
      )
      .bind(status, summary, now, attempt.id)
      .run();
    const ids = {
      attemptId: attempt.id,
      intentId: attempt.intentId,
      repoId: attempt.repoId,
    };
    await this.publish(
      status === "submitted"
        ? { type: "attempt.submitted", source: SOURCE, repoId: attempt.repoId, actor: actor.id, data: ids }
        : { type: "attempt.updated", source: SOURCE, repoId: attempt.repoId, actor: actor.id, data: { ...ids, status } },
    );
    return ok({
      ...attempt,
      status,
      summary: summary ?? attempt.summary,
      updatedAt: now,
    });
  }

  submitAttempt(actor: User, attemptId: string, summary: string): Promise<Result<Attempt>> {
    return this.setStatus(actor, attemptId, "submitted", summary.trim() || null);
  }

  abandonAttempt(actor: User, attemptId: string): Promise<Result<Attempt>> {
    return this.setStatus(actor, attemptId, "abandoned", null);
  }

  async listActiveAttempts(
    viewer: Viewer,
  ): Promise<{ attempt: Attempt; intent: Intent }[]> {
    if (!viewer) return [];
    const { results } = await this.db
      .prepare(
        `SELECT * FROM attempts
         WHERE started_by_id = ? AND status IN ('working', 'submitted')
         ORDER BY updated_at DESC LIMIT 50`,
      )
      .bind(viewer.id)
      .all<AttemptRow>();
    return Promise.all(
      results.map(async (row) => ({
        attempt: toAttempt(row),
        intent: (await this.intentById(row.intent_id))!,
      })),
    );
  }

  async appendSession(
    actor: User,
    attemptId: string,
    entries: NewSessionEntry[],
  ): Promise<Result<{ count: number }>> {
    if (!actor) return SIGN_IN;
    if (entries.length === 0) return ok({ count: 0 });
    if (entries.length > MAX_ENTRY_BATCH) {
      return fail("invalid", `Send at most ${MAX_ENTRY_BATCH} entries at a time.`);
    }
    const own = await this.ownAttempt(actor, attemptId);
    if (!own.ok) return own;
    const attempt = own.value;

    const now = Date.now();
    // Each insert takes the next sequence number itself, so two writers
    // appending at once cannot collide.
    const insert = this.db.prepare(
      `INSERT INTO session_entries (attempt_id, seq, kind, text, tool, "commit", at)
       SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?
       FROM session_entries WHERE attempt_id = ?`,
    );
    await this.db.batch([
      ...entries.map((entry) =>
        insert.bind(
          attempt.id,
          entry.kind,
          entry.text.slice(0, MAX_ENTRY_CHARS),
          entry.tool ?? null,
          entry.commit ?? attempt.headCommit,
          entry.at ?? now,
          attempt.id,
        ),
      ),
      this.db
        .prepare("UPDATE attempts SET updated_at = ? WHERE id = ?")
        .bind(now, attempt.id),
    ]);
    await this.publish({
      type: "session.appended",
      source: SOURCE,
      repoId: attempt.repoId,
      actor: actor.id,
      data: { attemptId: attempt.id, sessionId: attempt.id, count: entries.length },
    });
    return ok({ count: entries.length });
  }

  async readSession(
    attemptId: string,
    viewer: Viewer,
    afterSeq = 0,
  ): Promise<Result<SessionEntry[]>> {
    const found = await this.getAttempt(attemptId, viewer);
    if (!found.ok) return found;
    const { results } = await this.db
      .prepare(
        "SELECT * FROM session_entries WHERE attempt_id = ? AND seq > ? ORDER BY seq LIMIT ?",
      )
      .bind(attemptId, afterSeq, SESSION_PAGE)
      .all<SessionRow>();
    return ok(results.map(toSessionEntry));
  }

  /** A push to an attempt's fork moves that attempt's head. */
  async onEvents(events: G1tEvent[]): Promise<void> {
    for (const event of events) {
      if (event.type !== "git.push") continue;
      await this.db
        .prepare(
          "UPDATE attempts SET head_commit = ?, updated_at = ? WHERE fork_repo_id = ?",
        )
        .bind(event.data.after, event.time, event.data.repoId)
        .run();
    }
  }

  async queue(batch: MessageBatch<G1tEvent>): Promise<void> {
    await this.onEvents(batch.messages.map((message) => message.body));
  }
}
