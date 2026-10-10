/**
 * Datasets: the safe query layer behind dashboards in Artifacts. Mirrors
 * `crates/contracts/src/datasets.rs`; a Rust test keeps the catalog the
 * same and runs both validators over `datasets.fixtures.json`.
 *
 * Not SQL. A query names a dataset from a declared catalog, one measure,
 * at most one dimension to group by, a time interval, filters on declared
 * fields and a range. The service that owns the data (`service` in the
 * catalog) runs it for the viewer, over only what the viewer can read, with
 * a fixed query per measure and dimension, and caps the rows.
 *
 * Values never live in a folio: not in its Yjs document, versions, text,
 * preview, index or templates. Only the query does.
 *
 * Wire shapes are snake_case.
 */

export type DatasetId = "issues" | "pull_requests" | "workflow_runs" | "deployments" | "spend" | "agent_sessions";

export const DATASET_IDS: readonly DatasetId[] = ["issues", "pull_requests", "workflow_runs", "deployments", "spend", "agent_sessions"];

/** How rows are summed up. `count` takes no field; `rate` takes a rate field; the rest a measure field. */
export type DatasetMeasureOp = "count" | "sum" | "avg" | "p50" | "p95" | "rate";
export const DATASET_MEASURE_OPS: readonly DatasetMeasureOp[] = ["count", "sum", "avg", "p50", "p95", "rate"];

export type DatasetInterval = "day" | "week" | "month";
export const DATASET_INTERVALS: readonly DatasetInterval[] = ["day", "week", "month"];

export type DatasetFilterOp = "eq" | "neq" | "in" | "gte" | "lte";
export const DATASET_FILTER_OPS: readonly DatasetFilterOp[] = ["eq", "neq", "in", "gte", "lte"];

export type DatasetRangePreset = "7d" | "30d" | "90d";
export const DATASET_RANGE_PRESETS: readonly DatasetRangePreset[] = ["7d", "30d", "90d"];

/**
 * A time range: a preset counted back from now, or between two times.
 * `from` and `to` are dates (`2026-10-01`) or RFC 3339 UTC times
 * (`2026-10-01T09:00:00Z`); `to` is exclusive.
 */
export type DatasetRange = DatasetRangePreset | { from: string; to: string };

export type DatasetFilter = {
  field: string;
  op: DatasetFilterOp;
  /** Text for `eq`/`neq` on a dimension, a list for `in`, a number on a measure. */
  value: string | number | string[];
};

export type DatasetQuery = {
  dataset: DatasetId;
  measure: { op: DatasetMeasureOp; field?: string | null };
  /** A declared dimension only. */
  group_by?: string | null;
  /** A time series, over the dataset's time field. */
  interval?: DatasetInterval | null;
  /** Which of the dataset's time fields the range and interval use; its first when left out. */
  time?: string | null;
  filters?: DatasetFilter[] | null;
  /** The tile's own range; else the dashboard's. */
  range?: DatasetRange | null;
  /** At most `DATASET_MAX_ROWS`. */
  limit?: number | null;
};

export type DatasetColumnType = "string" | "number" | "time" | "money";

export type DatasetResult = {
  columns: { name: string; type: DatasetColumnType }[];
  rows: (string | number | null)[][];
  /** More rows matched than were returned. */
  truncated: boolean;
  /** The viewer cannot read everything the query covers: shown as "Based on what you can see". */
  partial: boolean;
  /** When the numbers were computed, RFC 3339. */
  as_of: string;
};

/** The services that own datasets, each answering `query_dataset` for its own. */
export type DatasetService = "work" | "actions" | "deployments" | "billing" | "agents";

/** What a viewer needs to query a dataset: membership, or the workspace's billing role. */
export type DatasetNeeds = "member" | "billing";

export type DatasetSpec = {
  label: string;
  service: DatasetService;
  needs: DatasetNeeds;
  /** Time fields, the default first. */
  times: string[];
  /** Fields to group and filter by (text). */
  dimensions: string[];
  /** Number fields for sum, avg, p50, p95, and number filters. */
  measures: string[];
  /** Yes-or-no fields `rate` gives the share of. */
  rates: string[];
};

