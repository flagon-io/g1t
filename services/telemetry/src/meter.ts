/**
 * One workspace's observability, counted across all its projects: what
 * arrived each day (for a free workspace's daily share, ./quota.ts) and
 * each month (for what the plan is charged past the free amount). One
 * Durable Object per workspace (`TelemetryMeter`, ./durable.ts), named by
 * its slug; this is its logic, apart from the object, so tests run it on
 * Node's SQLite.
 *
 * It also remembers the plan billing last said the workspace is on, so a
 * billing that does not answer keeps the cap where it was.
 *
 * A workspace on the plan has its month's total reported to billing
 * (`note_pending`, source `telemetry`) from the object's alarm, a few
 * minutes after it changes, and again until billing takes it. Each report
 * names the month its total belongs to, so one that arrives after the month
 * is over still counts for it (billing takes the month before while it is
 * not charged); the alarm still goes off before the month ends.
 */
import type { Standing } from "./quota.ts";

/** How long after new bytes the month's total is reported. */
export const NOTE_AFTER_MS = 5 * 60_000;
/** How long before the month ends the last report goes. */
const MONTH_END_MARGIN_MS = 60_000;
/** How long before a report billing did not take is tried again. */
export const NOTE_RETRY_MS = 10 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

function day(ms = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function monthOf(ms = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 7);
}
/** The month before `month` (`YYYY-MM`). */
function previousMonth(month: string): string {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number - 2, 1)).toISOString().slice(0, 7);
}
/** The first instant of the month after the one `ms` is in. */
function nextMonth(ms: number): number {
  const at = new Date(ms);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
}

/** When to report next: soon, but before the month is over. */
export function noteAt(now: number, after = NOTE_AFTER_MS): number {
  return Math.max(now + 1000, Math.min(now + after, nextMonth(now) - MONTH_END_MARGIN_MS));
}

type Row = Record<string, SqlStorageValue>;

export class WorkspaceMeter {
  state!: DurableObjectState;
  sql!: SqlStorage;

  constructor(state: DurableObjectState) {
    this.open(state);
  }

  open(state: DurableObjectState) {
    this.state = state;
    this.sql = state.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meter_days (day TEXT PRIMARY KEY, bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meter_months (month TEXT PRIMARY KEY, bytes INTEGER NOT NULL, noted_bytes INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS meter_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  rows(query: string, ...args: SqlStorageValue[]): Row[] {
    return this.sql.exec(query, ...args).toArray() as Row[];
  }

  private meta(key: string): string | null {
    const row = this.rows("SELECT value FROM meter_meta WHERE key = ?", key)[0];
    return row ? String(row.value) : null;
  }

  private setMeta(key: string, value: string) {
    this.sql.exec("INSERT INTO meter_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }

  /** The workspace's slug, as it was last counted under. */
  workspace(): string | null {
    return this.meta("workspace");
  }

  /** The plan billing last said the workspace is on; null if it never has. */
  standing(): Standing | null {
    const value = this.meta("standing");
    return value === "free" || value === "paid" || value === "held" ? value : null;
  }

  setStanding(standing: Standing): void {
    if (standing !== this.standing()) this.setMeta("standing", standing);
  }

  /** Bytes all the workspace's projects sent today (UTC). */
  todayBytes(now = Date.now()): number {
    return Number(this.rows("SELECT bytes FROM meter_days WHERE day = ?", day(now))[0]?.bytes ?? 0);
  }

  /** Bytes all the workspace's projects sent in `month` (`YYYY-MM`), this one by default. */
  monthBytes(month = monthOf()): number {
    return Number(this.rows("SELECT bytes FROM meter_months WHERE month = ?", month)[0]?.bytes ?? 0);
  }

  /** Whether `adding` more today would go past `cap` (null: no cap). */
  over(adding: number, cap: number | null, now = Date.now()): boolean {
    return cap != null && cap >= 0 && this.todayBytes(now) + adding > cap;
  }

  /**
   * Counts what the workspace's projects kept. On the plan, the month's
   * total is reported to billing shortly (`note`, from the alarm).
   */
  async add(workspace: string, bytes: number, now = Date.now()): Promise<void> {
    if (workspace && workspace !== this.workspace()) this.setMeta("workspace", workspace);
    const n = Math.max(0, Math.round(bytes));
    if (!n) return;
    this.sql.exec("INSERT INTO meter_days (day, bytes) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET bytes = bytes + excluded.bytes", day(now), n);
    this.sql.exec("INSERT INTO meter_months (month, bytes) VALUES (?, ?) ON CONFLICT (month) DO UPDATE SET bytes = bytes + excluded.bytes", monthOf(now), n);
    this.sql.exec("DELETE FROM meter_days WHERE day < ?", day(now - 40 * DAY_MS));
    if (this.standing() === "paid" && (await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(noteAt(now));
    }
  }

  /**
   * Reports the month's total to billing with `send`, naming the month,
   * when billing has not heard it, on the plan; tried again later when
   * `send` fails. The month before is reported too while billing has not
   * heard all of it (billing takes it until it charges that month, and
   * answers whether it did); older months are left as last heard.
   */
  async note(send: (workspace: string, month: string, bytes: number) => Promise<boolean>, now = Date.now()): Promise<void> {
    const workspace = this.workspace();
    const current = monthOf(now);
    const previous = previousMonth(current);
    for (const row of this.rows("SELECT month, bytes FROM meter_months WHERE bytes <> noted_bytes AND month < ?", previous)) {
      console.error("telemetry: a month that is over was not reported in full", workspace, row.month, row.bytes);
      this.sql.exec("UPDATE meter_months SET noted_bytes = bytes WHERE month = ?", row.month);
    }
    if (!workspace || this.standing() !== "paid") return;
    let retry = false;
    for (const month of [previous, current]) {
      const row = this.rows("SELECT bytes, noted_bytes FROM meter_months WHERE month = ?", month)[0];
      const bytes = Number(row?.bytes ?? 0);
      if (bytes === Number(row?.noted_bytes ?? 0)) continue;
      const ok = await send(workspace, month, bytes).catch((error: unknown) => {
        console.error("telemetry: usage not reported", workspace, month, String(error));
        return false;
      });
      if (ok) this.sql.exec("UPDATE meter_months SET noted_bytes = ? WHERE month = ?", bytes, month);
      else retry = true;
    }
    if (retry) await this.state.storage.setAlarm(noteAt(now, NOTE_RETRY_MS));
  }
}
