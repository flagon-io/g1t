/**
 * The tables of a project's store, in the Durable Object's own SQLite.
 * Each step runs once, in order; the store keeps how many have run.
 *
 * Raw rows (requests, logs, spans, metric points) are kept for the
 * project's retention. `rollups` are per-minute counts of requests by
 * service, environment, deployment and route, with latency and CPU as
 * histograms (./histogram.ts): what the overview's charts read, kept for
 * `ROLLUP_DAYS` whatever the retention. Each minute also has one row of
 * all routes together (method and route `*`), which the charts read.
 */
export const ROLLUP_DAYS = 90;

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE requests (
    id TEXT PRIMARY KEY,
    time_us INTEGER NOT NULL,
    duration_us INTEGER NOT NULL DEFAULT 0,
    trigger TEXT NOT NULL DEFAULT 'fetch',
    method TEXT,
    url TEXT,
    route TEXT,
    status INTEGER,
    outcome TEXT NOT NULL DEFAULT 'ok',
    cpu_ms REAL,
    region TEXT,
    country TEXT,
    trace_id TEXT,
    log_count INTEGER NOT NULL DEFAULT 0,
    error_name TEXT,
    error_message TEXT,
    service TEXT NOT NULL DEFAULT '',
    environment TEXT,
    deployment_id TEXT,
    commit_sha TEXT,
    source TEXT NOT NULL,
    -- Which halves have arrived: the dispatcher's (edge) and the app's.
    edge INTEGER NOT NULL DEFAULT 0,
    app INTEGER NOT NULL DEFAULT 0,
    -- Counted into rollups yet.
    rolled INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX requests_by_time ON requests (time_us);
  CREATE INDEX requests_by_trace ON requests (trace_id);
  CREATE INDEX requests_to_roll ON requests (rolled, time_us);

  CREATE TABLE logs (
    id TEXT PRIMARY KEY,
    time_us INTEGER NOT NULL,
    severity_number INTEGER NOT NULL,
    body TEXT NOT NULL,
    trace_id TEXT,
    span_id TEXT,
    request_id TEXT,
    attributes TEXT NOT NULL DEFAULT '{}',
    service TEXT NOT NULL DEFAULT '',
    environment TEXT,
    deployment_id TEXT,
    commit_sha TEXT,
    source TEXT NOT NULL
  );
  CREATE INDEX logs_by_time ON logs (time_us);
  CREATE INDEX logs_by_trace ON logs (trace_id);
  CREATE INDEX logs_by_request ON logs (request_id);

  CREATE TABLE spans (
    trace_id TEXT NOT NULL,
    span_id TEXT NOT NULL,
    parent_span_id TEXT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    start_us INTEGER NOT NULL,
    duration_us INTEGER NOT NULL,
    status TEXT NOT NULL,
    status_message TEXT,
    attributes TEXT NOT NULL DEFAULT '{}',
    resource TEXT NOT NULL DEFAULT '{}',
    events TEXT NOT NULL DEFAULT '[]',
    links TEXT NOT NULL DEFAULT '[]',
    service TEXT NOT NULL DEFAULT '',
    environment TEXT,
    deployment_id TEXT,
    commit_sha TEXT,
    source TEXT NOT NULL,
    PRIMARY KEY (trace_id, span_id)
  );
  CREATE INDEX spans_by_time ON spans (start_us);

  CREATE TABLE metric_points (
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    time_us INTEGER NOT NULL,
    value REAL,
    count REAL,
    sum REAL,
    min REAL,
    max REAL,
    bounds TEXT,
    counts TEXT,
    quantiles TEXT,
    monotonic INTEGER NOT NULL DEFAULT 0,
    attributes TEXT NOT NULL DEFAULT '{}',
    service TEXT NOT NULL DEFAULT '',
    environment TEXT,
    deployment_id TEXT,
    source TEXT NOT NULL
  );
  CREATE INDEX metric_points_by_name ON metric_points (name, time_us);
  CREATE INDEX metric_points_by_time ON metric_points (time_us);

  CREATE TABLE metric_names (
    name TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    services TEXT NOT NULL DEFAULT '[]',
    last_us INTEGER NOT NULL
  );

  CREATE TABLE rollups (
    minute INTEGER NOT NULL,
    service TEXT NOT NULL,
    environment TEXT NOT NULL DEFAULT '',
    deployment_id TEXT NOT NULL DEFAULT '',
    commit_sha TEXT,
    source TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT '',
    route TEXT NOT NULL DEFAULT '',
    requests INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    s2 INTEGER NOT NULL DEFAULT 0,
    s3 INTEGER NOT NULL DEFAULT 0,
    s4 INTEGER NOT NULL DEFAULT 0,
    s5 INTEGER NOT NULL DEFAULT 0,
    latency TEXT NOT NULL DEFAULT '',
    cpu TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (minute, service, environment, deployment_id, method, route)
  );

  CREATE TABLE error_groups (
    fingerprint TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    message TEXT NOT NULL,
    stack TEXT,
    service TEXT NOT NULL,
    environment TEXT,
    first_us INTEGER NOT NULL,
    last_us INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    first_deployment_id TEXT,
    last_request_id TEXT,
    last_trace_id TEXT,
    state TEXT NOT NULL DEFAULT 'open',
    issue_number INTEGER
  );
  CREATE INDEX error_groups_by_last ON error_groups (last_us);

  CREATE TABLE tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    hint TEXT NOT NULL,
    created_by TEXT,
    created_us INTEGER NOT NULL,
    last_used_us INTEGER,
    managed INTEGER NOT NULL DEFAULT 0,
    -- The deployments' own token is kept so each upload can bind it.
    secret TEXT
  );

  CREATE TABLE exports (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    signals TEXT NOT NULL,
    headers TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_error TEXT,
    last_sent_us INTEGER
  );

  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE usage (
    month TEXT PRIMARY KEY,
    ingested_bytes INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0,
    logs INTEGER NOT NULL DEFAULT 0,
    spans INTEGER NOT NULL DEFAULT 0,
    metric_points INTEGER NOT NULL DEFAULT 0
  );
  `,
  // What arrived each day (UTC), for a free workspace's daily share
  // (../quota.ts). Kept a little over a month.
  `
  CREATE TABLE usage_days (
    day TEXT PRIMARY KEY,
    ingested_bytes INTEGER NOT NULL DEFAULT 0
  );
  `,
  // Issues became work items, numbered in the workspace: an error group
  // links one by that number. One linked before keeps its old issue
  // number, whose address still leads to the work item it became.
  `
  ALTER TABLE error_groups RENAME COLUMN issue_number TO legacy_issue;
  ALTER TABLE error_groups ADD COLUMN item INTEGER;
  `,
];

/**
 * Full-text search over log bodies, made apart from the tables: SQLite
 * builds without FTS5 exist, and logs are still searched (more slowly,
 * with LIKE) without it.
 */
export const FTS = `
  CREATE VIRTUAL TABLE IF NOT EXISTS logs_fts USING fts5(body, content='logs', content_rowid='rowid');
  CREATE TRIGGER IF NOT EXISTS logs_fts_insert AFTER INSERT ON logs BEGIN
    INSERT INTO logs_fts (rowid, body) VALUES (new.rowid, new.body);
  END;
  CREATE TRIGGER IF NOT EXISTS logs_fts_delete AFTER DELETE ON logs BEGIN
    INSERT INTO logs_fts (logs_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  END;
`;