/** The catalog. One dataset per line: the Rust mirror test reads it that way. */
export const DATASETS: Record<DatasetId, DatasetSpec> = {
  issues: { label: "Issues", service: "work", needs: "member", times: ["created_at", "closed_at"], dimensions: ["repo", "label", "state", "author_kind", "assignee_kind", "milestone"], measures: ["time_to_close_hours", "comments"], rates: ["closed"] },
  pull_requests: { label: "Pull requests", service: "work", needs: "member", times: ["created_at", "merged_at", "closed_at"], dimensions: ["repo", "label", "state", "author_kind", "base_branch"], measures: ["cycle_time_hours", "time_to_first_review_hours", "review_count", "additions", "deletions", "changed_files"], rates: ["merged"] },
  workflow_runs: { label: "Workflow runs", service: "actions", needs: "member", times: ["started_at", "completed_at"], dimensions: ["repo", "workflow", "branch", "event", "conclusion", "runner_kind"], measures: ["duration_seconds", "queue_seconds"], rates: ["succeeded"] },
  deployments: { label: "Deployments", service: "deployments", needs: "member", times: ["created_at"], dimensions: ["repo", "project", "environment", "state"], measures: ["duration_seconds", "time_to_restore_hours"], rates: ["failed"] },
  spend: { label: "Spend", service: "billing", needs: "billing", times: ["day"], dimensions: ["product", "project", "person", "model"], measures: ["amount_micros"], rates: [] },
  agent_sessions: { label: "Agent sessions", service: "agents", needs: "member", times: ["started_at"], dimensions: ["agent", "repo", "outcome", "model", "trigger"], measures: ["duration_seconds", "cost_micros", "tokens"], rates: ["succeeded"] },
};

/** The most rows a query returns. */
export const DATASET_MAX_ROWS = 100;
/** The most filters on one query. */
export const DATASET_MAX_FILTERS = 10;
/** The most values in an `in` filter. */
export const DATASET_MAX_IN_VALUES = 50;
/** The longest `{ from, to }` range, in days. */
export const DATASET_MAX_RANGE_DAYS = 366;

const DAY_MS = 86_400_000;
const TIME = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z)?$/;

/** A range end as milliseconds since the epoch, or null when it is not a real date or RFC 3339 UTC time. */
export function datasetTime(text: string): number | null {
  const match = TIME.exec(text);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const [hour, minute, second] = [Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0)];
  const millis = Number((match[7] ?? "").padEnd(3, "0") || 0);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return Date.UTC(year, month - 1, day, hour, minute, second, millis);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * What is wrong with a query, or null. The same rules, and the same
 * words, as `DatasetQuery::validate` in Rust. It checks the query against
 * the catalog only; who may run it is the owning service's to decide.
 */
export function datasetQueryError(query: DatasetQuery): string | null {
  const spec = DATASETS[query.dataset];
  if (!spec) return `There is no dataset called ${query.dataset}.`;
  const name = query.dataset;
  const { op } = query.measure;
  const field = query.measure.field ?? null;
  if (op === "count") {
    if (field !== null) return "count takes no field.";
  } else if (op === "rate") {
    if (field === null) return "rate needs a field.";
    if (!spec.rates.includes(field)) return `${name} has no yes-or-no field ${field} to take the rate of.`;
  } else {
    if (field === null) return `${op} needs a field.`;
    if (!spec.measures.includes(field)) return `${name} has no number field ${field}.`;
  }
  const groupBy = query.group_by ?? null;
  if (groupBy !== null && !spec.dimensions.includes(groupBy)) return `${name} can't be grouped by ${groupBy}.`;
  const time = query.time ?? null;
  if (time !== null && !spec.times.includes(time)) return `${name} has no time field ${time}.`;
  const filters = query.filters ?? [];
  if (filters.length > DATASET_MAX_FILTERS) return `A query takes at most ${DATASET_MAX_FILTERS} filters.`;
  for (const filter of filters) {
    if (spec.dimensions.includes(filter.field)) {
      if (filter.op === "in") {
        if (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.length > DATASET_MAX_IN_VALUES) {
          return `in on ${filter.field} takes a list of 1 to ${DATASET_MAX_IN_VALUES} values.`;
        }
      } else if (filter.op === "eq" || filter.op === "neq") {
        if (typeof filter.value !== "string") return `${filter.op} on ${filter.field} takes text.`;
      } else {
        return `${filter.field} is text: filter it with eq, neq or in.`;
      }
    } else if (spec.measures.includes(filter.field)) {
      if (filter.op === "in") return `${filter.field} is a number: filter it with eq, neq, gte or lte.`;
      if (typeof filter.value !== "number" || !Number.isFinite(filter.value)) return `${filter.op} on ${filter.field} takes a number.`;
    } else {
      return `${name} can't be filtered by ${filter.field}.`;
    }
  }
  const range = query.range ?? null;
  if (range !== null && typeof range === "object") {
    const from = datasetTime(range.from);
    const to = datasetTime(range.to);
    if (from === null || to === null) return "A range's from and to are dates or RFC 3339 UTC times.";
    if (from >= to) return "A range's from comes before its to.";
    if (to - from > DATASET_MAX_RANGE_DAYS * DAY_MS) return `A range is at most ${DATASET_MAX_RANGE_DAYS} days.`;
  }
  const limit = query.limit ?? null;
  if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > DATASET_MAX_ROWS)) return `limit is between 1 and ${DATASET_MAX_ROWS}.`;
  return null;
}

