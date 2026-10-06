-- g1t's agent is shown as g1t, the name g1t itself goes by: what it did
-- under its old name, g1t-agent, is shown under the new one.
UPDATE alert_activity SET actor = 'g1t' WHERE actor = 'g1t-agent';
UPDATE vulnerabilities SET dismissed_by = 'g1t' WHERE dismissed_by = 'g1t-agent';
