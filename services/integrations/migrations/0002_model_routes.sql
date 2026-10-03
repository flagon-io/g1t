-- A workspace can connect several model providers and route each kind of
-- work to one of them, or to g1t's hosted models.

-- The models a provider offered when last checked, as a JSON array.
ALTER TABLE connections ADD COLUMN models TEXT;

-- Where each kind of work's model requests go. A kind of work without a
-- row follows `default`; with no `default`, g1t's hosted models.
CREATE TABLE model_routes (
  workspace TEXT NOT NULL,
  -- default, implement, review, plan or update.
  task TEXT NOT NULL,
  -- The workspace's own model connection, or null for g1t's hosted models.
  connection_id TEXT,
  -- The model at that connection; its default model when null.
  model TEXT,
  PRIMARY KEY (workspace, task)
);

-- The model a run's requests are sent to, when its route names one.
ALTER TABLE model_sessions ADD COLUMN model TEXT;
