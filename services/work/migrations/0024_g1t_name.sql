-- g1t's agent is shown as g1t, the name g1t itself goes by, so what it did
-- under its old name, g1t-agent, is renamed here the way a workspace
-- rename moves its rows. Its id, usr_g1t_agent, stays: only the name
-- changes. Docs links (`/guides/g1t-agents/`) inside text are kept.

-- Whoever it is shown as, wherever an author's name is stored.
UPDATE issues SET author_name = 'g1t' WHERE author_name = 'g1t-agent' OR author_id = 'usr_g1t_agent';
UPDATE pulls SET author_name = 'g1t' WHERE author_name = 'g1t-agent' OR author_id = 'usr_g1t_agent';
UPDATE comments SET author_name = 'g1t' WHERE author_name = 'g1t-agent' OR author_id = 'usr_g1t_agent';
UPDATE plans SET author_name = 'g1t' WHERE author_name = 'g1t-agent' OR author_id = 'usr_g1t_agent';
UPDATE agent_messages SET author_name = 'g1t' WHERE author_name = 'g1t-agent' OR author_id = 'usr_g1t_agent';

-- Which agent made a pull request or ran: `made_by_g1t` reads `pulls.agent`.
UPDATE pulls SET agent = 'g1t' WHERE agent = 'g1t-agent';
UPDATE agent_runs SET agent = 'g1t' WHERE agent = 'g1t-agent';
UPDATE agent_runs SET started_by = 'g1t' WHERE started_by = 'g1t-agent';
UPDATE pulls SET merged_by = 'g1t' WHERE merged_by = 'g1t-agent';
UPDATE queue_entries SET enqueued_by = 'g1t' WHERE enqueued_by = 'g1t-agent';
UPDATE memories SET created_by = 'g1t' WHERE created_by = 'g1t-agent';
UPDATE memories SET reviewed_by = 'g1t' WHERE reviewed_by = 'g1t-agent';

-- JSON arrays of usernames: g1t among the reviewers is its review asked for.
UPDATE pulls SET reviewers = replace(reviewers, '"g1t-agent"', '"g1t"') WHERE reviewers LIKE '%"g1t-agent"%';
UPDATE pulls SET assignees = replace(assignees, '"g1t-agent"', '"g1t"') WHERE assignees LIKE '%"g1t-agent"%';
UPDATE issues SET assignees = replace(assignees, '"g1t-agent"', '"g1t"') WHERE assignees LIKE '%"g1t-agent"%';
UPDATE issues SET labels = replace(labels, '"g1t-agent"', '"g1t"') WHERE labels LIKE '%"g1t-agent"%';

-- What g1t wrote itself, and the timeline's events ("sent g1t-agent back
-- to address the review", "assigned this to g1t-agent"). People's own
-- comments are theirs and stay as they wrote them. char(1) holds the docs
-- links' place while the name is replaced.
UPDATE comments
SET body = replace(replace(replace(body, 'g1t-agents/', char(1)), 'g1t-agent', 'g1t'), char(1), 'g1t-agents/')
WHERE body LIKE '%g1t-agent%'
  AND (kind = 'event' OR author_id IN ('usr_g1t_agent', 'g1t', 'g1t_policy', 'svc_runner', 'g1t_runner'));
UPDATE agent_messages
SET body = replace(replace(replace(body, 'g1t-agents/', char(1)), 'g1t-agent', 'g1t'), char(1), 'g1t-agents/')
WHERE body LIKE '%g1t-agent%' AND author_id = 'usr_g1t_agent';
UPDATE pulls SET stage_detail = replace(stage_detail, 'g1t-agent', 'g1t') WHERE stage_detail LIKE '%g1t-agent%';
