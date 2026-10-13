/**
 * Search embeddings, as billing sees them. Every passage embedded is
 * counted in `doc_embed_usage` (src/indexer.ts, tokens estimated as
 * characters / 4). Every quarter hour (wrangler.jsonc `triggers`) each
 * workspace's month so far goes to billing (`note_pending`, source
 * `context`, the price book's `embedding_tokens`) at Workers AI's price:
 * billing charges the plan once the month is over and covers a free
 * workspace's itself (services/billing storage.rs `COVERED_FOR_FREE`).
 *
 * So that g1t's cover has an end, a workspace without the plan embeds at
 * most `FREE_EMBED_TOKENS_PER_MONTH` a month; past it, its passages are
 * kept for words, and embedded once a month starts or it takes the plan.
 * The plan is the one billing last said (`workspace_billing.plan`); a
 * workspace billing has said nothing about yet is held like a free one.
 *
 * Billing knows workspaces by slug and this service keeps usage by id, so
 * each workspace's slug is noted when the service looks it up.
 */
import type { ServiceBinding } from "@g1t/contracts";

/** Embedding tokens a workspace without the plan may use a month: about 20 MB of text. */
export const FREE_EMBED_TOKENS_PER_MONTH = 5_000_000;

/** What Workers AI charges g1t a million embedding tokens, when the price book cannot be read ($0.067). */
export const EMBEDDING_MICROS_PER_MILLION_TOKENS = 67_000;

/** Workspaces whose slug this isolate has noted already. */
const noted = new Set<string>();

/** `2026-10`. */
export const monthOf = (now: Date) => now.toISOString().slice(0, 7);

/** Notes which slug a workspace id is, once per isolate. Never throws. */
export async function rememberWorkspace(db: D1Database, workspace: { id: string; slug: string } | null): Promise<void> {
  if (!workspace?.id || !workspace.slug) return;
  const key = `${workspace.id}:${workspace.slug}`;
  if (noted.has(key)) return;
  try {
    await db
      .prepare(
        `INSERT INTO workspace_billing (workspace_id, slug) VALUES (?1, ?2)
         ON CONFLICT (workspace_id) DO UPDATE SET slug = excluded.slug WHERE slug <> excluded.slug`,
      )
      .bind(workspace.id, workspace.slug.toLowerCase())
      .run();
    noted.add(key);
  } catch (error) {
    console.error("could not note the workspace's slug", workspace.id, String(error));
  }
}

/** Embedding tokens the workspace used in `month`. */
export async function monthTokens(db: D1Database, workspaceId: string, month: string): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(tokens), 0) AS tokens FROM doc_embed_usage WHERE workspace_id = ? AND hour >= ? AND hour < ?")
    .bind(workspaceId, month, `${month}~`)
    .first<{ tokens: number }>();
  return Number(row?.tokens ?? 0);
}

/**
 * Whether the workspace has used its free month: only without the plan
 * (or before billing has said which it is on).
 */
export async function overFreeBudget(db: D1Database, workspaceId: string, now: Date, budget = FREE_EMBED_TOKENS_PER_MONTH): Promise<boolean> {
  const plan = await db.prepare("SELECT plan FROM workspace_billing WHERE workspace_id = ?").bind(workspaceId).first<{ plan: string | null }>();
  if (plan?.plan === "paid") return false;
  return (await monthTokens(db, workspaceId, monthOf(now))) >= budget;
}

/** What `tokens` cost g1t at `microsPerMillion`, rounded up. */
export function embeddingCost(tokens: number, microsPerMillion: number): number {
  return Math.ceil((Math.max(0, tokens) / 1_000_000) * microsPerMillion);
}

