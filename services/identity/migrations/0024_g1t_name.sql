-- g1t's agent is shown as g1t. A run credential made before names its
-- agent g1t-agent in its scope's JSON (`"agent":"g1t-agent"`), which the
-- token's principal carries; renamed so a run still going says g1t too.
UPDATE access_tokens
SET agent_scope = replace(agent_scope, '"g1t-agent"', '"g1t"')
WHERE agent_scope LIKE '%"g1t-agent"%';
