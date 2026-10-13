-- Search embeddings, reported to billing (src/embed-billing.ts): each
-- workspace's month of embedding tokens (`doc_embed_usage`) goes to
-- billing as source `context` at Workers AI's price, and a workspace
-- without the plan is held to a monthly token budget.
--
-- Usage is kept by workspace id; billing knows workspaces by slug. The slug
-- is noted whenever the service looks a workspace up, with the plan billing
-- last said it is on (NULL before it has: held to the budget like a free
-- one) and the month's tokens last reported.
CREATE TABLE workspace_billing (
  workspace_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  -- 'free' or 'paid'.
  plan TEXT,
  plan_at TEXT,
  noted_month TEXT,
  noted_tokens INTEGER NOT NULL DEFAULT 0,
  noted_at TEXT
);