/** For the Billing page: `1.2 million tokens`. */
export function embeddingDetail(tokens: number): string {
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)} million tokens` : `${tokens.toLocaleString("en-US")} tokens`;
}

type Billing = {
  freeWorkspaces(workspaces: string[]): Promise<string[]>;
  prices(): Promise<{ prices: { meter: string; costMicros: number }[] }>;
  notePending(workspace: string, source: "context", costMicros: number, detail?: string | null, month?: string | null): Promise<boolean>;
};

/** The month before `month` (`2026-10` → `2026-09`). */
export function previousMonth(month: string): string {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number - 2, 1)).toISOString().slice(0, 7);
}

type MonthRow = { workspace_id: string; tokens: number; slug: string | null; noted_month: string | null; noted_tokens: number | null; month: string };

/**
 * Reports each workspace's month of embedding tokens that changed since
 * it was last reported, naming the month the total is for, and learns
 * which of them are on the plan. A workspace whose slug is not known yet
 * waits for the next run. Once a month is over, its last tokens still go
 * as that month's for a workspace last reported in it (billing takes the
 * month before until it charges it). Never throws.
 */
export async function reportEmbeddings(db: D1Database, billing: Billing, now = new Date()): Promise<{ reported: number; unknown: number }> {
  const month = monthOf(now);
  const previous = previousMonth(month);
  const totals = (of: string) =>
    db
      .prepare(
        `SELECT u.workspace_id AS workspace_id, SUM(u.tokens) AS tokens, b.slug AS slug, b.noted_month AS noted_month, b.noted_tokens AS noted_tokens, ?1 AS month
         FROM doc_embed_usage u LEFT JOIN workspace_billing b ON b.workspace_id = u.workspace_id
         WHERE u.hour >= ?1 AND u.hour < ?2
         GROUP BY u.workspace_id`,
      )
      .bind(of, `${of}~`)
      .all<MonthRow>();
  const [last, rows] = await Promise.all([totals(previous), totals(month)]);
  // Last month's end: only for workspaces last reported in it, so a month
  // reported in full (or never) is not sent again.
  const ended = last.results.filter((r) => r.slug && r.noted_month === previous && Number(r.noted_tokens ?? 0) !== Number(r.tokens ?? 0));
  const known = rows.results.filter((r) => r.slug);
  const unknown = rows.results.length - known.length;
  if (unknown) console.log("embedding usage of workspaces not looked up yet waits", unknown);
  if (!known.length) return { reported: 0, unknown };
  // Which are free, so the budget holds; when billing does not answer, the plan it last said.
  try {
    const free = new Set((await billing.freeWorkspaces(known.map((r) => r.slug!))).map((s) => s.toLowerCase()));
    const at = now.toISOString();
    const updates = known.map((r) =>
      db.prepare("UPDATE workspace_billing SET plan = ?, plan_at = ? WHERE workspace_id = ?").bind(free.has(r.slug!) ? "free" : "paid", at, r.workspace_id),
    );
    for (let i = 0; i < updates.length; i += 50) await db.batch(updates.slice(i, i + 50));
  } catch (error) {
    console.error("could not tell which workspaces are free; keeping what billing last said", String(error));
  }
  const book = await billing.prices().catch(() => null);
  const perMillion = book?.prices.find((p) => p.meter === "embedding_tokens")?.costMicros ?? EMBEDDING_MICROS_PER_MILLION_TOKENS;
  let reported = 0;
  for (const r of [...ended, ...known]) {
    const tokens = Number(r.tokens ?? 0);
    if (r.noted_month === r.month && Number(r.noted_tokens ?? 0) === tokens) continue;
    try {
      // Any answer is billing's to keep (a month it has charged is refused
      // for good); only a failure to reach it is tried again.
      await billing.notePending(r.slug!, "context", embeddingCost(tokens, perMillion), embeddingDetail(tokens), r.month);
      await db
        .prepare("UPDATE workspace_billing SET noted_month = ?, noted_tokens = ?, noted_at = ? WHERE workspace_id = ?")
        .bind(r.month, tokens, now.toISOString(), r.workspace_id)
        .run();
      reported++;
    } catch (error) {
      // Tried again on the next run.
      console.error("embedding usage not reported", r.slug, tokens, String(error));
    }
  }
  return { reported, unknown };
}

/** Billing, as `reportEmbeddings` uses it. */
export async function billingFor(service: ServiceBinding): Promise<Billing> {
  // Loaded here, so the rules above test under Node without the contracts' runtime.
  const { billingClient } = await import("@g1t/contracts");
  return billingClient(service) as unknown as Billing;
}
