-- g1t's agent is shown as g1t, the name g1t itself goes by. Like a
-- workspace rename, this is one of the few changes made to logged rows:
-- what the agent did under its old name, g1t-agent, is shown under the
-- new one, and filtering the audit log by agent g1t finds all of it.
UPDATE audit_entries SET actor = 'g1t' WHERE actor = 'g1t-agent';
UPDATE audit_entries SET agent = 'g1t' WHERE agent = 'g1t-agent';
UPDATE audit_entries SET on_behalf_of = 'g1t' WHERE on_behalf_of = 'g1t-agent';
UPDATE events SET actor = 'g1t' WHERE actor = 'g1t-agent';
UPDATE events SET data = replace(data, '"g1t-agent"', '"g1t"') WHERE data LIKE '%"g1t-agent"%';
