-- A g1t agent's token: it acts as g1t-agent, in one repository, and can do
-- only the operations listed. JSON { repo: { namespace, name }, operations }.
ALTER TABLE access_tokens ADD COLUMN agent_scope TEXT;