/** A query from untrusted JSON: well-formed and valid, or why not. Unknown keys are dropped. */
export function parseDatasetQuery(input: unknown): { query: DatasetQuery } | { error: string } {
  if (!isObject(input)) return { error: "A query is an object." };
  if (typeof input.dataset !== "string" || !(DATASET_IDS as readonly string[]).includes(input.dataset)) {
    return { error: `There is no dataset called ${String(input.dataset)}.` };
  }
  const measure = input.measure;
  if (!isObject(measure) || typeof measure.op !== "string" || !(DATASET_MEASURE_OPS as readonly string[]).includes(measure.op)) {
    return { error: "measure.op is count, sum, avg, p50, p95 or rate." };
  }
  if (!optional(measure.field, "string")) return { error: "measure.field is text." };
  if (!optional(input.group_by, "string")) return { error: "group_by is text." };
  if (!optional(input.time, "string")) return { error: "time is text." };
  if (input.interval != null && !(DATASET_INTERVALS as readonly unknown[]).includes(input.interval)) return { error: "interval is day, week or month." };
  if (input.limit != null && typeof input.limit !== "number") return { error: "limit is a number." };
  let filters: DatasetFilter[] | null = null;
  if (input.filters != null) {
    if (!Array.isArray(input.filters)) return { error: "filters is a list." };
    filters = [];
    for (const filter of input.filters) {
      if (!isObject(filter) || typeof filter.field !== "string" || !(DATASET_FILTER_OPS as readonly unknown[]).includes(filter.op)) {
        return { error: "A filter has a field and an op: eq, neq, in, gte or lte." };
      }
      const value = filter.value;
      const ok =
        typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) || (Array.isArray(value) && value.every((item) => typeof item === "string"));
      if (!ok) return { error: "A filter's value is text, a number or a list of text." };
      filters.push({ field: filter.field, op: filter.op as DatasetFilterOp, value: value as DatasetFilter["value"] });
    }
  }
  let range: DatasetRange | null = null;
  if (input.range != null) {
    if (typeof input.range === "string" && (DATASET_RANGE_PRESETS as readonly string[]).includes(input.range)) range = input.range as DatasetRangePreset;
    else if (isObject(input.range) && typeof input.range.from === "string" && typeof input.range.to === "string") range = { from: input.range.from, to: input.range.to };
    else return { error: "range is 7d, 30d, 90d or { from, to }." };
  }
  const query: DatasetQuery = {
    dataset: input.dataset as DatasetId,
    measure: { op: measure.op as DatasetMeasureOp, field: (measure.field as string | null | undefined) ?? null },
    group_by: (input.group_by as string | null | undefined) ?? null,
    interval: (input.interval as DatasetInterval | null | undefined) ?? null,
    time: (input.time as string | null | undefined) ?? null,
    filters,
    range,
    limit: (input.limit as number | null | undefined) ?? null,
  };
  const error = datasetQueryError(query);
  return error ? { error } : { query };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optional(value: unknown, type: "string"): boolean {
  return value === undefined || value === null || typeof value === type;
}
